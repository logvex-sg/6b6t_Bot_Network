/**
 * Kit definitions, cooldowns and stock maths for the kit bot.
 *
 * Pure logic only — no mineflayer types — so every rule here is unit-testable. The runtime in
 * `runtime.ts` turns a `KitPlan` into real `toss` calls.
 */

export interface KitItem {
  /** Minecraft item name, e.g. `diamond_sword`, `cooked_beef`. */
  item: string;
  count: number;
}

export interface KitDefinition {
  /** Kit name as typed by players (`!kit pvp`). The default kit uses `default`. */
  name: string;
  items: KitItem[];
  /** Optional per-kit cooldown override, ms. */
  cooldownMs?: number;
}

export interface KitBotConfig {
  /** Chat prefix a player must type, e.g. `!`. */
  prefix: string;
  /** Name of the kit handed out when a player types just the prefix+`kit`. */
  defaultKit: string;
  kits: KitDefinition[];
  /** Per-player cooldown between kits, ms. */
  cooldownMs: number;
  /** Max players served per rolling minute across the whole bot. */
  maxServesPerMinute: number;
  /** Only serve players within this many blocks (0 disables the proximity check). */
  maxDistance: number;
  /** If true, the bot announces in chat when it hands a kit out. */
  announce: boolean;
  /** If true, the bot walks to the player before dropping. */
  walkToPlayer: boolean;
  /** Don't hand out a kit if it would leave the bot below this many free inventory slots. */
  minFreeSlots: number;
  /** Players that are never served. */
  blacklist: string[];
}

export const DEFAULT_KITBOT_CONFIG: KitBotConfig = {
  prefix: "!",
  defaultKit: "default",
  kits: [
    {
      name: "default",
      items: [
        { item: "stone_sword", count: 1 },
        { item: "bread", count: 8 },
      ],
    },
  ],
  cooldownMs: 300_000,
  maxServesPerMinute: 6,
  maxDistance: 24,
  announce: true,
  walkToPlayer: false,
  minFreeSlots: 1,
  blacklist: [],
};

/** An item the bot has enough of to hand out. */
export interface StockLine {
  item: string;
  /** How many the bot is carrying in total. */
  available: number;
  /** How many the kit wants. */
  wanted: number;
  /** How many will actually be handed out (<= wanted). */
  give: number;
}

export interface KitPlan {
  kit: string;
  /** Items that can be handed out, with the exact counts. */
  lines: StockLine[];
  /** Items the bot could not supply at all (available = 0). */
  missing: StockLine[];
  /** Items that will be short-changed (0 < available < wanted). */
  partial: StockLine[];
}

/**
 * Counts how many of each kit item the bot is carrying.
 * `held` is a map of item name → total count.
 */
export function countStock(held: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, count] of Object.entries(held)) {
    if (!Number.isFinite(count) || count <= 0) continue;
    out[name] = (out[name] ?? 0) + Math.floor(count);
  }
  return out;
}

/**
 * Builds the plan for handing out a kit. `give` is capped at what the bot actually holds, so a partially
 * stocked bot still serves what it can instead of failing outright — but `missing` lists anything it has none
 * of so the caller can warn.
 */
export function planKit(kit: KitDefinition, held: Record<string, number>): KitPlan {
  const stock = countStock(held);
  const lines: StockLine[] = [];
  const missing: StockLine[] = [];
  const partial: StockLine[] = [];

  for (const want of kit.items) {
    const available = stock[want.item] ?? 0;
    const give = Math.min(want.count, available);
    const line: StockLine = { item: want.item, available, wanted: want.count, give };
    if (available <= 0) {
      missing.push(line);
      continue;
    }
    lines.push(line);
    if (available < want.count) partial.push(line);
  }

  return { kit: kit.name, lines, missing, partial };
}

/** True when the plan can hand out at least one item. */
export function planIsServiceable(plan: KitPlan): boolean {
  return plan.lines.some((line) => line.give > 0);
}

