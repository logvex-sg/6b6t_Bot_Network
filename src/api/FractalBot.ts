import { EventEmitter } from "node:events";
import path from "node:path";
import os from "node:os";
import mineflayer, { type Bot } from "mineflayer";
import { goals, pathfinder } from "../minecraft/pathfinder.ts";
import type { FractalConfig } from "../config.ts";
import { log } from "../logger.ts";
import { authCacheDir, ensureSettingsLayout, settingsDir } from "../settings/store.ts";
import { attachAnarchyMod } from "../minecraft/anarchyMod.ts";
import { attachAuth, type AuthController } from "../minecraft/auth.ts";
import { attachProtocolCompat, patchPrismarineChatBigInt } from "../minecraft/protocolCompat.ts";
import { attachVelocityTransfer } from "../minecraft/velocityTransfer.ts";
import { sendCommand } from "../minecraft/command.ts";
import {
  attachServerListener,
  detachServerListener,
  defaultServerListenerPath,
} from "../minecraft/serverListener.ts";
import { loadHomes, saveHomes } from "../settings/homesStore.ts";
import { parseKick, kickReconnectBucket, type KickKind } from "../minecraft/kick.ts";
import { redactSecrets } from "./security.ts";
import { createPortalNavigator, type PortalNavigator } from "../minecraft/lobby/navigator.ts";
import { classifyWorld, isLobbyLike, isMainWorld } from "../minecraft/lobby/worldKind.ts";
import { dumpWorld, persistDump, topBlockCounts } from "../minecraft/probe.ts";
import { findPortalBlocks } from "../minecraft/lobby/portals.ts";
import { clampVoxelRadius, sampleVoxels, type VoxelQuality } from "../minecraft/voxels.ts";
import { createMapperBridge, type MapperHost, type MapperStatus } from "../mapper/bridge.ts";
import { HuntController, type HuntConfig, type HuntStatus } from "../hunt/controller.ts";
import { HuntDatabase } from "../hunt/database.ts";
import { NotificationCenter } from "../hunt/notifications.ts";
import { equipBestElytra, readElytraStatus } from "../hunt/elytraRuntime.ts";
import { readMendingCandidates, selectMendingTarget } from "../hunt/mendingRuntime.ts";
import { readSurvivalSnapshot } from "../hunt/survivalRuntime.ts";
import { findEnderChest, openEnderChest, readOpenContainer, closeEnderChest } from "../hunt/enderChestRuntime.ts";
import { loadHuntConfig, saveHuntConfig } from "../settings/huntConfigStore.ts";
import { KitBotController, type KitBotEvent, type KitBotStatus } from "../kitbot/controller.ts";
import type { KitBotConfig } from "../kitbot/kit.ts";
import { loadKitBotConfig, saveKitBotConfig } from "../settings/kitBotConfigStore.ts";

// Install before any bot connects (chat packets can arrive immediately after login)
try {
  patchPrismarineChatBigInt();
} catch {
  /* ignore */
}

/** Corrupt-chunk / deserializer errors that vanilla clients ignore — stay connected. */
const RECOVERABLE_PARSE_RE =
  /Parse error|array size is abnormally large|Read error for|Chunk size|Deserialization error|PartialReadError|Read error/i;

/** Only reset reconnect backoff after this long on the main world (ms). */
const HEALTHY_STABLE_MS = 90_000;
import {
  controlSnapshot,
  cursorBlock,
  cursorEntity,
  faceVector,
  listEntities,
  resolveBlock,
  snapshotBlockAt,
} from "../minecraft/view.ts";
import type {
  BotErrorInfo,
  BotErrorSource,
  BotPhase,
  BotStatus,
  BlockInfo,
  ControlState,
  DetectionEvent,
  EntityInfo,
  EquipmentDest,
  InventorySlot,
  InventoryView,
  InvCommand,
  JoinOptions,
  FractalBotEvents,
  LookInfo,
  PlaceFace,
  PlayerInfo,
  Surroundings,
  Vec3Like,
  VoxelField,
  WorldDump,
  WorldKind,
} from "./types.ts";

export class FractalBot extends EventEmitter {
  private bot: Bot | null = null;
  private auth: AuthController | null = null;
  private navigator: PortalNavigator | null = null;
  private phase: BotPhase = "idle";
  private worldKind: WorldKind = "unknown";
  private authenticated = false;
  private serverPortalsEntered = 0;
  /** Chat/brand confirmed we reached the playable main backend. */
  private mainConfirmed = false;
  private autoReconnect = true;
  private autoLobby = true;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private lastKick?: string;
  private lastKickKind?: KickKind;
  private lastKickHint?: string;
  private hostIndex = 0;
  private lastKickLinks: string[] = [];
  private lastVerificationCode?: string;
  private lastMsaCode: import("./types.ts").MsaDeviceCode | null = null;
  private lastError?: BotErrorInfo;
  private faultJoinGeneration = -1;
  private reachedLogin = false;
  private lastChat?: string;
  private lastChatAt = 0;
  /** Recent detection events (players in range, crystals, TNT). */
  private detectionLog: DetectionEvent[] = [];
  /** Entity ids currently tracked as in-range players. */
  private nearbyPlayers = new Map<number, { username: string; enteredAt: number }>();
  /**
   * Username-keyed presence (lower → display name + enter time + live entity ids).
   * Prevents spam when the same player gets a new entity id while still nearby.
   */
  private nearbyNames = new Map<
    string,
    { username: string; enteredAt: number; entityIds: Set<number> }
  >();
  /**
   * Pending leave timers keyed by username(lower). Leave is deferred so brief
   * out-of-range / entity-id churn does not fire leave+enter notifications.
   */
  private pendingPlayerLeaves = new Map<
    string,
    { timer: NodeJS.Timeout; username: string }
  >();
  /** username(lower) → texture URL from tab-list / SkinRestorer properties */
  private playerSkinUrls = new Map<string, string>();
  /** Periodic sweep so teleports / missed entityGone still emit leave events. */
  private detectionRecheckTimer: NodeJS.Timeout | null = null;
  private joinGeneration = 0;
  private leaving = false;
  private password: string;
  private invChain: Promise<unknown> = Promise.resolve();
  private jumpTimer: NodeJS.Timeout | null = null;
  /** Home names learned from chat / GUI / sethome (server tab-complete is unreliable on 6b6t). */
  private knownHomes = new Set<string>();
  /** Last Homes multi_action dialog from show_dialog (6b6t 1.21+). */
  private lastHomesDialog: { title: string; homes: string[] } | null = null;
  private homesWindowWaiter: { resolve: (v: boolean) => void; timer: NodeJS.Timeout } | null = null;
  private tabCompleteTx = 1;
  /** Current reconnect delay (exponential backoff). */
  private reconnectDelayMs: number;
  /** True when a captcha kick told us to stop auto-reconnect entirely. */
  private captchaHalted = false;
  private parseSkipCount = 0;
  private lastParseSkipLoggedAt = 0;
  private healthyResetTimer: NodeJS.Timeout | null = null;
  private mapper: MapperHost;
  /** Base-hunting controller (created lazily, lives as long as this bot). */
  private hunt: HuntController | null = null;
  private huntDb: HuntDatabase | null = null;
  private notify: NotificationCenter | null = null;
  private huntTick: NodeJS.Timeout | null = null;
  /** Wall-clock of the last hunt tick, so the interval cannot pile up. */
  private huntTickBusy = false;
  /** Kit bot controller (created lazily, lives as long as this bot). */
  private kitbot: KitBotController | null = null;
  /** True while the kit bot should react to chat. */
  private kitbotActive = false;
  /** Most recent attacker, used to name a killer on death. */
  private lastAttacker: { username: string; at: number } | null = null;
  /** Last health value seen, so a drop can be attributed to an attacker. */
  private lastHealthSeen = 20;

  constructor(private config: FractalConfig) {
    super();
    this.password = config.password;
    this.reconnectDelayMs = config.reconnectMs;
    this.setMaxListeners(50);
    this.mapper = createMapperBridge({
      getBot: () => this.bot,
      outputDir: config.mapOutputDir,
      mapping: {
        mode: config.mapMode,
        homeName: config.mapHomeName,
        box: config.mapBox,
        boxes: [],
        skipSpawnRegions: true,
        noHomeRadius: 5000,
        homeCooldownSec: 315,
      },
      onRegion: (info) => {
        log.info(`Mapped region written: ${JSON.stringify(info)}`);
        this.emit("status", this.getStatus());
      },
    });
  }

