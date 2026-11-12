/**
 * Kit bot controller.
 *
 * Listens to chat, recognises `<prefix>kit` requests, and hands a kit out through the runtime. All the
 * guard rails live here: prefix matching, blacklist, proximity, per-player cooldown, a global rolling
 * rate limit, a stock check, and a free-slot check. It never throws out of a chat handler and it never
 * reacts to its own chat (the self-check in `checkEligibility`).
 *
 * The controller holds no reference to a Bot: it goes through the injected `deps` so the whole thing can be
 * unit-tested with a fake bot.
 */

import type { Bot } from "mineflayer";
import {
  DEFAULT_KITBOT_CONFIG,
  RateLimiter,
  checkCooldown,
  checkEligibility,
  cooldownFor,
  findKit,
  formatDuration,
  planIsServiceable,
  planKit,
  pruneCooldowns,
  recordServe,
  type CooldownState,
  type KitBotConfig,
  type KitDefinition,
} from "./kit.ts";
import { parseKitRequest } from "./chatParse.ts";
import { approachPlayer, dropPlan, freeSlots, heldTotals, readHeld, type KitRuntimeDeps } from "./runtime.ts";

export interface KitBotDeps extends KitRuntimeDeps {
  /** Sends a chat line from the bot. */
  chat: (message: string) => void;
  /** Current username of the bot (used for the self-check). */
  selfUsername: () => string;
  /** Called for every notable event so the UI / Discord can mirror it. */
  onEvent?: (event: KitBotEvent) => void;
  now?: () => number;
}

export type KitBotEventKind =
  | "served"
  | "denied-cooldown"
  | "denied-far"
  | "denied-blacklist"
  | "denied-self"
  | "out-of-stock"
  | "inventory-full"
  | "rate-limited"
  | "error";

export interface KitBotEvent {
  kind: KitBotEventKind;
  username: string;
  kit?: string;
  detail?: string;
}

export interface KitBotStatus {
  active: boolean;
  prefix: string;
  defaultKit: string;
  kits: string[];
  servedTotal: number;
  servedLastMinute: number;
  playersOnCooldown: number;
  lastError: string | null;
}

export interface ServeOutcome {
  ok: boolean;
  reason?: KitBotEventKind | "unknown-kit" | "not-connected" | "empty" | "unknown-player";
  message?: string;
  dropped?: number;
}

export class KitBotController {
  private config: KitBotConfig;
  private cooldowns: CooldownState = { nextAt: {} };
  private readonly limiter: RateLimiter;
  private servedTotal = 0;
  private lastError: string | null = null;
  private readonly now: () => number;

  constructor(
    private readonly deps: KitBotDeps,
    config?: Partial<KitBotConfig>,
  ) {
    this.config = mergeConfig(config);
    this.limiter = new RateLimiter(this.config.maxServesPerMinute);
    this.now = deps.now ?? (() => Date.now());
  }

  getConfig(): KitBotConfig {
    return this.config;
  }

  setConfig(patch: Partial<KitBotConfig>): KitBotConfig {
    this.config = mergeConfig({ ...this.config, ...patch });
    return this.config;
  }

  status(): KitBotStatus {
    const now = this.now();
    const active = Object.values(this.cooldowns.nextAt).filter((at) => at > now).length;
    return {
      active: true,
      prefix: this.config.prefix,
      defaultKit: this.config.defaultKit,
      kits: this.config.kits.map((k) => k.name),
      servedTotal: this.servedTotal,
      servedLastMinute: this.limiter.count(now),
      playersOnCooldown: active,
      lastError: this.lastError,
    };
  }

  /**
   * Handles one chat line. Safe to call for every chat message: it returns `null` immediately for anything
   * that is not a kit request. Never throws.
   */
  async handleChat(raw: string): Promise<ServeOutcome | null> {
    let request;
    try {
      request = parseKitRequest(raw, this.config.prefix);
    } catch {
      return null;
    }
    if (!request) return null;

    // `!help` / bare prefix answers with usage rather than a kit.
    if (request.command === "" || request.command === "help") {
      this.replyHelp(request.username);
      return { ok: false, reason: "empty" };
    }
    if (request.command !== "kit") {
      // Unknown sub-command: stay silent so the bot is not chatty in public chat.
      return null;
    }

    try {
      return await this.serve(request.username, request.args[0]);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.emit({ kind: "error", username: request.username, detail: this.lastError });
      return { ok: false, reason: "error", message: this.lastError };
    }
  }