export function findKit(config: KitBotConfig, name: string): KitDefinition | null {
  const wanted = String(name ?? "").trim().toLowerCase();
  return config.kits.find((k) => k.name.toLowerCase() === wanted) ?? null;
}

/** Effective cooldown for a kit, falling back to the global cooldown. */
export function cooldownFor(config: KitBotConfig, kit: KitDefinition): number {
  const value = kit.cooldownMs ?? config.cooldownMs;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export interface CooldownState {
  /** username (normalised) → epoch ms when they may next be served. */
  nextAt: Record<string, number>;
}

export interface CooldownDecision {
  allowed: boolean;
  /** When not allowed, ms until the player may try again. */
  remainingMs: number;
}

/** Checks whether `username` may be served at `now`. */
export function checkCooldown(
  state: CooldownState,
  username: string,
  cooldownMs: number,
  now: number,
): CooldownDecision {
  if (cooldownMs <= 0) return { allowed: true, remainingMs: 0 };
  const key = username.toLowerCase();
  const nextAt = state.nextAt[key] ?? 0;
  if (now >= nextAt) return { allowed: true, remainingMs: 0 };
  return { allowed: false, remainingMs: nextAt - now };
}

/** Records a serve, returning the new state (does not mutate the input). */
export function recordServe(state: CooldownState, username: string, cooldownMs: number, now: number): CooldownState {
  const key = username.toLowerCase();
  return { nextAt: { ...state.nextAt, [key]: now + Math.max(0, cooldownMs) } };
}

/** Drops expired cooldown entries so the map cannot grow without bound. */
export function pruneCooldowns(state: CooldownState, now: number): CooldownState {
  const nextAt: Record<string, number> = {};
  for (const [key, at] of Object.entries(state.nextAt)) {
    if (at > now) nextAt[key] = at;
  }
  return { nextAt };
}

/**
 * Rolling one-minute rate limiter. Keeps the timestamps of the last serves and reports whether another is
 * allowed. Bounded: never stores more than `maxPerMinute` entries.
 */
export class RateLimiter {
  private readonly stamps: number[] = [];

  constructor(private readonly maxPerMinute: number) {}

  /** Returns true and records the serve when under the limit. */
  tryAcquire(now: number): boolean {
    const windowStart = now - 60_000;
    while (this.stamps.length > 0 && (this.stamps[0] ?? 0) <= windowStart) this.stamps.shift();
    if (this.maxPerMinute > 0 && this.stamps.length >= this.maxPerMinute) return false;
    this.stamps.push(now);
    return true;
  }

  /** Serves recorded inside the current window. */
  count(now: number): number {
    const windowStart = now - 60_000;
    return this.stamps.filter((t) => t > windowStart).length;
  }
}

export interface EligibilityInput {
  username: string;
  selfUsername: string;
  blacklist: string[];
  /** Distance in blocks, or null when unknown. */
  distance: number | null;
  maxDistance: number;
}

export type IneligibleReason = "self" | "blacklisted" | "too-far" | "unknown-player";

export interface Eligibility {
  eligible: boolean;
  reason?: IneligibleReason;
}

/**
 * Decides whether a request should be served at all. The self-check prevents the bot reacting to its own
 * echoed chat, which is the classic kit-bot feedback loop.
 */
export function checkEligibility(input: EligibilityInput): Eligibility {
  const user = normalise(input.username);
  if (!user) return { eligible: false, reason: "unknown-player" };
  if (user === normalise(input.selfUsername)) return { eligible: false, reason: "self" };
  const blocked = new Set(input.blacklist.map(normalise));
  if (blocked.has(user)) return { eligible: false, reason: "blacklisted" };
  if (input.maxDistance > 0) {
    if (input.distance == null) return { eligible: false, reason: "unknown-player" };
    if (input.distance > input.maxDistance) return { eligible: false, reason: "too-far" };
  }
  return { eligible: true };
}

function normalise(name: string): string {
  return String(name ?? "").trim().toLowerCase();
}

/** Human-readable duration, e.g. `4m 12s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}