  /**
   * Apply live-safe config after settings were written to .env.
   * Host/port/auth used on next join; Discord/control bind need restart.
   */
  applyRuntimeConfig(next: FractalConfig): void {
    this.config = next;
    this.password = next.password;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs, next.reconnectMaxMs);
    this.mapper.setMappingConfig({
      mode: next.mapMode,
      homeName: next.mapHomeName,
      box: next.mapBox,
      skipSpawnRegions: true,
      noHomeRadius: 5000,
      homeCooldownSec: 315,
    });
    // Live-update detection recheck cadence if a session is already wired
    if (this.bot && this.detectionRecheckTimer) {
      this.restartDetectionRecheck(this.bot, this.joinGeneration);
    }
    // Toggle packet listener without reconnect
    if (this.bot) {
      this.wireServerListener(this.bot);
    } else {
      const key = (next.username || this.config.username || "").toLowerCase();
      if (key) detachServerListener(key);
    }
    this.emit("status", this.getStatus());
  }

  private wireServerListener(bot: Bot): void {
    // File name + listener key use nickname/username — never the profile UUID
    const nick =
      String(this.config.username || bot.username || "")
        .trim() || "unknown";
    const filePath =
      this.config.serverListenerPath?.trim() ||
      defaultServerListenerPath(settingsDir(), nick);
    attachServerListener(bot, {
      enabled: this.config.serverListener === true,
      outbound: this.config.serverListenerOutbound !== false,
      filePath,
      key: nick,
    });
  }

  override on<U extends keyof FractalBotEvents>(event: U, listener: FractalBotEvents[U]): this {
    super.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  get raw(): Bot | null {
    return this.bot;
  }

  getStatus(): BotStatus {
    const bot = this.bot;
    return {
      phase: this.phase,
      connected: Boolean(bot),
      username: this.config.username,
      skinUrl: this.skinFor(this.config.username) || this.skinFor(bot?.username),
      host: this.config.host,
      port: this.config.port,
      version: bot?.version,
      dimension: bot?.game?.dimension,
      worldKind: this.worldKind,
      authenticated: this.authenticated,
      serverPortalsEntered: this.serverPortalsEntered,
      requiredServerPortals: this.config.requiredServerPortals,
      position: bot?.entity?.position ? roundVec(bot.entity.position) : undefined,
      yaw: bot?.entity?.yaw,
      pitch: bot?.entity?.pitch,
      onGround: bot?.entity?.onGround,
      gameMode: bot?.game?.gameMode,
      control: controlSnapshot(bot),
      health: bot?.health,
      food: bot?.food,
      ping: bot?.player?.ping,
      players: bot?.players ? Object.keys(bot.players).length : 0,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      lastKick: this.lastKick,
      lastKickKind: this.lastKickKind,
      lastKickLinks: this.lastKickLinks.length ? this.lastKickLinks : undefined,
      lastVerificationCode: this.lastVerificationCode,
      msaCode: this.lastMsaCode,
      lastKickHint: this.lastKickHint,
      lastError: this.lastError ?? null,
      lastChat: this.lastChat,
      autoReconnect: this.autoReconnect && !this.captchaHalted,
      autoLobby: this.autoLobby,
      huntingPortal: Boolean(this.navigator?.hunting),
      mapping: this.mapper.status(),
      hunt: this.hunt?.status() ?? null,
      kitBot: this.kitbot ? { ...this.kitbot.status(), active: this.kitbotActive } : null,
    };
  }

  startMapping(mode?: string): string {
    if (!this.bot?.entity) return "not connected";
    this.mapper.ensureBotHooks();
    return this.mapper.start(mode || this.config.mapMode);
  }

  stopMapping(): string {
    return this.mapper.stop();
  }

  getMappingStatus(): MapperStatus {
    return this.mapper.status();
  }

  setMappingConfig(partial: Record<string, unknown>): void {
    this.mapper.setMappingConfig(partial);
  }

  // --- Base hunting -------------------------------------------------------------------------------

  /**
   * Lazily create the hunt controller and its per-server database. The database lives under
   * `Settings/hunt/<server>/`, so records are keyed to the server the bot is pointed at.
   */
  private huntController(): HuntController {
    if (this.hunt) return this.hunt;
    const server = `${this.config.host}:${this.config.port}`;
    this.huntDb = new HuntDatabase({ dir: settingsDir(), server, maxPlayerAgeDays: 90 });
    this.hunt = new HuntController({
      getBot: () => this.bot,
      database: this.huntDb,
      notifications: this.huntNotifications(),
      server,
      config: loadHuntConfig(server),
    });
    return this.hunt;
  }

  /** The hunt notification sink, shared by the controller and the direct runtime commands. */
  private huntNotifications(): NotificationCenter {
    if (!this.notify) {
      this.notify = new NotificationCenter({
        sink: (n) => {
          log.info(`[hunt:${n.kind}] ${n.title} — ${n.body}`);
          this.emit("huntNotification", n);
        },
      });
    }
    return this.notify;
  }

  /**
   * Send a test notification through the same Discord/webhook path as a real alert, so the operator can
   * confirm delivery is configured. Reports the outcome rather than assuming success.
   */
  webhookTest(): string {
    const sent = this.huntNotifications().notify(
      "system-error",
      "Base Hunting Client — webhook test",
      "If you can read this, hunt notifications reach this channel.",
      { kind: "test" },
    );
    return sent ? "test notification sent (check the webhook channel)" : "test notification suppressed (disabled or cooling down)";
  }

  /**
   * Start base hunting. Stops the terrain mapper first: both drive elytra flight, so only one flight
   * controller may be active at a time. Returns a human-readable result.
   */
  startHunt(config?: Partial<HuntConfig>): string {
    if (!this.bot?.entity) return "not connected";
    if (this.mapper.isActive()) {
      try {
        this.mapper.stop();
      } catch {
        /* ignore */
      }
    }
    const controller = this.huntController();
    if (config) controller.setConfig(config);
    controller.start();
    this.startHuntTicker();
    this.emit("status", this.getStatus());
    return `base hunting started (${controller.status().mode})`;
  }

  stopHunt(): string {
    if (!this.hunt) return "hunt not running";
    this.hunt.stop();
    this.stopHuntTicker();
    this.emit("status", this.getStatus());
    return "base hunting stopped";
  }

  pauseHunt(): string {
    if (!this.hunt?.running) return "hunt not running";
    this.hunt.pause();
    return "base hunting paused";
  }

  resumeHunt(): string {
    if (!this.hunt?.running) return "hunt not running";
    this.hunt.resume();
    return "base hunting resumed";
  }

  huntStatus(): HuntStatus | null {
    return this.hunt?.status() ?? null;
  }

  huntDatabase(): HuntDatabase | null {
    return this.huntDb;
  }

  /** Restock from the nearest ender chest using the configured categories. */
  async huntRestock(): Promise<string> {
    if (!this.hunt) return "hunt not running";
    return this.hunt.restock();
  }

  setHuntConfig(partial: Partial<HuntConfig>): void {
    this.huntController().setConfig(partial);
    saveHuntConfig(`${this.config.host}:${this.config.port}`, this.huntController().getConfig());
  }

  /** The current hunt configuration (mode, spacing, thresholds, categories, …). */
  huntConfig(): HuntConfig {
    return this.huntController().getConfig();
  }

  /** Replace the custom waypoint route (chunk coordinates) and switch to `waypoints` mode. */
  setHuntRoute(waypoints: Array<{ x: number; z: number }>): number {
    const count = this.huntController().setWaypoints(waypoints);
    saveHuntConfig(`${this.config.host}:${this.config.port}`, this.huntController().getConfig());
    return count;
  }

  /** The current custom waypoint route (chunk coordinates). */
  huntRoute(): Array<{ x: number; z: number }> {
    return this.huntController().getWaypoints();
  }

  // --- Kit bot ------------------------------------------------------------------------------------

  /**
   * Lazily create the kit-bot controller. It reads the per-server config from `Settings/kitbot/<server>/`
   * and routes every hand-out through normal `toss` calls.
   */
  private kitbotController(): KitBotController {
    if (this.kitbot) return this.kitbot;
    const server = `${this.config.host}:${this.config.port}`;
    this.kitbot = new KitBotController(
      {
        requireBot: () => this.requireBot(),
        chat: (message) => {
          try {
            this.bot?.chat(message);
          } catch {
            /* ignore */
          }
        },
        selfUsername: () => this.getStatus().username || this.config.username || "",
        onEvent: (event) => this.onKitBotEvent(event),
      },
      loadKitBotConfig(server),
    );
    return this.kitbot;
  }

  private onKitBotEvent(event: KitBotEvent): void {
    if (event.kind === "served") {
      log.info(`[kitbot] served ${event.kit} to ${event.username} (${event.detail ?? ""})`);
    } else if (event.kind === "out-of-stock" || event.kind === "inventory-full") {
      log.warn(`[kitbot] ${event.kind} for ${event.username}`);
    }
    this.emit("kitBotEvent", event);
  }

  /** Start serving kits. */
  startKitBot(config?: Partial<KitBotConfig>): string {
    if (!this.bot?.entity) return "not connected";
    const controller = this.kitbotController();
    if (config) {
      controller.setConfig(config);
      this.persistKitBotConfig();
    }
    this.kitbotActive = true;
    this.emit("status", this.getStatus());
    return `kit bot active — players type "${controller.getConfig().prefix}kit"`;
  }

  stopKitBot(): string {
    if (!this.kitbotActive) return "kit bot not running";
    this.kitbotActive = false;
    this.emit("status", this.getStatus());
    return "kit bot stopped";
  }

  kitBotStatus(): KitBotStatus | null {
    return this.kitbot?.status() ?? null;
  }

  isKitBotActive(): boolean {
    return this.kitbotActive;
  }

  kitBotConfig(): KitBotConfig {
    return this.kitbotController().getConfig();
  }

  setKitBotConfig(patch: Partial<KitBotConfig>): KitBotConfig {
    const config = this.kitbotController().setConfig(patch);
    this.persistKitBotConfig();
    return config;
  }

  private persistKitBotConfig(): void {
    saveKitBotConfig(`${this.config.host}:${this.config.port}`, this.kitbotController().getConfig());
  }

  /** Hand a kit to `username` on demand (CLI / dashboard / Discord). */
  async serveKit(username: string, kitName?: string): Promise<string> {
    const controller = this.kitbotController();
    const outcome = await controller.serve(username, kitName);
    if (outcome.ok) return `served ${kitName ?? controller.getConfig().defaultKit} to ${username} (${outcome.dropped} items)`;
    return `could not serve ${username}: ${outcome.message ?? outcome.reason ?? "unknown reason"}`;
  }

  /** What the bot is currently carrying for the default kit (or a named one). */
  kitBotStock(kitName?: string): string {
    return this.kitbotController().stockSummary(kitName);
  }

  /** Clears all per-player kit cooldowns. */
  resetKitBotCooldowns(): string {
    this.kitbotController().resetCooldowns();
    return "kit cooldowns cleared";
  }

  /**
   * Feeds a chat line to the kit bot. Called from the chat event; returns immediately when the bot is not
   * active so an idle kit bot costs nothing.
   */
  private handleKitBotChat(raw: string): void {
    if (!this.kitbotActive || !this.kitbot) return;
    void this.kitbot.handleChat(raw).catch((error) => {
      log.warn("[kitbot] chat handler failed", { err: error instanceof Error ? error.message : error });
    });
  }

  /** Live elytra status for the currently equipped elytra and the best spare. */
  elytraStatus(): { equipped: boolean; remaining: number; spares: number; bestSpareRemaining: number } | null {
    if (!this.bot) return null;
    const s = readElytraStatus(this.bot);
    return {
      equipped: s.equipped,
      remaining: s.remaining,
      spares: s.spares,
      bestSpareRemaining: s.bestSpareRemaining,
    };
  }

  /** Equip the healthiest viable spare elytra. Returns a human-readable result. */
  async replaceElytra(minimum = 16): Promise<string> {
    if (!this.bot) return "not connected";
    const remaining = await equipBestElytra(this.bot, minimum);
    return remaining >= 0
      ? `equipped elytra with ${remaining} durability remaining`
      : "no viable spare elytra found in inventory";
  }

  /** Items with the Mending enchantment and their remaining durability, most in need first. */
  mendingStatus(): Array<{ slot: number; name: string; remaining: number; maxDamage: number }> {
    if (!this.bot) return [];
    return readMendingCandidates(this.bot).map((c) => ({
      slot: c.slot,
      name: c.name,
      remaining: c.remaining,
      maxDamage: c.maxDamage,
    }));
  }

  /** The highest-priority damaged Mending item, or `null` when nothing needs repair. */
  mendingTarget(): { slot: number; name: string; remaining: number; maxDamage: number; mustHold: boolean } | null {
    if (!this.bot) return null;
    const t = selectMendingTarget(this.bot);
    return t
      ? {
          slot: t.candidate.slot,
          name: t.candidate.name,
          remaining: t.candidate.remaining,
          maxDamage: t.candidate.maxDamage,
          mustHold: t.mustHold,
        }
      : null;
  }

  /** Health, hunger, armour, totems, food, fireworks and inventory capacity. */
  survivalStatus(): ReturnType<typeof readSurvivalSnapshot> {
    if (!this.bot) return null;
    return readSurvivalSnapshot(this.bot);
  }

  /** Locate an ender chest in the loaded surroundings without opening it. */
  findEnderChest(radius = 48): { x: number; y: number; z: number; distance: number } | null {
    if (!this.bot) return null;
    const loc = findEnderChest(this.bot, radius);
    if (!loc) return null;
    return { x: loc.x, y: loc.y, z: loc.z, distance: loc.distance };
  }

  /**
   * Open the nearest ender chest and read its contents, then close it. Never fabricates success: when no
   * ender chest can be reached the reason is returned.
   */
  async echestStatus(radius = 48): Promise<{ ok: boolean; result: string; items?: number; categories?: number }> {
    if (!this.bot) return { ok: false, result: "not connected" };
    const loc = findEnderChest(this.bot, radius);
    if (!loc) return { ok: false, result: `no ender chest within ${radius} blocks of the loaded area` };
    const block = await openEnderChest(this.bot, loc);
    if (!block) return { ok: false, result: "failed to open the ender chest (out of reach or blocked)" };
    try {
      const contents = readOpenContainer(this.bot);
      if (!contents) return { ok: false, result: "opened but could not read the window contents" };
      const names = new Set(contents.slots.map((s) => s.name).filter(Boolean));
      return { ok: true, result: `read ${contents.slots.length} slots`, items: contents.slots.length, categories: names.size };
    } finally {
      closeEnderChest(this.bot);
    }
  }

  private startHuntTicker(): void {
    if (this.huntTick) return;
    // 4 Hz: frequent enough to steer, cheap enough not to load the event loop.
    this.huntTick = setInterval(() => {
      if (this.huntTickBusy) return;
      this.huntTickBusy = true;
      try {
        this.hunt?.tick();
      } finally {
        this.huntTickBusy = false;
      }
    }, 250);
    this.huntTick.unref?.();
  }

  private stopHuntTicker(): void {
    if (this.huntTick) {
      clearInterval(this.huntTick);
      this.huntTick = null;
    }
  }

  async join(options: JoinOptions = {}): Promise<void> {
    if (options.host) this.config.host = options.host;
    if (options.port) this.config.port = options.port;
    if (options.username) this.config.username = options.username;
    if (options.password) {
      this.password = options.password;
      this.config.password = options.password;
    }
    if (options.version) this.config.version = options.version;
    if (options.autoReconnect !== undefined) this.autoReconnect = options.autoReconnect;
    if (options.autoLobby !== undefined) this.autoLobby = options.autoLobby;

    this.leaving = false;
    this.captchaHalted = false;
    this.reconnectDelayMs = this.config.reconnectMs;
    this.clearReconnect();
    await this.disconnectInternal("rejoin");
    this.connect();
  }

  async leave(reason = "leave"): Promise<void> {
    this.leaving = true;
    this.autoReconnect = false;
    this.clearReconnect();
    await this.disconnectInternal(reason);
    this.setPhase("idle");
  }

  async reconnect(): Promise<void> {
    this.leaving = false;
    await this.join();
  }

  chat(message: string): void {
    this.requireBot().chat(message);
  }

  runCommand(command: string): void {
    sendCommand(this.requireBot(), command);
  }

  goto(x: number, y: number, z: number, range = 1): void {
    const bot = this.requireBot();
    bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range));
  }

  async lookAt(x: number, y: number, z: number): Promise<void> {
    const bot = this.requireBot();
    const { Vec3 } = await import("vec3");
    await bot.lookAt(new Vec3(x, y, z));
  }

  async look(opts: { yaw?: number; pitch?: number; x?: number; y?: number; z?: number; force?: boolean }): Promise<LookInfo> {
    if ([opts.x, opts.y, opts.z].every((n) => typeof n === "number" && Number.isFinite(n))) {
      await this.lookAt(opts.x as number, opts.y as number, opts.z as number);
      return this.getLook();
    }
    const bot = this.requireBot();
    const yaw = opts.yaw ?? bot.entity?.yaw ?? 0;
    const pitch = opts.pitch ?? bot.entity?.pitch ?? 0;
    await bot.look(yaw, pitch, opts.force !== false);
    return this.getLook();
  }

  async turn(yaw = 0, pitch = 0): Promise<LookInfo> {
    const bot = this.requireBot();
    await bot.look((bot.entity?.yaw ?? 0) + yaw, (bot.entity?.pitch ?? 0) + pitch, true);
    return this.getLook();
  }

  getLook(): LookInfo {
    const bot = this.requireBot();
    return {
      yaw: bot.entity?.yaw ?? 0,
      pitch: bot.entity?.pitch ?? 0,
      target: cursorBlock(bot),
      entity: cursorEntity(bot),
    };
  }

  jump(): void {
    const bot = this.requireBot();
    bot.setControlState("jump", true);
    if (this.jumpTimer) clearTimeout(this.jumpTimer);
    this.jumpTimer = setTimeout(() => {
      this.jumpTimer = null;
      try {
        this.bot?.setControlState("jump", false);
      } catch {
        // disconnected
      }
    }, 280);
  }

  attack(username?: string): void {
    const bot = this.requireBot();
    let target = username ? bot.players[username]?.entity : bot.entityAtCursor(6);
    if (!target && !username) {
      target = bot.nearestEntity((entity) => entity !== bot.entity && Boolean(entity.position));
    }
    if (!target) throw new Error(username ? `no entity for ${username}` : "no entity in reach");
    bot.attack(target);
  }

  async dig(x?: number, y?: number, z?: number): Promise<BlockInfo> {
    const bot = this.requireBot();
    const block = resolveBlock(bot, x, y, z);
    if (!block || block.name === "air" || block.name === "cave_air") throw new Error("no block to dig");
    await bot.dig(block);
    const p = block.position;
    return { x: p.x, y: p.y, z: p.z, name: block.name };
  }

  stopDig(): void {
    this.requireBot().stopDigging();
  }

  async place(x?: number, y?: number, z?: number, face: PlaceFace = "up"): Promise<void> {
    const bot = this.requireBot();
    const block = resolveBlock(bot, x, y, z);
    if (!block) throw new Error("no block to place against");
    await bot.placeBlock(block, faceVector(face));
  }

  async activate(x?: number, y?: number, z?: number): Promise<void> {
    const bot = this.requireBot();
    const block = resolveBlock(bot, x, y, z);
    if (!block) throw new Error("no block to activate");
    await bot.activateBlock(block);
  }

  swing(): void {
    this.requireBot().swingArm(undefined, true);
  }

  respawn(): void {
    this.requireBot().respawn();
  }

  getBlock(x: number, y: number, z: number): BlockInfo {
    return snapshotBlockAt(this.requireBot(), x, y, z);
  }

  getEntities(): EntityInfo[] {
    return listEntities(this.requireBot());
  }

  getMap(radius = 24): string {
    const r = Math.min(48, Math.max(8, Math.round(radius)));
    return dumpWorld(this.requireBot(), this.worldKind, { mapRadius: r }).asciiMap;
  }

  getView(radius?: number, includeMap = false): Surroundings {
    const bot = this.requireBot();
    const pos = bot.entity?.position;
    return {
      at: new Date().toISOString(),
      status: this.getStatus(),
      look: this.getLook(),
      held: this.getInventory().held,
      players: this.getPlayers()
        .filter((player) => player.position)
        .sort((a, b) => (a.distance ?? 9e9) - (b.distance ?? 9e9))
        .slice(0, 40),
      entities: listEntities(bot),
      portals: pos ? findPortalBlocks(bot, 48) : [],
      voxels: this.getVoxels(radius),
      map: includeMap ? this.getMap(24) : undefined,
    };
  }

  setControl(state: Partial<ControlState>): void {
    const bot = this.requireBot();
    for (const [key, value] of Object.entries(state) as [keyof ControlState, boolean][]) {
      if (typeof value === "boolean") bot.setControlState(key, value);
    }
    // If every movement/stance flag is false, hard-clear so nothing keeps walking/turning
    const anyOn = Object.values(state).some((v) => v === true);
    if (!anyOn) {
      try {
        bot.clearControlStates();
      } catch {
        /* ignore */
      }
    }
  }

  stopMovement(): void {
    const bot = this.bot;
    if (!bot) return;
    bot.clearControlStates();
    try {
      bot.pathfinder?.setGoal(null);
    } catch {}
  }


  /** Decode Mojang-style textures property (also used by SkinRestorer with custom URLs). */
  private static skinUrlFromProperties(properties: unknown): string | undefined {
    if (!Array.isArray(properties)) return undefined;
    const tex = properties.find(
      (p) => p && typeof p === "object" && String((p as { name?: string }).name || "") === "textures",
    ) as { value?: string } | undefined;
    if (!tex?.value || typeof tex.value !== "string") return undefined;
    try {
      const json = JSON.parse(Buffer.from(tex.value, "base64").toString("utf8")) as {
        textures?: { SKIN?: { url?: string } };
      };
      const url = json?.textures?.SKIN?.url;
      if (url && typeof url === "string" && /^https?:\/\//i.test(url)) return url;
    } catch {
      /* ignore */
    }
    return undefined;
  }

  private rememberSkin(username: string | undefined, properties: unknown, uuid?: string): void {
    const name = String(username || "").trim();
    if (!name) return;
    const url = FractalBot.skinUrlFromProperties(properties);
    if (!url) return;
    this.playerSkinUrls.set(name.toLowerCase(), url);
    if (uuid) this.playerSkinUrls.set(String(uuid).toLowerCase(), url);
  }

  private skinFor(username: string | undefined, uuid?: string): string | undefined {
    if (uuid) {
      const byUuid = this.playerSkinUrls.get(String(uuid).toLowerCase());
      if (byUuid) return byUuid;
    }
    if (username) return this.playerSkinUrls.get(String(username).toLowerCase());
    return undefined;
  }

  getPlayers(): PlayerInfo[] {
    const bot = this.requireBot();
    const origin = bot.entity?.position;
    const loaded = bot.entities ?? {};
    const self = (bot.username || "").toLowerCase();
    const players = bot.players
      ? Object.values(bot.players).filter((p) => (p.username || "").toLowerCase() !== self)
      : [];
    return players.map((player) => {
      // Tab list keeps every player on the server. Only attach pose when the
      // entity is still present in bot.entities — otherwise we keep showing
      // last-known coords of people who already left render distance.
      const entity = player.entity;
      const stillLoaded =
        !!entity?.position &&
        entity.id != null &&
        loaded[entity.id] === entity;
      if (entity && !stillLoaded) {
        // Drop the stale reference so later reads stay clean
        try {
          (player as { entity?: unknown }).entity = undefined;
        } catch {
          /* ignore */
        }
      }
      const entityPos = stillLoaded ? entity!.position : undefined;
      return {
        username: player.username,
        uuid: player.uuid,
        skinUrl: this.skinFor(player.username, player.uuid),
        ping: player.ping,
        gamemode: player.gamemode !== undefined ? String(player.gamemode) : undefined,
        distance: origin && entityPos ? origin.distanceTo(entityPos) : undefined,
        position: entityPos ? roundVec(entityPos) : undefined,
        yaw: stillLoaded ? entity!.yaw : undefined,
      };
    });
  }

  /** Detection event ring buffer (players, crystals, TNT). */
  getDetection(): { events: DetectionEvent[]; nearby: Array<{ username: string; enteredAt: number }> } {
    // Opportunistic sync so UI poll fills the log even if an interval tick was missed
    if (this.bot) {
      try {
        this.recheckNearbyPlayers(this.bot);
      } catch {
        /* ignore */
      }
    }
    return {
      events: this.detectionLog.slice(),
      // Deduped by username so entity-id churn does not list the same player twice
      nearby: [...this.nearbyNames.values()].map((p) => ({
        username: p.username,
        enteredAt: p.enteredAt,
        skinUrl: this.skinFor(p.username),
      })),
    };
  }

  /**
   * Wipe the detection event log and re-emit enter for everyone currently in render range.
   * Clears tracking so a Clear from the UI is not stuck with "already tracked" and no new lines.
   */
  clearDetectionLog(): void {
    this.detectionLog.length = 0;
    this.clearPlayerPresence(false);
    const bot = this.bot;
    if (bot) {
      try {
        this.recheckNearbyPlayers(bot);
      } catch {
        /* ignore */
      }
    }
  }

  private pushDetection(event: Omit<DetectionEvent, "at" | "id">): void {
    const full: DetectionEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: new Date().toISOString(),
      ...event,
      worldKind: event.worldKind ?? this.worldKind,
    };
    this.detectionLog.unshift(full);
    if (this.detectionLog.length > 200) this.detectionLog.length = 200;
    this.emit("detection", full);
  }

  /** Cancel all deferred leave timers. */
  private clearPendingPlayerLeaves(): void {
    for (const pending of this.pendingPlayerLeaves.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingPlayerLeaves.clear();
  }

  /**
   * Drop all presence state. When emitLeaves is true, fire player_leave for each
   * unique username still considered nearby (used on portal / dimension hops).
   */
  private clearPlayerPresence(emitLeaves: boolean, reason?: string): void {
    this.clearPendingPlayerLeaves();
    if (emitLeaves && this.nearbyNames.size) {
      for (const entry of this.nearbyNames.values()) {
        this.pushDetection({
          kind: "player_leave",
          label: entry.username,
          username: entry.username,
          skinUrl: this.skinFor(entry.username),
          message: reason
            ? `${entry.username} left range (${reason})`
            : `${entry.username} left range`,
        });
      }
    }
    this.nearbyPlayers.clear();
    this.nearbyNames.clear();
  }

  /**
   * Mark a player entity as in range. Emits player_enter only the first time
   * that username is seen; later entity-id changes are silent updates.
   * Cancels a pending leave if the same name reappears within the grace window.
   */
  private trackPlayerEnter(
    username: string,
    entityId: number,
    opts?: {
      position?: { x: number; y: number; z: number };
      distance?: number;
    },
  ): void {
    if (this.config.detectionPlayers === false) return;
    const key = username.toLowerCase();

    // Cancel deferred leave — player is still / again nearby
    const pending = this.pendingPlayerLeaves.get(key);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingPlayerLeaves.delete(key);
    }

    this.nearbyPlayers.set(entityId, { username, enteredAt: Date.now() });

    const existing = this.nearbyNames.get(key);
    if (existing) {
      existing.entityIds.add(entityId);
      if (existing.username !== username) existing.username = username;
      return; // already nearby by name — no notification
    }

    const enteredAt = Date.now();
    this.nearbyNames.set(key, {
      username,
      enteredAt,
      entityIds: new Set([entityId]),
    });
    // Persist the sighting for the base-hunting player database (server-keyed, de-duplicated).
    if (this.huntDb && this.worldKind === "overworld") {
      try {
        const pos = this.bot?.entity?.position;
        this.huntDb.recordPlayerSighting({
          username,
          x: Math.round(opts?.position?.x ?? pos?.x ?? 0),
          y: Math.round(opts?.position?.y ?? pos?.y ?? 0),
          z: Math.round(opts?.position?.z ?? pos?.z ?? 0),
          dimension: this.bot?.game?.dimension || "overworld",
          atMs: enteredAt,
        });
      } catch {
        /* a sighting record must never break presence tracking */
      }
    }
    this.pushDetection({
      kind: "player_enter",
      label: username,
      username,
      skinUrl: this.skinFor(username),
      message: `${username} entered range${opts?.distance != null ? ` (${opts.distance}m)` : ""}`,
      position: opts?.position,
      distance: opts?.distance,
    });
  }

  /**
   * Entity id left render range. Only schedules player_leave after the grace
   * period, and only if no other entity for that username is still tracked.
   */
  private trackPlayerLeave(entityId: number): void {
    if (this.config.detectionPlayers === false) return;
    const prev = this.nearbyPlayers.get(entityId);
    if (!prev) return;
    this.nearbyPlayers.delete(entityId);

    const key = prev.username.toLowerCase();
    const nameEntry = this.nearbyNames.get(key);
    if (nameEntry) {
      nameEntry.entityIds.delete(entityId);
      if (nameEntry.entityIds.size > 0) return; // still have another live entity
    }

    // Already waiting to leave
    if (this.pendingPlayerLeaves.has(key)) return;

    const username = nameEntry?.username ?? prev.username;
    const grace = Math.max(0, this.config.detectionPlayerLeaveGraceMs ?? 60_000);

    if (grace <= 0) {
      this.nearbyNames.delete(key);
      this.pushDetection({
        kind: "player_leave",
        label: username,
        username,
        skinUrl: this.skinFor(username),
        message: `${username} left range`,
      });
      return;
    }

    // Keep username in nearbyNames during grace so the Nearby list does not flicker
    // when someone stands next to the bot and entity ids churn. Leave event fires
    // only after the grace window if they never reappeared.
    const timer = setTimeout(() => {
      this.pendingPlayerLeaves.delete(key);
      const still = this.nearbyNames.get(key);
      // Re-enter during grace re-added entity ids → still present, skip leave
      if (still && still.entityIds.size > 0) return;
      this.nearbyNames.delete(key);
      for (const [id, info] of [...this.nearbyPlayers.entries()]) {
        if (info.username.toLowerCase() === key) this.nearbyPlayers.delete(id);
      }
      this.pushDetection({
        kind: "player_leave",
        label: username,
        username,
        skinUrl: this.skinFor(username),
        message: `${username} left range`,
      });
    }, grace);

    this.pendingPlayerLeaves.set(key, { timer, username });
  }

  private clearDetectionRecheck(): void {
    if (this.detectionRecheckTimer) {
      clearInterval(this.detectionRecheckTimer);
      this.detectionRecheckTimer = null;
    }
  }

  private restartDetectionRecheck(bot: Bot, generation: number): void {
    this.clearDetectionRecheck();
    const interval = Math.max(500, this.config.detectionRecheckMs || 3_000);
    this.detectionRecheckTimer = setInterval(() => {
      if (generation !== this.joinGeneration || !this.bot) return;
      try {
        this.recheckNearbyPlayers(bot);
      } catch {
        /* ignore */
      }
    }, interval);
  }

  /** Strip legacy § / & / $ color+format codes and whitespace from a name. */
  private static cleanMinecraftName(raw: string): string {
    let s = String(raw || "");
    // §X and unicode section sign, plus $X / &X variants some stacks emit
    s = s.replace(/[\u00A7§][0-9A-FK-ORa-fk-or]/g, "");
    s = s.replace(/[\$&][0-9A-FK-ORa-fk-or]/g, "");
    // JSON-ish leftover fragments
    s = s.replace(/\{(?:text|color|bold|italic|extra)[^}]*\}/gi, "");
    s = s.replace(/\s+/g, " ").trim();
    return s;
  }

  /**
   * True if this looks like a real Java account name (not lobby NPC / hologram junk).
   * 6b usernames are typically 1–16 [A-Za-z0-9_]; allow up to 32 + . -
   */
  private static isPlausiblePlayerName(name: string): boolean {
    if (!name || name.length < 1 || name.length > 32) return false;
    if (/\s/.test(name)) return false; // "Captain Morgan" style NPCs
    if (/^CIT-/i.test(name)) return false;
    if (/^player#/i.test(name)) return false;
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) return false;
    // Reject pure hex garbage from nametag components
    if (/^[0-9a-f]{8,}$/i.test(name)) return false;
    return true;
  }

  /**
   * Resolve a clean tab-list username for a loaded player entity.
   * Returns null for NPCs / holograms / unresolvable entities (skip detection).
   */
  private resolvePlayerUsername(
    bot: Bot,
    entity: { id?: number; username?: string; name?: string; type?: string },
  ): string | null {
    const self = (bot.username || "").toLowerCase();

    // Prefer tab list (always the real account name on 6b)
    try {
      for (const p of Object.values(bot.players || {})) {
        if (p.entity?.id === entity.id && p.username) {
          const cleaned = FractalBot.cleanMinecraftName(p.username);
          if (FractalBot.isPlausiblePlayerName(cleaned) && cleaned.toLowerCase() !== self) {
            return cleaned;
          }
        }
      }
    } catch {
      /* ignore */
    }

    if (entity.username) {
      const cleaned = FractalBot.cleanMinecraftName(entity.username);
      if (FractalBot.isPlausiblePlayerName(cleaned) && cleaned.toLowerCase() !== self) {
        return cleaned;
      }
    }

    // Match tab-list entry by username string if entity id not linked yet
    try {
      const guess = FractalBot.cleanMinecraftName(entity.username || "");
      if (guess) {
        for (const p of Object.values(bot.players || {})) {
          if (p.username && p.username.toLowerCase() === guess.toLowerCase()) {
            const cleaned = FractalBot.cleanMinecraftName(p.username);
            if (FractalBot.isPlausiblePlayerName(cleaned) && cleaned.toLowerCase() !== self) {
              return cleaned;
            }
          }
        }
      }
    } catch {
      /* ignore */
    }

    return null;
  }

  private isPlayerEntity(entity: { type?: string; name?: string; username?: string }): boolean {
    if (entity.type === "player") return true;
    const n = String(entity.name || "").toLowerCase();
    if (n === "player") return true;
    // Some protocol paths only set username
    if (entity.username && entity.type !== "mob" && entity.type !== "object") return true;
    return false;
  }

  /**
   * Sweep tab-list players that still have a loaded entity (same source as Play → Nearby).
   * After teleports / dimension changes, entityGone is often missed — this emits leave/enter to stay in sync.
   * Presence is username-keyed so entity-id churn while a player stands next to the bot does not spam.
   */
  private recheckNearbyPlayers(bot: Bot): void {
    // Default on — only skip when explicitly disabled
    if (this.config.detectionPlayers === false) return;
    const self = (bot.username || "").toLowerCase();
    const origin = bot.entity?.position;
    const loaded = bot.entities || {};
    const seen = new Set<number>();

    for (const player of Object.values(bot.players || {})) {
      const rawName = player?.username ? FractalBot.cleanMinecraftName(String(player.username)) : "";
      if (!rawName || rawName.toLowerCase() === self) continue;
      // Soft filter: allow any non-empty tab name without spaces (matches Nearby panel)
      if (/\s/.test(rawName) || rawName.length > 32) continue;

      const entity = player.entity;
      // Accept entity if it is still referenced in bot.entities (by id), even if object identity drifted
      const byId = entity?.id != null ? loaded[entity.id] : undefined;
      const live = byId && byId.position ? byId : entity?.position ? entity : null;
      if (!live?.position || live.id == null) continue;
      const id = live.id;

      seen.add(id);
      const pos = {
        x: Math.round(live.position.x),
        y: Math.round(live.position.y),
        z: Math.round(live.position.z),
      };
      const dist = origin ? Number(origin.distanceTo(live.position).toFixed(1)) : undefined;
      this.trackPlayerEnter(rawName, id, { position: pos, distance: dist });
    }

    for (const id of [...this.nearbyPlayers.keys()]) {
      if (seen.has(id)) continue;
      this.trackPlayerLeave(id);
    }
  }

  /** Force leave for everyone tracked (dimension / portal hop), then optional reseed. */
  private flushNearbyPlayers(reason: string): void {
    this.clearPlayerPresence(true, reason);
  }


  private wirePlayerSkins(bot: Bot, generation: number): void {
    const client = bot._client;
    if (!client) return;

    const ingest = (entry: Record<string, unknown>) => {
      if (generation !== this.joinGeneration) return;
      // Legacy player_info data[] entries
      const name =
        (entry.player as { name?: string } | undefined)?.name ||
        (entry as { name?: string }).name ||
        (entry as { username?: string }).username;
      const props =
        (entry.player as { properties?: unknown } | undefined)?.properties ||
        (entry as { properties?: unknown }).properties;
      const uuid =
        (entry as { uuid?: string }).uuid ||
        (entry.player as { id?: string; uuid?: string } | undefined)?.id ||
        (entry.player as { uuid?: string } | undefined)?.uuid;
      this.rememberSkin(typeof name === "string" ? name : undefined, props, typeof uuid === "string" ? uuid : undefined);
    };

    const onPlayerInfo = (packet: Record<string, unknown>) => {
      if (generation !== this.joinGeneration) return;
      const data = packet.data;
      if (Array.isArray(data)) {
        for (const entry of data) {
          if (entry && typeof entry === "object") ingest(entry as Record<string, unknown>);
        }
      }
    };

    // Older + some 1.20 builds
    client.on("player_info", onPlayerInfo);
    // Some protocol versions / prismarine builds emit alternate names
    try {
      (client as { on: (e: string, fn: typeof onPlayerInfo) => void }).on("player_info_v2", onPlayerInfo);
    } catch {
      /* ignore */
    }

    // Mineflayer may already have players after login — harvest properties if present
    const harvestExisting = () => {
      if (generation !== this.joinGeneration) return;
      for (const p of Object.values(bot.players || {})) {
        const anyP = p as {
          username?: string;
          uuid?: string;
          textureProperties?: unknown;
          properties?: unknown;
          skinData?: { url?: string };
        };
        if (anyP.skinData?.url && anyP.username) {
          this.playerSkinUrls.set(anyP.username.toLowerCase(), anyP.skinData.url);
          continue;
        }
        this.rememberSkin(anyP.username, anyP.textureProperties || anyP.properties, anyP.uuid);
      }
    };
    setTimeout(harvestExisting, 500);
    setTimeout(harvestExisting, 2500);
  }

  private wireDetection(bot: Bot, generation: number): void {
    this.clearPlayerPresence(false);
    this.clearDetectionRecheck();

    const entityLabel = (entity: { name?: string; displayName?: unknown }): string => {
      const n = String(entity.name || "").toLowerCase();
      if (n) return n;
      try {
        const d = entity.displayName as { toString?: () => string } | string | undefined;
        if (typeof d === "string") return d.toLowerCase();
        if (d && typeof d.toString === "function") return d.toString().toLowerCase();
      } catch {
        /* ignore */
      }
      return "";
    };

    const isCrystal = (name: string) =>
      name.includes("crystal") || name === "ender_crystal" || name === "end_crystal";
    const isTnt = (name: string) =>
      name === "tnt" || name === "primed_tnt" || name.includes("tnt");

    const playerName = (entity: {
      username?: string;
      name?: string;
      id?: number;
      type?: string;
    }): string | null => this.resolvePlayerUsername(bot, entity);

    const notePlayerEnter = (entity: {
      id?: number;
      username?: string;
      name?: string;
      type?: string;
      position?: { x: number; y: number; z: number };
    }) => {
      if (this.config.detectionPlayers === false) return;
      if (entity.id == null) return;
      const username = playerName(entity);
      if (!username) return; // skip NPCs / color-junk / non-tab players
      const pos = entity.position
        ? {
            x: Math.round(entity.position.x),
            y: Math.round(entity.position.y),
            z: Math.round(entity.position.z),
          }
        : undefined;
      const dist =
        bot.entity?.position && entity.position
          ? Number(
              bot.entity.position.distanceTo({
                x: entity.position.x,
                y: entity.position.y,
                z: entity.position.z,
              } as never).toFixed(1),
            )
          : undefined;
      this.trackPlayerEnter(username, entity.id, { position: pos, distance: dist });
    };

    const notePlayerLeave = (entityId: number, fallbackName?: string) => {
      if (this.config.detectionPlayers === false) return;
      this.trackPlayerLeave(entityId);
      void fallbackName;
    };

    bot.on("entitySpawn", (entity) => {
      if (generation !== this.joinGeneration) return;
      try {
        const name = entityLabel(entity);
        if (this.isPlayerEntity(entity)) {
          // Username often arrives a tick after spawn — retry once shortly
          notePlayerEnter(entity);
          if (entity.id != null && !this.nearbyPlayers.has(entity.id)) {
            setTimeout(() => {
              if (generation !== this.joinGeneration) return;
              try {
                notePlayerEnter(entity);
              } catch {
                /* ignore */
              }
            }, 250);
          }
          return;
        }
        if (this.config.detectionCrystals && isCrystal(name)) {
          const pos = entity.position
            ? {
                x: Math.round(entity.position.x),
                y: Math.round(entity.position.y),
                z: Math.round(entity.position.z),
              }
            : undefined;
          const dist =
            bot.entity?.position && entity.position
              ? Number(bot.entity.position.distanceTo(entity.position).toFixed(1))
              : undefined;
          this.pushDetection({
            kind: "crystal_spawn",
            label: name || "crystal",
            message: `Crystal placed/spawned${dist != null ? ` (${dist}m)` : ""}`,
            position: pos,
            distance: dist,
          });
          return;
        }
        if (this.config.detectionTnt && isTnt(name)) {
          const pos = entity.position
            ? {
                x: Math.round(entity.position.x),
                y: Math.round(entity.position.y),
                z: Math.round(entity.position.z),
              }
            : undefined;
          const dist =
            bot.entity?.position && entity.position
              ? Number(bot.entity.position.distanceTo(entity.position).toFixed(1))
              : undefined;
          this.pushDetection({
            kind: "tnt_spawn",
            label: name || "tnt",
            message: `TNT primed/fired${dist != null ? ` (${dist}m)` : ""}`,
            position: pos,
            distance: dist,
          });
        }
      } catch {
        /* ignore detection errors */
      }
    });

    bot.on("entityGone", (entity) => {
      if (generation !== this.joinGeneration) return;
      try {
        const name = entityLabel(entity);
        if (this.nearbyPlayers.has(entity.id) || this.isPlayerEntity(entity)) {
          notePlayerLeave(entity.id, entity.username);
          return;
        }
        if (this.config.detectionCrystals && isCrystal(name)) {
          const pos = entity.position
            ? {
                x: Math.round(entity.position.x),
                y: Math.round(entity.position.y),
                z: Math.round(entity.position.z),
              }
            : undefined;
          this.pushDetection({
            kind: "crystal_gone",
            label: name || "crystal",
            message: "Crystal exploded or despawned",
            position: pos,
          });
          return;
        }
        if (this.config.detectionTnt && isTnt(name)) {
          const pos = entity.position
            ? {
                x: Math.round(entity.position.x),
                y: Math.round(entity.position.y),
                z: Math.round(entity.position.z),
              }
            : undefined;
          this.pushDetection({
            kind: "tnt_gone",
            label: name || "tnt",
            message: "TNT exploded or despawned",
            position: pos,
          });
        }
      } catch {
        /* ignore */
      }
    });

    // Explosion packet (covers crystals/TNT even if entityGone is missed)
    try {
      bot._client?.on?.("explosion", (packet: { x?: number; y?: number; z?: number }) => {
        if (generation !== this.joinGeneration) return;
        if (!this.config.detectionExplosions) return;
        const x = packet?.x;
        const y = packet?.y;
        const z = packet?.z;
        if (![x, y, z].every((n) => typeof n === "number" && Number.isFinite(n))) return;
        const pos = { x: Math.round(x!), y: Math.round(y!), z: Math.round(z!) };
        const dist =
          bot.entity?.position != null
            ? Number(
                Math.hypot(
                  bot.entity.position.x - x!,
                  bot.entity.position.y - y!,
                  bot.entity.position.z - z!,
                ).toFixed(1),
              )
            : undefined;
        this.pushDetection({
          kind: "explosion",
          label: "explosion",
          message: `Explosion${dist != null ? ` (${dist}m)` : ""} @ ${pos.x} ${pos.y} ${pos.z}`,
          position: pos,
          distance: dist,
        });
      });
    } catch {
      /* protocol may differ */
    }

    // —— Combat: who attacked / killed us ——
    this.lastAttacker = null;
    this.lastHealthSeen = typeof bot.health === "number" ? bot.health : 20;

    const findLikelyAttacker = (): {
      username: string;
      distance: number;
      position?: { x: number; y: number; z: number };
    } | null => {
      const origin = bot.entity?.position;
      if (!origin) return null;
      let best: { username: string; distance: number; position?: { x: number; y: number; z: number } } | null =
        null;
      const loaded = bot.entities || {};
      for (const entity of Object.values(loaded)) {
        if (!entity || entity === bot.entity) continue;
        if (!this.isPlayerEntity(entity)) continue;
        if (!entity.position) continue;
        const dist = origin.distanceTo(entity.position);
        if (dist > 12) continue;
        const username = playerName(entity);
        if (!username) continue;
        if (!best || dist < best.distance) {
          best = {
            username,
            distance: Number(dist.toFixed(1)),
            position: {
              x: Math.round(entity.position.x),
              y: Math.round(entity.position.y),
              z: Math.round(entity.position.z),
            },
          };
        }
      }
      return best;
    };

    bot.on("health", () => {
      if (generation !== this.joinGeneration) return;
      if (!this.config.detectionCombat) return;
      try {
        const hp = typeof bot.health === "number" ? bot.health : this.lastHealthSeen;
        const prev = this.lastHealthSeen;
        this.lastHealthSeen = hp;
        if (!(hp < prev - 0.05)) return;

        const attacker = findLikelyAttacker();
        if (!attacker) return;
        this.lastAttacker = { username: attacker.username, at: Date.now() };
        this.pushDetection({
          kind: "attacked",
          label: attacker.username,
          message: `Attacked by ${attacker.username} · HP ${hp.toFixed(1)} (${attacker.distance}m)`,
          position: attacker.position,
          distance: attacker.distance,
        });
      } catch {
        /* ignore */
      }
    });

    bot.on("death", () => {
      if (generation !== this.joinGeneration) return;
      if (!this.config.detectionCombat) return;
      try {
        const recent =
          this.lastAttacker && Date.now() - this.lastAttacker.at < 10_000
            ? this.lastAttacker.username
            : null;
        const near = findLikelyAttacker();
        const killer = recent || near?.username || null;
        if (!killer) return;
        this.pushDetection({
          kind: "death",
          label: killer,
          message: `Killed by ${killer}`,
          position: near?.position,
          distance: near?.distance,
        });
      } catch {
        /* ignore */
      }
    });

    const deathChatRe =
      /\b(?:was (?:slain|shot|killed|blown up|fireballed|pummeled|impaled|frozen to death) by|killed by|slain by)\s+([A-Za-z0-9_]{1,32})\b/i;
    bot.on("messagestr", (message: string) => {
      if (generation !== this.joinGeneration) return;
      if (!this.config.detectionCombat) return;
      try {
        const text = String(message || "");
        const self = bot.username || "";
        if (!self || !text.toLowerCase().includes(self.toLowerCase())) return;
        const m = text.match(deathChatRe);
        if (!m?.[1]) return;
        const killer = m[1];
        if (killer.toLowerCase() === self.toLowerCase()) return;
        this.lastAttacker = { username: killer, at: Date.now() };
        this.pushDetection({
          kind: "death",
          label: killer,
          message: `Killed by ${killer} (chat)`,
        });
      } catch {
        /* ignore */
      }
    });

    // Seed from currently loaded players, then keep in sync on an interval.
    // Tab-list ↔ entity links often appear a few hundred ms after spawn/portal.
    const seed = () => {
      try {
        this.recheckNearbyPlayers(bot);
      } catch {
        /* ignore */
      }
    };
    seed();
    for (const ms of [400, 1200, 3000]) {
      setTimeout(() => {
        if (generation !== this.joinGeneration) return;
        seed();
      }, ms);
    }
    this.restartDetectionRecheck(bot, generation);
  }

  getInventory(): InventoryView {
    const bot = this.requireBot();
    const slots: InventorySlot[] = [];
    for (const item of bot.inventory.slots) {
      if (!item) continue;
      slots.push(snapshotItem(item));
    }
    const quickBarSlot = bot.quickBarSlot ?? 0;
    const heldItem = bot.heldItem;
    const win = bot.currentWindow as
      | {
          id?: number;
          title?: unknown;
          type?: string;
          slots?: Array<{
            slot: number;
            name?: string;
            count?: number;
            displayName?: string;
            customName?: string | null;
            stackSize?: number;
            durabilityUsed?: number;
            maxDurability?: number;
          } | null>;
          inventoryStart?: number;
        }
      | null
      | undefined;
    let windowView: InventoryView["window"] = null;
    if (win && typeof win.id === "number") {
      const invStart = typeof win.inventoryStart === "number" ? win.inventoryStart : 0;
      const containerSlots: InventorySlot[] = [];
      if (Array.isArray(win.slots)) {
        for (const item of win.slots) {
          if (!item || item.slot == null) continue;
          // Only expose container portion; player inv is already in `slots`
          if (invStart > 0 && item.slot >= invStart) continue;
          containerSlots.push(snapshotItem(item as never));
        }
      }
      windowView = {
        id: win.id,
        title: stripWindowTitle(win.title),
        type: win.type,
        slots: containerSlots,
        inventoryStart: invStart,
      };
    }
    return {
      quickBarSlot,
      held: heldItem ? snapshotItem(heldItem) : null,
      slots,
      window: windowView,
      homesDialog: this.lastHomesDialog
        ? { title: this.lastHomesDialog.title, homes: [...this.lastHomesDialog.homes] }
        : null,
      homes: this.getHomes(),
    };
  }

  /** Locally known home names (from /homes dialog, chat, or successful suggestions). */
  getHomes(): string[] {
    return [...this.knownHomes].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }

  rememberHome(name: string): void {
    const n = String(name || "").trim();
    if (!n || n.includes(" ") || n.length > 48) return;
    if (/^(cancel|close|back|exit)$/i.test(n)) return;
    this.knownHomes.add(n);
  }

  forgetHome(name: string): void {
    this.knownHomes.delete(String(name || "").trim());
    this.persistHomes();
  }

  private loadHomesFromDisk(): void {
    const profileId = this.config.profileId || this.config.username;
    if (!profileId) return;
    const list = loadHomes(profileId, this.config.username);
    this.knownHomes = new Set(list);
    if (list.length) log.info(`Loaded ${list.length} home(s) for profile ${profileId}`);
  }

  /** Replace the full home list (e.g. after /homes dialog) and save. */
  replaceHomes(names: string[]): void {
    this.knownHomes = new Set();
    for (const n of names) this.rememberHome(n);
    this.persistHomes();
  }

  private persistHomes(): void {
    const profileId = this.config.profileId || this.config.username;
    if (!profileId) return;
    const saved = saveHomes(profileId, this.getHomes(), this.config.username);
    this.knownHomes = new Set(saved);
  }

  /**
   * Home suggestions from cache, plus a modern tab_complete request (transactionId).
   * Mineflayer's default tabComplete still sends the legacy assumeCommand form which
   * 6b6t ignores — we write the 1.19+ packet ourselves.
   */
  async tabComplete(partial: string): Promise<string[]> {
    const text = String(partial || "").replace(/^\//, "");
    const lower = text.toLowerCase();
    const isHomeCmd = /^(home|delhome|sethome)\b/.test(lower);
    const arg = isHomeCmd ? text.replace(/^(home|delhome|sethome)\s*/i, "") : "";

    if (isHomeCmd) {
      const pfx = arg.toLowerCase();
      const local = this.getHomes().filter((h) => !pfx || h.toLowerCase().startsWith(pfx));
      void this.tryServerTabComplete(text).then((remote) => {
        for (const m of remote) {
          const token = m.split(/\s+/).pop() || m;
          if (token && !token.includes(" ")) this.rememberHome(token);
        }
      });
      return local.slice(0, 50);
    }

    return this.tryServerTabComplete(text);
  }

  private async tryServerTabComplete(text: string): Promise<string[]> {
    const bot = this.bot;
    if (!bot?._client) return [];
    const client = bot._client as {
      write: (name: string, params: Record<string, unknown>) => void;
      once: (name: string, fn: (data: unknown) => void) => void;
      off?: (name: string, fn: (data: unknown) => void) => void;
      removeListener?: (name: string, fn: (data: unknown) => void) => void;
    };

    // 1.19+ form: { transactionId, text } — no assumeCommand
    const transactionId = (this.tabCompleteTx = (this.tabCompleteTx % 1_000_000) + 1);
    const cleaned = text.replace(/^\//, "");

    return await new Promise<string[]>((resolve) => {
      let settled = false;
      const finish = (matches: string[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          if (client.off) client.off("tab_complete", onPacket as never);
          else if (client.removeListener) client.removeListener("tab_complete", onPacket as never);
        } catch {
          /* ignore */
        }
        resolve(matches);
      };

      const onPacket = (data: unknown) => {
        const d = data as {
          transactionId?: number;
          id?: number;
          matches?: Array<string | { match?: string; item?: string }>;
        };
        const tid = d?.transactionId ?? d?.id;
        if (tid != null && tid !== transactionId) return;
        const raw = Array.isArray(d?.matches) ? d.matches : [];
        const matches = raw
          .map((m) => {
            if (typeof m === "string") return m;
            if (m && typeof m === "object") return String(m.match ?? m.item ?? "");
            return "";
          })
          .filter((s) => s.length > 0);
        finish(matches);
      };

      const timer = setTimeout(() => finish([]), 900);
      try {
        client.once("tab_complete", onPacket);
        client.write("tab_complete", { transactionId, text: cleaned });
      } catch {
        // Fall back to mineflayer helper if write shape differs
        void bot
          .tabComplete(cleaned, true, false, 800)
          .then((matches) => {
            if (!Array.isArray(matches)) {
              finish([]);
              return;
            }
            finish(
              matches
                .map((m) => {
                  if (typeof m === "string") return m;
                  if (m && typeof m === "object" && "match" in m) return String((m as { match: string }).match);
                  return String(m);
                })
                .filter((s) => s.length > 0),
            );
          })
          .catch(() => finish([]));
      }
    });
  }

  /**
   * Run /homes and wait for 6b6t's show_dialog (or a classic container).
   * Seeds knownHomes from dialog button labels.
   */
  async openHomesGui(): Promise<InventoryView> {
    const bot = this.requireBot();
    this.lastHomesDialog = null;
    if (bot.currentWindow) {
      try {
        bot.closeWindow(bot.currentWindow);
      } catch {
        /* ignore */
      }
    }
    sendCommand(bot, "homes");
    await this.waitForHomesUi(3000);
    return this.getInventory();
  }

  private waitForHomesUi(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.homesWindowWaiter) {
        clearTimeout(this.homesWindowWaiter.timer);
        this.homesWindowWaiter.resolve(false);
      }
      const timer = setTimeout(() => {
        this.homesWindowWaiter = null;
        resolve(Boolean(this.lastHomesDialog || this.bot?.currentWindow));
      }, ms);
      this.homesWindowWaiter = {
        resolve: (v) => {
          clearTimeout(timer);
          this.homesWindowWaiter = null;
          resolve(v);
        },
        timer,
      };
      if (this.lastHomesDialog || this.bot?.currentWindow) {
        this.homesWindowWaiter.resolve(true);
      }
    });
  }

  async manageInventory(command: InvCommand): Promise<InventoryView> {
    const run = this.invChain.then(() => this.runInventory(command), () => this.runInventory(command));
    this.invChain = run.then(() => undefined, () => undefined);
    return run;
  }

  dump(): WorldDump {
    const bot = this.requireBot();
    return dumpWorld(bot, this.worldKind);
  }

  getVoxels(radius?: number, quality: VoxelQuality = "full"): VoxelField {
    const q = quality === "lite" ? "lite" : "full";
    return sampleVoxels(this.requireBot(), {
      radius: clampVoxelRadius(radius, q === "lite" ? 12 : 20, q),
      quality: q,
    });
  }

  startPortalHunt(): void {
    this.autoLobby = true;
    this.navigator?.start();
  }

  stopPortalHunt(): void {
    this.autoLobby = false;
    this.navigator?.stop();
  }

  setFlags(flags: { autoReconnect?: boolean; autoLobby?: boolean }): void {
    if (flags.autoReconnect !== undefined) this.autoReconnect = flags.autoReconnect;
    if (flags.autoLobby !== undefined) {
      this.autoLobby = flags.autoLobby;
      if (this.autoLobby) {
        // Force restart so a stuck loop actually begins walking again
        this.navigator?.stop();
        this.navigator?.start();
      } else {
        this.navigator?.stop();
      }
    }
  }

  private connect(): void {
    const generation = ++this.joinGeneration;
    this.authenticated = false;
    this.reachedLogin = false;
    this.serverPortalsEntered = 0;
    this.mainConfirmed = false;
    this.worldKind = "unknown";
    this.startedAt = Date.now();
    this.playerSkinUrls.clear();
    this.setPhase("connecting");

    const host = this.currentHost();
    const info = {
      host,
      port: this.config.port,
      username: this.config.username,
    };
    this.emit("connecting", info);
    const authMode = this.config.auth === "microsoft" ? "microsoft" : "offline";
    log.info(`Joining ${info.host}:${info.port} as ${info.username} (${authMode})`);

    let bot: Bot;
    try {
      const opts: Parameters<typeof mineflayer.createBot>[0] = {
        host,
        port: this.config.port,
        username: this.config.username,
        auth: authMode,
        version: this.config.version || undefined,
        brand: "fabric",
        hideErrors: true,
        checkTimeoutInterval: 45_000,
        keepAlive: true,
        viewDistance: this.config.viewDistance,
      };
      if (authMode === "microsoft") {
        ensureSettingsLayout();
        opts.profilesFolder = authCacheDir();
        // Surface device code to dashboard so the user can copy it and open Microsoft login.
        (opts as { onMsaCode?: (data: import("./types.ts").MsaDeviceCode) => void }).onMsaCode = (data) => {
          const payload: import("./types.ts").MsaDeviceCode = {
            user_code: String(data?.user_code || ""),
            verification_uri: String(data?.verification_uri || "https://www.microsoft.com/link"),
            message: data?.message ? String(data.message) : undefined,
            expires_in: typeof data?.expires_in === "number" ? data.expires_in : undefined,
            interval: typeof data?.interval === "number" ? data.interval : undefined,
            at: new Date().toISOString(),
          };
          this.lastMsaCode = payload;
          log.info(
            `Microsoft device code for ${info.username}: ${payload.user_code} → ${payload.verification_uri}`,
          );
          this.emit("msaCode", payload);
          this.emit("status", this.getStatus());
        };
      }
      bot = mineflayer.createBot(opts);
    } catch (error) {
      this.bot = null;
      this.noteFault("connect", error);
      this.rotateHost("connect-error");
      this.scheduleReconnect("connect");
      return;
    }
    this.bot = bot;
    // Load home names saved for this account (Settings/homes/<user>.json)
    this.loadHomesFromDisk();

    bot.loadPlugin(pathfinder);
    attachAnarchyMod(bot);
    attachProtocolCompat(bot);
    attachVelocityTransfer(bot);
    // Optional full S→C (and C→S) protocol dump for reverse-engineering
    this.wireServerListener(bot);

    const markGameAuthenticated = (reason: string) => {
      if (generation !== this.joinGeneration) return;
      if (this.authenticated) return;
      this.authenticated = true;
      log.info(`Authenticated (${reason})`);
      this.emit("authenticated");
      this.refreshWorld("authenticated");
      // Offline accounts often still have physics paused after /login — enable
      // before lobby portal walk so the first approach is not a half-turn stall.
      try {
        bot.physicsEnabled = true;
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (generation !== this.joinGeneration) return;
        this.refreshWorld("post-auth");
        try {
          bot.physicsEnabled = true;
        } catch {
          /* ignore */
        }
        if (this.autoLobby) this.navigator?.start();
      }, 400);
      // Chunks may load a bit later in sky / second lobby
      setTimeout(() => {
        if (generation !== this.joinGeneration) return;
        if (this.autoLobby && this.authenticated && !isMainWorld(this.worldKind)) {
          this.navigator?.start();
        }
      }, 1800);
    };

    // Offline/cracked: wait for server /login|/register success via chat.
    // Microsoft/premium: 6b6t (and most anarchy servers) skip in-game /login —
    // once MSA + TCP login succeed, the player is already "logged in" in lobby.
    this.auth = attachAuth(bot, this.password, () => markGameAuthenticated("in-game /login"));

    let lastPortalEnterAt = 0;
    this.navigator = createPortalNavigator(bot, this.config.portalRetryMs, {
      onFound: (portal) => this.emit("portalFound", portal),
      onEntered: (portal) => {
        // Velocity transfers fire multiple configuration/play transitions and
        // overlapping hunt loops can all see hasTransferred=true. Debounce so
        // one real portal hop only counts once (otherwise 1/2 jumps to 7/2 and
        // the second lobby portal is never hunted).
        const now = Date.now();
        if (now - lastPortalEnterAt < 4000) {
          log.info(`Ignoring duplicate portal-enter event (${now - lastPortalEnterAt}ms after last)`);
          return;
        }
        lastPortalEnterAt = now;
        this.serverPortalsEntered += 1;
        this.emit("portalEntered", { kind: portal.kind, count: this.serverPortalsEntered });
        log.info(`Entered server portal ${this.serverPortalsEntered}/${this.config.requiredServerPortals}`);
        // Portal hop unloads entities without reliable entityGone — flush then reseed after transfer
        this.flushNearbyPlayers("portal");
        setTimeout(() => {
          this.refreshWorld("portal-enter");
          if (this.bot) {
            try {
              this.recheckNearbyPlayers(this.bot);
            } catch {
              /* ignore */
            }
          }
          // After first portal, force a fresh hunt for the second lobby portal
          if (
            this.autoLobby &&
            this.serverPortalsEntered < this.config.requiredServerPortals &&
            !isMainWorld(this.worldKind)
          ) {
            this.navigator?.start();
          }
        }, 1200);
      },
      onMiss: (reason) => {
        if (!this.autoLobby) return;
        this.emit("lobbyRetry", { inMs: this.config.portalRetryMs, reason });
      },
      getWorldKind: () => this.worldKind,
      allowServerPortals: () =>
        this.autoLobby &&
        this.authenticated &&
        this.serverPortalsEntered < this.config.requiredServerPortals &&
        !isMainWorld(this.worldKind),
    });

    const emitChatLine = (raw: unknown) => {
      let text = "";
      try {
        if (typeof raw === "string") text = raw;
        else if (raw && typeof (raw as { toString?: () => string }).toString === "function") {
          text = (raw as { toString: () => string }).toString();
        } else {
          text = String(raw ?? "");
        }
      } catch {
        text = String(raw ?? "");
      }
      text = redactSecrets(text).replace(/\s+/g, " ").trim().slice(0, 300);
      if (!text) return;
      const now = Date.now();
      // messagestr + message often fire for the same line
      if (text === this.lastChat && now - (this.lastChatAt ?? 0) < 400) return;
      this.lastChatAt = now;
      this.lastChat = text;
      this.emit("chat", { raw: text, timestamp: now });
      this.handleKitBotChat(text);
    };
    bot.on("messagestr", (message) => emitChatLine(message));
    bot.on("message", (jsonMsg) => emitChatLine(jsonMsg));

    // Learn home names from system chat (sethome confirm, /homes text list, errors)
    bot.on("messagestr", (message: string) => {
      if (generation !== this.joinGeneration) return;
      this.ingestHomesFromChat(String(message || ""));
    });

    // 6b6t join flow signals from packet log:
    // - "already trying to connect" → stop portal spam, wait for Velocity hop
    // - "You're now playing on" → force in_game / stop hunt
    bot.on("messagestr", (message: string) => {
      if (generation !== this.joinGeneration) return;
      const text = String(message || "");
      if (/already trying to connect/i.test(text)) {
        log.info("Server transfer in progress — holding portal approach");
        this.navigator?.holdForTransfer?.(10_000);
        return;
      }
      if (/you'?re now playing on/i.test(text) || /now playing on/i.test(text)) {
        log.info(`Main join confirmed by chat: ${text.slice(0, 80)}`);
        this.mainConfirmed = true;
        this.serverPortalsEntered = Math.max(
          this.serverPortalsEntered,
          this.config.requiredServerPortals,
        );
        this.navigator?.stop();
        this.refreshWorld("chat-playing-on");
      }
    });

    bot.on("windowOpen", (window) => {
      if (generation !== this.joinGeneration) return;
      try {
        const title = stripWindowTitle((window as { title?: unknown }).title);
        log.info(`Window opened: ${title || "untitled"}`);
        // Seed homes from named items if this looks like a homes GUI
        if (/home/i.test(title)) {
          const slots = (window as { slots?: Array<{ customName?: unknown; displayName?: unknown; name?: unknown } | null> })
            .slots;
          if (Array.isArray(slots)) {
            for (const item of slots) {
              if (!item) continue;
              const label = itemText(item.customName) || itemText(item.displayName) || itemText(item.name);
              if (label && label !== "unknown" && !/^minecraft:/.test(label) && !label.includes(" ")) {
                this.rememberHome(label);
              }
            }
          }
        }
        if (this.homesWindowWaiter) this.homesWindowWaiter.resolve(true);
        this.emit("window", { open: true, title, inventory: this.getInventory() });
        this.emit("status", this.getStatus());
      } catch (e) {
        log.warn("windowOpen handler", e instanceof Error ? e.message : e);
      }
    });

    bot.on("windowClose", () => {
      if (generation !== this.joinGeneration) return;
      this.emit("window", { open: false, inventory: this.getInventory() });
    });

    // 6b6t /homes uses the 1.21 Dialog system (show_dialog), not a chest window
    const handleShowDialog = (packet: unknown) => {
      if (generation !== this.joinGeneration) return;
      try {
        const parsed = parseHomesDialog(packet);
        if (!parsed) {
          log.info("show_dialog received but not a homes dialog (or parse failed)");
          return;
        }
        this.lastHomesDialog = parsed;
        // Full replace from /homes each time, then persist to disk
        this.replaceHomes(parsed.homes);
        log.info(`Homes dialog: ${parsed.homes.length} home(s) (saved)`);
        if (this.homesWindowWaiter) this.homesWindowWaiter.resolve(true);
        this.emit("window", {
          open: true,
          title: parsed.title,
          kind: "homesDialog",
          homes: parsed.homes,
          inventory: this.getInventory(),
        });
        this.emit("status", this.getStatus());
      } catch (e) {
        log.warn("show_dialog handler", e instanceof Error ? e.message : e);
      }
    };
    const mcClient = bot._client as { on: (n: string, fn: (...args: unknown[]) => void) => void };
    try {
      mcClient.on("show_dialog", (packet: unknown) => handleShowDialog(packet));
    } catch {
      /* ignore */
    }
    // Backup: some builds only emit the generic packet event
    try {
      mcClient.on("packet", (data: unknown, meta: unknown) => {
        const name = (meta as { name?: string } | undefined)?.name;
        if (name === "show_dialog") handleShowDialog(data);
      });
    } catch {
      /* ignore */
    }

    this.wireDetection(bot, generation);

    // Capture skins from tab list — works for premium AND cracked (SkinRestorer / custom URLs)
    this.wirePlayerSkins(bot, generation);


    bot.once("login", () => {
      if (generation !== this.joinGeneration) return;
      this.reachedLogin = true;
      this.lastError = undefined;
      this.setPhase("authenticating");
      this.emit("connected");
      if (authMode === "microsoft") {
        // Premium accounts are session-authenticated; no server /login required.
        log.info("TCP login complete (Microsoft) — marking authenticated (no /login on this server)");
        markGameAuthenticated("microsoft session");
        try {
          bot.physicsEnabled = true;
        } catch {
          /* ignore */
        }
      } else {
        log.info("TCP login complete, waiting for spawn + /login");
      }
    });

    bot.once("spawn", () => {
      if (generation !== this.joinGeneration) return;
      // Safety net: if login handler raced, still mark MS accounts authenticated on first spawn
      if (authMode === "microsoft" && !this.authenticated) {
        markGameAuthenticated("microsoft spawn");
      }
      this.onSpawn("first");
    });

    bot.on("spawn", () => {
      if (generation !== this.joinGeneration) return;
      if (authMode === "microsoft" && !this.authenticated) {
        markGameAuthenticated("microsoft spawn");
      }
      this.refreshWorld("spawn");
    });

    bot.on("respawn", () => {
      if (generation !== this.joinGeneration) return;
      this.refreshWorld("respawn");
    });

    bot.on("death", () => {
      if (generation !== this.joinGeneration) return;
      try {
        this.mapper.onDeath();
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          if (this.bot && generation === this.joinGeneration) this.bot.respawn();
        } catch {
          /* ignore */
        }
      }, 3000);
    });

    bot.on("forcedMove", () => {
      if (generation !== this.joinGeneration) return;
      this.refreshWorld("forcedMove");
    });

    // Server brand switches Paper → Fox when Velocity lands us on the main backend
    try {
      const client = bot._client as {
        on?: (ev: string, fn: (...args: unknown[]) => void) => void;
      };
      client.on?.("custom_payload", (data: unknown) => {
        if (generation !== this.joinGeneration) return;
        const d = data as { channel?: string; data?: unknown } | null;
        const channel = String(d?.channel || "");
        if (!/brand/i.test(channel)) return;
        let brand = "";
        const raw = d?.data;
        if (typeof raw === "string") brand = raw;
        else if (Buffer.isBuffer(raw)) {
          // first byte often length prefix in MC brand payloads
          try {
            brand = raw.toString("utf8").replace(/^[\x00-\x1f]+/, "");
          } catch {
            brand = "";
          }
        } else if (raw && typeof raw === "object" && "toString" in (raw as object)) {
          brand = String(raw);
        }
        brand = brand.replace(/\0/g, "").trim();
        if (!brand) return;
        try {
          (bot as { brand?: string }).brand = brand;
        } catch {
          /* ignore */
        }
        if (/^fox\b/i.test(brand) && this.authenticated) {
          if (!this.mainConfirmed) {
            log.info(`Main backend brand: ${brand}`);
            this.mainConfirmed = true;
            this.serverPortalsEntered = Math.max(
              this.serverPortalsEntered,
              this.config.requiredServerPortals,
            );
          }
          this.navigator?.stop();
          this.refreshWorld("brand-fox");
        } else if (/^paper\b/i.test(brand)) {
          this.refreshWorld("brand-paper");
        }
      });
    } catch {
      /* ignore */
    }


    bot.on("kicked", (reason, loggedIn) => {
      if (generation !== this.joinGeneration) return;
      const parsed = parseKick(reason, this.config.username);
      this.lastKick = parsed.text;
      this.lastKickKind = parsed.kind;
      this.lastKickLinks = parsed.links;
      this.lastVerificationCode = parsed.verificationCode;
      this.lastKickHint = parsed.hint;

      this.noteFault(
        "kick",
        loggedIn ? `kicked (${parsed.kind}): ${parsed.text}` : `kicked before login (${parsed.kind}): ${parsed.text}`,
      );

      log.warn(`Kicked (loggedIn=${loggedIn}, kind=${parsed.kind}): ${parsed.text}`);
      if (parsed.hint) log.warn(`Hint: ${parsed.hint}`);
      if (parsed.verificationCode) {
        log.warn(`Verification code: ${parsed.verificationCode}`);
      }
      if (parsed.links.length > 0) {
        log.warn("─── CAPTCHA / VERIFICATION LINK(S) ───");
        for (const link of parsed.links) {
          log.warn(`  ${link}`);
        }
        log.warn("Open the link above (enter the code if shown), then restart the bot.");
        log.warn("─────────────────────────────────────");
      } else if (parsed.kind === "captcha") {
        log.warn(
          "Anti-bot / captcha kick detected (no URL found). Log in with a normal Minecraft client to verify, then restart the bot.",
        );
      }

      // Rotate host on some proxy/backend failures
      if (
        parsed.kind === "backend-unreachable" ||
        parsed.kind === "connection-error" ||
        parsed.kind === "ddos-blocked"
      ) {
        this.rotateHost("kick-" + parsed.kind);
      }

      try {
        log.debug(`Kick raw JSON: ${JSON.stringify(reason)}`);
      } catch {}

      this.emit("kicked", {
        reason: parsed.text,
        kind: parsed.kind,
        links: parsed.links,
        verificationCode: parsed.verificationCode,
        hint: parsed.hint,
      });
      this.auth?.destroy();
      this.navigator?.stop();
      this.scheduleReconnect("kicked", kickReconnectBucket(parsed.kind));
    });

    bot.on("end", (reason) => {
      if (generation !== this.joinGeneration) return;
      const text = String(reason ?? "end");
      log.warn(`Disconnected: ${text}`);
      this.emit("disconnected", text);
      if (this.leaving) {
        this.setPhase("idle");
        return;
      }
      this.noteFault(this.reachedLogin ? "disconnect" : "connect", text);
      this.scheduleReconnect("end");
    });

    bot.on("error", (error) => {
      if (generation !== this.joinGeneration) return;
      const err = error instanceof Error ? error : new Error(String(error));
      const msg = err.message || String(error);

      // Recoverable parse errors (corrupt chunks that vanilla tolerates).
      // Same approach as Elytra Mapper: log + stay connected instead of dying.
      if (RECOVERABLE_PARSE_RE.test(msg)) {
        this.parseSkipCount += 1;
        const now = Date.now();
        if (now - this.lastParseSkipLoggedAt > 60_000) {
          this.lastParseSkipLoggedAt = now;
          log.warn(
            `Skipped ${this.parseSkipCount} unparseable packet(s) (corrupt chunk) and stayed connected. Latest: ${msg.slice(0, 140)}`,
          );
          this.parseSkipCount = 0;
        }
        return;
      }

      log.error("Bot error", msg);
      this.noteFault(this.reachedLogin ? "socket" : "connect", err);
      this.emit("error", err);
    });

    // Client-level packet errors sometimes surface on _client rather than bot
    const rawClient = bot._client as unknown as { on: (e: string, fn: (...a: unknown[]) => void) => void };
    rawClient.on("error", (error: unknown) => {
      if (generation !== this.joinGeneration) return;
      const msg = error instanceof Error ? error.message : String(error);
      if (RECOVERABLE_PARSE_RE.test(msg)) {
        this.parseSkipCount += 1;
        const now = Date.now();
        if (now - this.lastParseSkipLoggedAt > 60_000) {
          this.lastParseSkipLoggedAt = now;
          log.warn(
            `Skipped ${this.parseSkipCount} unparseable packet(s) on client (corrupt chunk). Latest: ${msg.slice(0, 140)}`,
          );
          this.parseSkipCount = 0;
        }
      }
    });
  }

  private onSpawn(reason: string): void {
    const bot = this.bot;
    if (!bot) return;
    this.refreshWorld(reason);
    const dump = dumpWorld(bot, this.worldKind);
    try {
      const file = persistDump(this.config.rootDir, dump);
      log.info(`World probe saved to ${file}`);
    } catch (error) {
      log.warn("Could not persist world dump", error instanceof Error ? error.message : error);
    }
    log.info(summarizeDump(dump));
    if (dump.asciiMap) log.info(`\n${dump.asciiMap}`);
    this.emit("spawned", dump);
    // Resume an interrupted hunt once we are back on the main world (dimension changes, deaths, reconnects).
    if (this.hunt?.running && this.hunt.isPaused && this.worldKind === "overworld") {
      this.hunt.resume();
      this.startHuntTicker();
    }
  }

  private refreshWorld(reason: string): void {
    const bot = this.bot;
    if (!bot?.entity) return;
    pruneStalePlayerEntities(bot);
    const kind = classifyWorld(bot, {
      authenticated: this.authenticated,
      serverPortalsEntered: this.serverPortalsEntered,
      requiredServerPortals: this.config.requiredServerPortals,
      mainConfirmed: this.mainConfirmed,
    });
    const kindChanged = kind !== this.worldKind;
    if (kindChanged) {
      this.worldKind = kind;
      this.emit("worldKind", kind);
      log.info(`World kind is ${kind} (${reason})`);
    }
    // Dimension / lobby hops drop entities without entityGone — resync detection set
    if (kindChanged || reason === "respawn" || reason === "forcedMove" || reason === "portal-enter") {
      if (this.nearbyPlayers.size) {
        this.flushNearbyPlayers(reason);
      }
      try {
        this.recheckNearbyPlayers(bot);
      } catch {
        /* ignore */
      }
    }

    // Brand/chat main: treat portals as done so we stop lobby hunting
    if (isMainWorld(kind) && this.mainConfirmed && this.serverPortalsEntered < this.config.requiredServerPortals) {
      this.serverPortalsEntered = this.config.requiredServerPortals;
      log.info("Main world confirmed — marking portals complete");
    }

    // Do not treat intermediate lobbies as main until required portals are done
    if (
      isMainWorld(kind) &&
      this.authenticated &&
      (this.serverPortalsEntered >= this.config.requiredServerPortals || this.mainConfirmed)
    ) {
      this.navigator?.stop();
      this.setPhase("in_game");
      this.captchaHalted = false;
      // Mapper hooks (bot.hp.isOnMainServer, recorder, chunk prune)
      try {
        this.mapper.onMainServer();
      } catch (e) {
        log.warn("mapper onMainServer", e instanceof Error ? e.message : e);
      }
      if (this.config.mapAutoStart && !this.mapper.isActive()) {
        setTimeout(() => {
          if (this.phase !== "in_game" || this.mapper.isActive()) return;
          log.info(`MAP_AUTO_START: ${this.startMapping()}`);
        }, 8000);
      }
      // Only reset backoff after surviving HEALTHY_STABLE_MS on main (Elytra approach).
      // Prevents a corrupt-chunk crash loop from resetting the delay every cycle.
      if (this.healthyResetTimer) clearTimeout(this.healthyResetTimer);
      const generation = this.joinGeneration;
      this.healthyResetTimer = setTimeout(() => {
        if (this.joinGeneration !== generation) return;
        if (this.phase !== "in_game") return;
        if (this.reconnectDelayMs !== this.config.reconnectMs) {
          this.reconnectDelayMs = this.config.reconnectMs;
          log.info(
            `Connection stable ${Math.round(HEALTHY_STABLE_MS / 1000)}s on main world — reconnect backoff reset`,
          );
        }
      }, HEALTHY_STABLE_MS);
      return;
    }

    if (this.authenticated && isLobbyLike(kind)) {
      this.setPhase("lobby");
      if (this.autoLobby) this.navigator?.start();
      return;
    }

    // Still need portals but classifier said "overworld" too early — keep hunting
    if (
      this.authenticated &&
      this.autoLobby &&
      this.serverPortalsEntered < this.config.requiredServerPortals
    ) {
      this.setPhase("lobby");
      this.navigator?.start();
      return;
    }

    if (!this.authenticated) this.setPhase("authenticating");
  }

  private noteFault(source: BotErrorSource, error: unknown): void {
    const described = describeError(error);
    let message = described.message;
    if (source === "connect" && !message.includes(this.config.host)) {
      message = `${message} (${this.config.host}:${this.config.port})`;
    }
    message = message.slice(0, 500);

    const genericHangup =
      source === "disconnect" && /^(socketClosed|end|connection|client disconnects)$/i.test(message);
    if (genericHangup && this.lastError && this.faultJoinGeneration === this.joinGeneration) {
      return;
    }

    this.lastError = {
      at: new Date().toISOString(),
      source,
      message,
      code: described.code,
    };
    this.faultJoinGeneration = this.joinGeneration;
    this.emit("status", this.getStatus());
  }

  private hostList(): string[] {
    const list = (this.config.hosts && this.config.hosts.length
      ? this.config.hosts
      : [this.config.host]
    ).filter(Boolean);
    return list.length ? list : ["alt3.6b6t.org"];
  }

  private currentHost(): string {
    const list = this.hostList();
    return list[this.hostIndex % list.length];
  }

  private rotateHost(reason: string): void {
    const list = this.hostList();
    if (list.length < 2) return;
    this.hostIndex = (this.hostIndex + 1) % list.length;
    const next = list[this.hostIndex];
    this.config = { ...this.config, host: next };
    log.info(`Host failover (${reason}) → ${next} [${this.hostIndex + 1}/${list.length}]`);
  }

  private scheduleReconnect(reason: string, kind: "captcha" | "rate-limit" | "other" = "other"): void {
    if (this.leaving || !this.autoReconnect || this.captchaHalted) {
      this.setPhase("disconnected");
      return;
    }
    if (this.reconnectTimer) return;

    if (kind === "captcha") {
      if (this.config.captchaCooldownMs <= 0) {
        this.captchaHalted = true;
        this.setPhase("disconnected");
        log.warn(
          "Captcha kick — auto-reconnect disabled (CAPTCHA_COOLDOWN_MS=0). Solve the captcha with a real client, then restart the bot.",
        );
        return;
      }
      this.reconnectDelayMs = Math.max(this.reconnectDelayMs, this.config.captchaCooldownMs);
    } else if (kind === "rate-limit") {
      this.reconnectDelayMs = Math.max(this.reconnectDelayMs, this.config.rateLimitCooldownMs);
    } else {
      this.reconnectDelayMs = Math.min(
        Math.max(this.reconnectDelayMs, this.config.reconnectMs) * 2,
        this.config.reconnectMaxMs,
      );
    }

    const jitter = 0.9 + Math.random() * 0.2;
    const delay = Math.round(this.reconnectDelayMs * jitter);

    this.setPhase("reconnecting");
    const human =
      kind === "captcha"
        ? `${Math.round(delay / 60000)} min (captcha cooldown)`
        : `${Math.round(delay / 1000)}s`;
    log.info(`Rejoining in ${human} after ${reason} (${kind}) via ${this.currentHost()}`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.leaving || !this.autoReconnect || this.captchaHalted) return;
      this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.healthyResetTimer) {
      clearTimeout(this.healthyResetTimer);
      this.healthyResetTimer = null;
    }
  }

  private async disconnectInternal(reason: string): Promise<void> {
    this.navigator?.stop();
    this.clearDetectionRecheck();
    this.clearPlayerPresence(false);
    // Pause hunting (not stop): the controller and its database survive a reconnect so an interrupted route
    // resumes where it left off instead of losing its progress.
    if (this.hunt?.running) {
      try {
        this.hunt.pause();
      } catch {
        /* ignore */
      }
      this.stopHuntTicker();
    }
    // Pause the kit bot too: serving kits needs a live entity and inventory.
    this.kitbotActive = false;
    this.auth?.destroy();
    this.auth = null;
    this.navigator = null;
    detachServerListener((this.config.username || "").toLowerCase());
    const bot = this.bot;
    this.bot = null;
    if (!bot) return;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      bot.once("end", done);
      try {
        bot.quit(reason);
      } catch {
        try {
          bot.end(reason);
        } catch {
          done();
        }
      }
      setTimeout(done, 1500);
    });
  }

  private setPhase(phase: BotPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit("phase", phase);
    this.emit("status", this.getStatus());
  }

  private requireBot(): Bot {
    if (!this.bot) throw new Error("Bot is not connected. Run `join` first.");
    return this.bot;
  }

  private async runInventory(command: InvCommand): Promise<InventoryView> {
    const bot = this.requireBot();
    const op = command.op;

    // /homes and other server GUIs: click or close without touching player inventory
    if (op === "windowClose") {
      if (bot.currentWindow) {
        try {
          bot.closeWindow(bot.currentWindow);
        } catch {
          /* already closed */
        }
      }
      return this.getInventory();
    }

    if (op === "windowClick") {
      if (!bot.currentWindow) throw new Error("no window open");
      if (command.slot == null) throw new Error("windowClick needs slot");
      const mouse = command.mouseButton === 1 ? 1 : 0;
      // mode 0 = normal click (teleport / select home on 6b6t homes GUI)
      await bot.clickWindow(command.slot, mouse, 0);
      // Give the server a tick to process teleport / close the GUI
      await new Promise((r) => setTimeout(r, 150));
      return this.getInventory();
    }

    // Player-inventory ops: close any open container first so slot indices match bot.inventory
    if (bot.currentWindow) {
      try {
        bot.closeWindow(bot.currentWindow);
      } catch {
        // window may already be gone
      }
    }

    const slot = command.slot;
    const item = slot == null ? bot.heldItem : bot.inventory.slots[slot] ?? null;

    if (op === "swap") {
      if (slot == null || command.to == null) throw new Error("swap needs slot and to");
      if (slot === command.to) return this.getInventory();
      const fromItem = bot.inventory.slots[slot] ?? null;
      const toItem = bot.inventory.slots[command.to] ?? null;
      assertItemFitsSlot(fromItem?.name, command.to);
      assertItemFitsSlot(toItem?.name, slot);
      await bot.moveSlotItem(slot, command.to);
      return this.getInventory();
    }

    if (op === "unequip") {
      const dest = command.dest ?? destForSlot(slot);
      if (!dest || dest === "hand") throw new Error("unequip needs head, torso, legs, feet, or off-hand");
      await bot.unequip(dest);
      return this.getInventory();
    }

    if (op === "hold") {
      if (slot == null) throw new Error("hold needs a slot");
      const hotbar = hotbarIndex(slot);
      if (hotbar != null) bot.setQuickBarSlot(hotbar);
      else {
        if (!item) throw new Error(`slot ${slot} is empty`);
        await bot.equip(item, "hand");
      }
      return this.getInventory();
    }

    if (!item) throw new Error(slot == null ? "not holding anything" : `slot ${slot} is empty`);

    if (op === "dropStack") {
      await bot.tossStack(item);
      return this.getInventory();
    }

    if (op === "drop") {
      const count = Math.max(1, Math.min(item.count, command.count ?? 1));
      if (count >= item.count) await bot.tossStack(item);
      else {
        for (let i = 0; i < count; i++) await bot.clickWindow(item.slot, 0, 4);
      }
      return this.getInventory();
    }

    if (op === "equip") {
      const dest = command.dest ?? guessDest(item.name);
      if (dest === "head" || dest === "torso" || dest === "legs" || dest === "feet") {
        const targetSlot = slotForDest(dest);
        if (targetSlot != null) assertItemFitsSlot(item.name, targetSlot);
      }
      // Refuse putting armor-only pieces into off-hand via equip
      if (dest === "off-hand" && isArmorOnlyItem(item.name)) {
        throw new Error(
          `${cleanItemName(item.name)} belongs in the ${guessDest(item.name)} slot, not off-hand`,
        );
      }
      await bot.equip(item, dest);
      return this.getInventory();
    }

    if (op === "use") {
      const hotbar = hotbarIndex(item.slot);
      if (hotbar != null) bot.setQuickBarSlot(hotbar);
      else await bot.equip(item, "hand");
      const foods = bot.registry.foodsByName as Record<string, unknown> | undefined;
      if (foods?.[item.name] || ALWAYS_CONSUMABLE.has(item.name)) await bot.consume();
      else bot.activateItem();
      return this.getInventory();
    }

    throw new Error(`unknown inventory op ${op}`);
  }

  /**
   * Extract home names from typical 6b6t / Essentials-style chat lines.
   * Examples:
   *   "Home set: base"
   *   "Your homes (2/3): base, spawn"
   *   "Homes: base, stash, portal"
   *   "Teleporting to home base in 15 seconds"
   *   "Home base deleted"
   */
  private ingestHomesFromChat(text: string): void {
    const t = text.replace(/§[0-9a-fk-or]/gi, "").trim();
    if (!t) return;

    // sethome confirm
    let m = t.match(/\b(?:home\s+set|set\s+home|created\s+home|home\s+created)[:\s]+['"]?([A-Za-z0-9_]{1,32})['"]?/i);
    if (m?.[1]) {
      this.rememberHome(m[1]);
      this.persistHomes();
      return;
    }
    m = t.match(/\b(?:you\s+have\s+set\s+your\s+home\s+to|home\s+point\s+set)[:\s]+['"]?([A-Za-z0-9_]{1,32})['"]?/i);
    if (m?.[1]) {
      this.rememberHome(m[1]);
      this.persistHomes();
      return;
    }

    // delhome
    m = t.match(/\b(?:home\s+deleted|deleted\s+home|removed\s+home)[:\s]+['"]?([A-Za-z0-9_]{1,32})['"]?/i);
    if (m?.[1]) {
      this.forgetHome(m[1]);
      return;
    }

    // Teleporting to named home
    m = t.match(/\bteleport(?:ing)?\s+to\s+(?:home\s+)?['"]?([A-Za-z0-9_]{1,32})['"]?/i);
    if (m?.[1] && !/^(you|the|a|spawn)$/i.test(m[1])) {
      this.rememberHome(m[1]);
      this.persistHomes();
    }

    // List lines: "Homes: a, b, c" or "Your homes (3/5): a, b, c"
    m = t.match(/\bhomes?\s*(?:\([^)]*\))?\s*[:\-–]\s*(.+)$/i);
    if (m?.[1]) {
      const parts = m[1].split(/[,|;]+/).map((s) => s.trim()).filter(Boolean);
      for (const p of parts) {
        const name = p.replace(/^['"]+|['"]+$/g, "").split(/\s+/)[0];
        if (name && /^[A-Za-z0-9_]{1,32}$/.test(name) && !/^(you|have|no|none|limit)$/i.test(name)) {
          this.rememberHome(name);
        }
      }
      this.persistHomes();
    }
  }
}

const ALWAYS_CONSUMABLE = new Set([
  "potion",
  "milk_bucket",
  "enchanted_golden_apple",
  "golden_apple",
  "honey_bottle",
  "suspicious_stew",
  "chorus_fruit",
]);

const HOTBAR_START = 36;

function itemText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    const t = value.trim();
    return t || undefined;
  }
  if (typeof value === "object") {
    const v = value as {
      toString?: () => string;
      toMotd?: () => string;
      getText?: () => string;
      text?: unknown;
      value?: unknown;
    };
    try {
      const motd = v.toMotd?.();
      if (typeof motd === "string" && motd.trim()) return motd.trim();
    } catch {
      /* ignore */
    }
    try {
      const text = v.getText?.();
      if (typeof text === "string" && text.trim()) return text.trim();
    } catch {
      /* ignore */
    }
    if (typeof v.text === "string" && v.text.trim()) return v.text.trim();
    if (typeof v.value === "string" && v.value.trim()) return v.value.trim();
    try {
      const s = v.toString?.();
      if (typeof s === "string" && s && s !== "[object Object]") return s.trim();
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/** Strip § formatting and JSON chat components from a window title. */
function stripWindowTitle(title: unknown): string {
  const raw = itemText(title) || (typeof title === "string" ? title : "");
  if (!raw) return "Window";
  // Remove vanilla § color codes and common JSON chat noise
  return raw
    .replace(/§[0-9a-fk-or]/gi, "")
    .replace(/\{[^}]*"text"\s*:\s*"([^"]*)"[^}]*\}/g, "$1")
    .trim() || "Window";
}

/**
 * Unwrap prismarine/nmp NBT-ish values repeatedly.
 * Handles `{ type, value }` and the extra `{ data: { type, value } }` wrapper
 * used by show_dialog on 1.21.11.
 */
function nbtUnwrap(node: unknown, depth = 0): unknown {
  if (node == null || depth > 12) return node;
  if (typeof node !== "object") return node;
  const o = node as Record<string, unknown>;

  // { data: { type: "compound", value: {...} } }
  if ("data" in o && o.data && typeof o.data === "object" && !Array.isArray(o.data)) {
    const inner = nbtUnwrap(o.data, depth + 1);
    if (inner !== o.data) return inner;
  }

  if (typeof o.type === "string" && "value" in o) {
    if (o.type === "compound") return nbtUnwrap(o.value, depth + 1);
    if (o.type === "list") {
      const listPayload = o.value;
      if (Array.isArray(listPayload)) return listPayload.map((x) => nbtUnwrap(x, depth + 1));
      if (listPayload && typeof listPayload === "object") {
        const lp = listPayload as { value?: unknown };
        if (Array.isArray(lp.value)) return lp.value.map((x) => nbtUnwrap(x, depth + 1));
      }
      return nbtUnwrap(listPayload, depth + 1);
    }
    return o.value;
  }
  return node;
}

function nbtString(node: unknown): string {
  const v = nbtUnwrap(node);
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v && typeof v === "object" && "text" in (v as object)) {
    return nbtString((v as { text: unknown }).text);
  }
  return "";
}

/** Walk any nested structure and collect NBT-ish string labels near "label" keys. */
function collectLabelStrings(node: unknown, out: string[], depth = 0): void {
  if (node == null || depth > 20) return;
  if (Array.isArray(node)) {
    for (const x of node) collectLabelStrings(x, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if ("label" in o) {
    const s = nbtString(o.label);
    if (s) out.push(s);
  }
  for (const v of Object.values(o)) collectLabelStrings(v, out, depth + 1);
}

/**
 * Parse 6b6t /homes `show_dialog` packet into title + home button labels.
 * Real shape (1.21.11 / Paper):
 *   { dialog: { data: { type: "compound", value: {
 *       type: { value: "minecraft:multi_action" },
 *       title: { value: "Homes" },
 *       actions: { type: "list", value: { type: "compound", value: [ { label: { value: "Base" } } ] } }
 *   }}}}
 */
function parseHomesDialog(packet: unknown): { title: string; homes: string[] } | null {
  if (!packet || typeof packet !== "object") return null;
  const root = (packet as { dialog?: unknown }).dialog ?? packet;

  let fields: Record<string, unknown> | null = null;
  const unwrapped = nbtUnwrap(root);
  if (unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)) {
    fields = unwrapped as Record<string, unknown>;
  }

  let typeStr = fields ? nbtString(fields.type) : "";
  let title = fields ? nbtString(fields.title) : "";

  if (!typeStr || !title) {
    try {
      const blob = JSON.stringify(packet);
      if (/multi_action/i.test(blob)) typeStr = typeStr || "minecraft:multi_action";
      const tm = blob.match(/"title"\s*:\s*\{\s*"type"\s*:\s*"string"\s*,\s*"value"\s*:\s*"([^"]+)"/);
      if (tm?.[1]) title = title || tm[1];
      if (!title && /"Homes"/i.test(blob)) title = "Homes";
    } catch {
      /* ignore */
    }
  }

  if (typeStr && !/multi_action/i.test(typeStr) && !/home/i.test(title || "")) {
    return null;
  }

  const homes: string[] = [];
  const seen = new Set<string>();

  if (fields?.actions != null) {
    const actionsNode = nbtUnwrap(fields.actions);
    const actionList = Array.isArray(actionsNode) ? actionsNode : [];
    for (const action of actionList) {
      const a = nbtUnwrap(action);
      if (!a || typeof a !== "object") continue;
      const label = nbtString((a as { label?: unknown }).label);
      if (!label || /^(cancel|close|back|exit)$/i.test(label)) continue;
      if (seen.has(label)) continue;
      seen.add(label);
      homes.push(label);
    }
  }

  if (!homes.length) {
    const labels: string[] = [];
    collectLabelStrings(packet, labels);
    for (const label of labels) {
      if (!label || /^(cancel|close|back|exit)$/i.test(label)) continue;
      if (seen.has(label)) continue;
      seen.add(label);
      homes.push(label);
    }
  }

  if (!homes.length) {
    try {
      const blob = JSON.stringify(packet);
      const re = /"label"\s*:\s*\{\s*"type"\s*:\s*"string"\s*,\s*"value"\s*:\s*"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(blob))) {
        const label = m[1];
        if (!label || /^(cancel|close|back|exit)$/i.test(label)) continue;
        if (seen.has(label)) continue;
        seen.add(label);
        homes.push(label);
      }
    } catch {
      /* ignore */
    }
  }

  if (!homes.length && !/home/i.test(title || "")) return null;
  return { title: title || "Homes", homes };
}

function snapshotItem(item: {
  slot: number;
  name?: unknown;
  count?: number;
  displayName?: unknown;
  stackSize?: number;
  durabilityUsed?: number;
  maxDurability?: number;
  customName?: unknown;
}): InventorySlot {
  const name = itemText(item.name) || "unknown";
  const displayName = itemText(item.displayName) || name;
  const customName = itemText(item.customName);
  return {
    slot: item.slot,
    name,
    count: item.count ?? 1,
    displayName,
    stackSize: item.stackSize,
    durabilityUsed: item.maxDurability ? item.durabilityUsed : undefined,
    maxDurability: item.maxDurability || undefined,
    customName,
  };
}

function hotbarIndex(slot: number): number | null {
  if (slot >= 0 && slot <= 8) return slot;
  if (slot >= HOTBAR_START && slot <= HOTBAR_START + 8) return slot - HOTBAR_START;
  return null;
}

function destForSlot(slot?: number): EquipmentDest | null {
  if (slot === 5) return "head";
  if (slot === 6) return "torso";
  if (slot === 7) return "legs";
  if (slot === 8) return "feet";
  if (slot === 45) return "off-hand";
  return null;
}

function slotForDest(dest: EquipmentDest): number | null {
  if (dest === "head") return 5;
  if (dest === "torso") return 6;
  if (dest === "legs") return 7;
  if (dest === "feet") return 8;
  if (dest === "off-hand") return 45;
  return null;
}

/** Normalize registry names (strip minecraft: prefix). */
function cleanItemName(name?: string | null): string {
  return String(name || "")
    .trim()
    .replace(/^minecraft:/i, "")
    .toLowerCase();
}

/**
 * True if this item may only occupy a specific armor equipment slot
 * (helmet / chestplate|elytra / leggings / boots). Used to block putting
 * armor into the wrong slot or treating it as a generic off-hand item.
 */
function isArmorOnlyItem(name?: string | null): boolean {
  const n = cleanItemName(name);
  if (!n) return false;
  return (
    /(_helmet|turtle_helmet)$/.test(n) ||
    n === "carved_pumpkin" ||
    /(_head|_skull)$/.test(n) ||
    /(_chestplate|elytra)$/.test(n) ||
    /_leggings$/.test(n) ||
    /_boots$/.test(n)
  );
}

/**
 * Which player-inventory equipment slot an item belongs in, or null if it
 * is not restricted armor (main inventory / hotbar / off-hand OK).
 */
function equipmentSlotForItem(name?: string | null): number | null {
  const n = cleanItemName(name);
  if (!n) return null;
  if (/(_helmet|turtle_helmet)$/.test(n) || n === "carved_pumpkin" || /(_head|_skull)$/.test(n)) return 5;
  if (/(_chestplate|elytra)$/.test(n)) return 6;
  if (/_leggings$/.test(n)) return 7;
  if (/_boots$/.test(n)) return 8;
  return null;
}

/**
 * Enforce vanilla-style equipment rules:
 * - armor slots 5–8 only accept the matching armor / head / elytra
 * - everything else (including off-hand 45) is unrestricted here
 */
function assertItemFitsSlot(name: string | undefined | null, slot: number): void {
  if (slot !== 5 && slot !== 6 && slot !== 7 && slot !== 8) return;
  if (!name) return;
  const expected = equipmentSlotForItem(name);
  if (expected === slot) return;
  const labels: Record<number, string> = {
    5: "helmet / head",
    6: "chestplate / elytra",
    7: "leggings",
    8: "boots",
  };
  const want = labels[slot] || `slot ${slot}`;
  if (expected == null) {
    throw new Error(`${cleanItemName(name) || "that item"} cannot go in the ${want} slot`);
  }
  throw new Error(`${cleanItemName(name)} belongs in the ${labels[expected]} slot, not ${want}`);
}

function guessDest(name: string): EquipmentDest {
  const n = cleanItemName(name);
  if (/(_helmet|turtle_helmet)$/.test(n) || n === "carved_pumpkin" || /(_head|_skull)$/.test(n)) return "head";
  if (/(_chestplate|elytra)$/.test(n)) return "torso";
  if (/_leggings$/.test(n)) return "legs";
  if (/_boots$/.test(n)) return "feet";
  if (n === "shield" || n === "totem_of_undying") return "off-hand";
  return "hand";
}

function redactPaths(message: string): string {
  let out = message;
  const home = os.homedir();
  if (home) out = out.split(home).join("~");
  const cwd = process.cwd();
  if (cwd) out = out.split(cwd).join(".");
  return out;
}

function describeError(error: unknown): { message: string; code?: string } {
  if (error instanceof Error) {
    const code = typeof (error as NodeJS.ErrnoException).code === "string"
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    const message = redactPaths(error.message || error.name || "unknown error");
    if (code && !message.includes(code)) return { message: `${code}: ${message}`, code };
    return { message, code };
  }
  if (typeof error === "string") return { message: redactPaths(error) };
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error) };
  }
}

function roundVec(v: { x: number; y: number; z: number }): Vec3Like {
  return {
    x: Math.round(v.x * 100) / 100,
    y: Math.round(v.y * 100) / 100,
    z: Math.round(v.z * 100) / 100,
  };
}

function nbtText(reason: unknown): string | null {
  if (!reason || typeof reason !== "object") return null;
  const value = reason as { type?: string; value?: { text?: { value?: string } } };
  if (value.type === "compound" && value.value?.text?.value) {
    return value.value.text.value;
  }
  return null;
}

function stringifyKick(reason: unknown): string {
  const fromNbt = nbtText(reason);
  if (fromNbt) return fromNbt;
  if (reason == null) return "unknown";
  if (typeof reason === "string") return reason;
  if (typeof reason === "object") {
    const value = reason as {
      toString?: () => string;
      toMotd?: () => string;
    };
    try {
      const text = value.toString?.();
      if (text && text !== "[object Object]") return text;
    } catch {
      // fall through
    }
    try {
      const motd = value.toMotd?.();
      if (motd) return motd;
    } catch {
      // fall through
    }
    try {
      return JSON.stringify(reason);
    } catch {
      return String(reason);
    }
  }
  return String(reason);
}

/** Drop player.entity when the entity is no longer in bot.entities. */
function pruneStalePlayerEntities(bot: Bot): void {
  const loaded = bot.entities ?? {};
  const players = bot.players ? Object.values(bot.players) : [];
  for (const player of players) {
    const entity = player.entity;
    if (!entity) continue;
    if (entity.id == null || loaded[entity.id] !== entity) {
      try {
        (player as { entity?: unknown }).entity = undefined;
      } catch {
        /* ignore */
      }
    }
  }
}

function summarizeDump(dump: WorldDump): string {
  const pos = dump.position
    ? `${dump.position.x}, ${dump.position.y}, ${dump.position.z}`
    : "?";
  const portals = dump.portals.length
    ? dump.portals
        .slice(0, 5)
        .map((p) => `${p.blockName}@${p.position.x},${p.position.y},${p.position.z} (${p.distance.toFixed(1)}m)`)
        .join("; ")
    : "none";
  const island = dump.island
    ? `island solid=${dump.island.solid} water=${dump.island.water} yes=${dump.island.looksLikeIsland}`
    : "island=?";
  return `Spawn ${pos} dim=${dump.dimension ?? "?"} kind=${dump.worldKind} gm=${dump.gameMode ?? "?"} border=${dump.worldBorderDiameter ?? "?"} ${island} blocks=${topBlockCounts(dump.nearbyCounts)} portals=${portals}`;
}