  /** Serves a kit to `username`. Exposed so the CLI / dashboard can hand a kit out on demand. */
  async serve(username: string, kitName?: string): Promise<ServeOutcome> {
    const now = this.now();
    this.cooldowns = pruneCooldowns(this.cooldowns, now);

    let bot: Bot;
    try {
      bot = this.deps.requireBot();
    } catch (error) {
      return { ok: false, reason: "not-connected", message: error instanceof Error ? error.message : "not connected" };
    }

    const eligibility = checkEligibility({
      username,
      selfUsername: this.deps.selfUsername(),
      blacklist: this.config.blacklist,
      distance: this.distanceTo(bot, username),
      maxDistance: this.config.maxDistance,
    });
    if (!eligibility.eligible) {
      // Map the eligibility verdict to the event it should raise. `self` (our own echoed chat) and
      // `unknown-player` (no entity, e.g. a stale name) are both silent denials — we must never react to
      // ourselves, and we should not announce a cooldown that does not exist.
      const reason: ServeOutcome["reason"] =
        eligibility.reason === "too-far"
          ? "denied-far"
          : eligibility.reason === "blacklisted"
            ? "denied-blacklist"
            : eligibility.reason === "self"
              ? "denied-self"
              : "unknown-player";
      if (reason !== "unknown-player") this.emit({ kind: reason, username });
      return { ok: false, reason, message: eligibility.reason };
    }

    const kit = findKit(this.config, kitName ?? this.config.defaultKit);
    if (!kit) {
      return { ok: false, reason: "unknown-kit", message: `no such kit: ${kitName}` };
    }

    const cooldown = cooldownFor(this.config, kit);
    const cd = checkCooldown(this.cooldowns, username, cooldown, now);
    if (!cd.allowed) {
      const remaining = formatDuration(cd.remainingMs);
      this.emit({ kind: "denied-cooldown", username, kit: kit.name, detail: remaining });
      if (this.config.announce) this.deps.chat(`${username}, you can get another kit in ${remaining}.`);
      return { ok: false, reason: "denied-cooldown", message: `cooldown ${remaining}` };
    }

    if (!this.limiter.tryAcquire(now)) {
      this.emit({ kind: "rate-limited", username, kit: kit.name });
      return { ok: false, reason: "rate-limited" };
    }

    const plan = planKit(kit, heldTotals(readHeld(bot)));
    if (!planIsServiceable(plan)) {
      this.lastError = "out of stock";
      this.emit({ kind: "out-of-stock", username, kit: kit.name });
      if (this.config.announce) this.deps.chat(`${username}, the bot is out of stock right now.`);
      return { ok: false, reason: "out-of-stock" };
    }

    if (freeSlots(bot) < this.config.minFreeSlots) {
      this.emit({ kind: "inventory-full", username, kit: kit.name });
      if (this.config.announce) this.deps.chat(`${username}, the bot's inventory is full.`);
      return { ok: false, reason: "inventory-full" };
    }

    if (this.config.walkToPlayer) {
      await approachPlayer(bot, username).catch(() => false);
    }

    const results = await dropPlan(this.deps, plan);
    const dropped = results.reduce((sum, r) => sum + r.dropped, 0);
    if (dropped <= 0) {
      this.lastError = "drop failed";
      this.emit({ kind: "error", username, kit: kit.name, detail: "no items dropped" });
      return { ok: false, reason: "out-of-stock" };
    }

    this.cooldowns = recordServe(this.cooldowns, username, cooldown, now);
    this.servedTotal++;
    this.lastError = null;
    this.emit({ kind: "served", username, kit: kit.name, detail: `${dropped} items` });

    if (this.config.announce) {
      const summary = results
        .filter((r) => r.dropped > 0)
        .map((r) => `${r.dropped}x ${r.item}`)
        .join(", ");
      this.deps.chat(`${username}, here is your ${kit.name} kit: ${summary}`);
    }

    return { ok: true, dropped };
  }

  /** How far away a player is, or null when the bot has no entity for them. */
  private distanceTo(bot: Bot, username: string): number | null {
    const self = bot?.entity?.position;
    const target = bot?.players?.[username]?.entity?.position;
    if (!self || !target) return null;
    const dx = self.x - target.x;
    const dy = self.y - target.y;
    const dz = self.z - target.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** Number of kits that can still be handed out for the default kit. */
  stockSummary(kitName?: string): string {
    let bot: Bot;
    try {
      bot = this.deps.requireBot();
    } catch {
      return "not connected";
    }
    const kit = findKit(this.config, kitName ?? this.config.defaultKit);
    if (!kit) return `no such kit: ${kitName}`;
    const plan = planKit(kit, heldTotals(readHeld(bot)));
    const parts = plan.lines.map((l) => `${l.item} ${l.available}/${l.wanted}`);
    if (plan.missing.length > 0) parts.push(`MISSING: ${plan.missing.map((l) => l.item).join(", ")}`);
    return parts.join(", ") || "kit has no items";
  }

  /** Clears all cooldowns (an admin reset). */
  resetCooldowns(): void {
    this.cooldowns = { nextAt: {} };
  }

  private replyHelp(username: string): void {
    if (!this.config.announce) return;
    const names = this.config.kits.map((k) => k.name).join(", ");
    this.deps.chat(`${username}, type ${this.config.prefix}kit to get a kit. Available: ${names}`);
  }

  private emit(event: KitBotEvent): void {
    try {
      this.deps.onEvent?.(event);
    } catch {
      /* never let a listener break the serve path */
    }
  }
}

function mergeConfig(config?: Partial<KitBotConfig>): KitBotConfig {
  const base = { ...DEFAULT_KITBOT_CONFIG, ...(config ?? {}) };
  // A config with an empty kit list is useless — fall back to the built-in default kit.
  if (!Array.isArray(base.kits) || base.kits.length === 0) base.kits = DEFAULT_KITBOT_CONFIG.kits;
  if (!base.prefix) base.prefix = DEFAULT_KITBOT_CONFIG.prefix;
  return base;
}

export type { KitDefinition };
