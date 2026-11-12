import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";

export type BotPhase =
  | "idle"
  | "connecting"
  | "authenticating"
  | "lobby"
  | "in_game"
  | "reconnecting"
  | "disconnected";

export type WorldKind = "unknown" | "auth" | "lobby" | "backup" | "overworld" | "nether" | "end";

export type PortalKind = "server" | "nether" | "end" | "unknown";

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface JoinOptions {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  version?: string;
  autoReconnect?: boolean;
  autoLobby?: boolean;
}

export interface ControlState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sneak: boolean;
  sprint: boolean;
}

export interface InventorySlot {
  slot: number;
  name: string;
  count: number;
  displayName: string;
  stackSize?: number;
  durabilityUsed?: number;
  maxDurability?: number;
  customName?: string | null;
}

export type EquipmentDest = "hand" | "off-hand" | "head" | "torso" | "legs" | "feet";

export type InvOp =
  | "hold"
  | "drop"
  | "dropStack"
  | "equip"
  | "unequip"
  | "use"
  | "swap"
  /** Left-click a slot in the currently open container window (e.g. /homes GUI). */
  | "windowClick"
  /** Close the currently open container window. */
  | "windowClose";

/** Open container / chest / /homes GUI (when bot.currentWindow is set). */
export interface OpenWindowView {
  id: number;
  title: string;
  type?: string;
  /** Container slots only (not the player inventory portion of the combined window). */
  slots: InventorySlot[];
  /** First slot index that belongs to the player inventory inside this window. */
  inventoryStart: number;
}

/** 1.21+ multi_action dialog (6b6t /homes) — not a container window. */
export interface HomesDialogView {
  title: string;
  /** Home names as button labels from the dialog. */
  homes: string[];
}

export interface InventoryView {
  quickBarSlot: number;
  held: InventorySlot | null;
  slots: InventorySlot[];
  /** Present when a classic container GUI is open. */
  window?: OpenWindowView | null;
  /** Present when the server sent a Homes multi_action dialog (6b6t). */
  homesDialog?: HomesDialogView | null;
  /** Cached home names known to this bot session. */
  homes?: string[];
}

export interface InvCommand {
  op: InvOp;
  slot?: number;
  to?: number;
  dest?: EquipmentDest;
  count?: number;
  /** mouseButton for windowClick: 0 = left, 1 = right (default 0). */
  mouseButton?: number;
}

export interface PlayerInfo {
  username: string;
  uuid?: string;
  /** Skin texture URL from server profile (works for cracked / SkinRestorer). */
  skinUrl?: string;
  ping?: number;
  gamemode?: string;
  distance?: number;
  position?: Vec3Like;
  yaw?: number;
}

export interface BotStatus {
  phase: BotPhase;
  connected: boolean;
  username: string;
  /** Own skin texture URL when the server sent one (cracked skins included). */
  skinUrl?: string;
  host: string;
  port: number;
  version?: string;
  dimension?: string;
  worldKind: WorldKind;
  authenticated: boolean;
  serverPortalsEntered: number;
  requiredServerPortals: number;
  position?: Vec3Like;
  yaw?: number;
  pitch?: number;
  onGround?: boolean;
  gameMode?: string;
  control: ControlState;
  health?: number;
  food?: number;
  ping?: number;
  players: number;
  uptimeMs: number;
  lastKick?: string;
  lastKickKind?:
    | "captcha"
    | "rate-limit"
    | "verification-expired"
    | "premium-name"
    | "account-limit"
    | "wrong-password"
    | "version-mismatch"
    | "ddos-blocked"
    | "too-fast"
    | "already-online"
    | "backend-unreachable"
    | "connection-error"
    | "other";
  lastKickHint?: string;
  lastKickLinks?: string[];
  lastVerificationCode?: string;
  /** Microsoft device-code flow (user_code + verification_uri). */
  msaCode?: MsaDeviceCode | null;
  lastError: BotErrorInfo | null;
  lastChat?: string;
  autoReconnect: boolean;
  autoLobby: boolean;
  huntingPortal: boolean;
  /** Elytra mapper snapshot. */
  mapping?: unknown;
  /** Base-hunting controller snapshot, or null when hunting has never started. */
  hunt?: unknown;
  /** Kit-bot snapshot, or null when the kit bot has never started. */
  kitBot?: unknown;
}

/** Payload from prismarine-auth / mineflayer onMsaCode. */
export interface MsaDeviceCode {
  user_code: string;
  verification_uri: string;
  message?: string;
  expires_in?: number;
  interval?: number;
  at?: string;
}

export type BotErrorSource = "connect" | "kick" | "disconnect" | "socket";

export interface BotErrorInfo {
  at: string;
  source: BotErrorSource;
  message: string;
  code?: string;
}

export interface PortalTarget {
  kind: PortalKind;
  position: Vec3Like;
  distance: number;
  blockName: string;
}

export interface WorldDump {
  at: string;
  dimension?: string;
  worldKind: WorldKind;
  gameMode?: string;
  position?: Vec3Like;
  yaw?: number;
  pitch?: number;
  worldBorderDiameter?: number | null;
  nearbyCounts: Record<string, number>;
  portals: PortalTarget[];
  island?: {
    solid: number;
    water: number;
    airish: number;
    looksLikeIsland: boolean;
  };
  asciiMap: string;
}

export interface BlockInfo {
  x: number;
  y: number;
  z: number;
  name: string;
}

export interface EntityInfo {
  id?: number;
  name: string;
  kind: string;
  position: Vec3Like;
  yaw?: number;
  pitch?: number;
  distance?: number;
}

export interface LookInfo {
  yaw: number;
  pitch: number;
  target: BlockInfo | null;
  entity: EntityInfo | null;
}

export type PlaceFace = "up" | "down" | "north" | "south" | "east" | "west";

export interface Surroundings {
  at: string;
  status: BotStatus;
  look: LookInfo;
  held: InventorySlot | null;
  players: PlayerInfo[];
  entities: EntityInfo[];
  portals: PortalTarget[];
  voxels: VoxelField;
  map?: string;
}

export interface ApiRoute {
  method: "GET" | "POST" | "WS";
  path: string;
  auth: boolean;
  action?: string;
  desc: string;
  body?: Record<string, unknown>;
}

export interface VoxelEntity {
  name: string;
  kind: "bot" | "player";
  x: number;
  y: number;
  z: number;
  yaw?: number;
}

export interface VoxelField {
  at: string;
  ox: number;
  oy: number;
  oz: number;
  sx: number;
  sy: number;
  sz: number;
  palette: string[];
  cells: number[];
  entities: VoxelEntity[];
}

export interface ChatEvent {
  raw: string;
  ansi?: string;
  json?: unknown;
  timestamp: number;
}

export interface FractalBotEvents {
  phase: (phase: BotPhase) => void;
  connecting: (info: { host: string; port: number; username: string }) => void;
  connected: () => void;
  spawned: (dump: WorldDump) => void;
  authenticated: () => void;
  chat: (event: ChatEvent) => void;
  /** Fired on every kick. Includes classification and any extracted captcha / verification links. */
  kicked: (info: {
    reason: string;
    kind: string;
    links: string[];
    verificationCode?: string;
  }) => void;
  disconnected: (reason?: string) => void;
  error: (error: Error) => void;
  status: (status: BotStatus) => void;
  portalFound: (portal: PortalTarget) => void;
  portalEntered: (info: { kind: PortalKind; count: number }) => void;
  lobbyRetry: (info: { inMs: number; reason: string }) => void;
  worldKind: (kind: WorldKind) => void;
  detection: (event: DetectionEvent) => void;
  /** Microsoft device code ready for the user to enter at verification_uri. */
  msaCode: (code: MsaDeviceCode) => void;
  /** Base-hunting notification (stash found, emergency, …). */
  huntNotification: (notification: unknown) => void;
  /** Kit-bot activity (served, denied, out of stock, …). */
  kitBotEvent: (event: unknown) => void;
}

export type DetectionKind =
  | "player_enter"
  | "player_leave"
  | "crystal_spawn"
  | "crystal_gone"
  | "tnt_spawn"
  | "tnt_gone"
  | "explosion"
  | "attacked"
  | "hurt"
  | "death";

export interface DetectionEvent {
  id: string;
  at: string;
  kind: DetectionKind;
  label: string;
  message: string;
  /** Player name when the event is about a person */
  username?: string;
  /** Server-provided skin texture (cracked skins included) */
  skinUrl?: string;
  position?: { x: number; y: number; z: number };
  distance?: number;
  /** World at the time of the event (lobby/auth/backup vs main). */
  worldKind?: WorldKind;
}

export type ControlRequest =
  | { action: "join"; options?: JoinOptions }
  | { action: "leave"; reason?: string }
  | { action: "reconnect" }
  | { action: "chat"; message: string }
  | { action: "command"; command: string }
  | { action: "goto"; x: number; y: number; z: number; range?: number }
  | { action: "lookAt"; x: number; y: number; z: number }
  | { action: "look"; yaw?: number; pitch?: number; x?: number; y?: number; z?: number; force?: boolean }
  | { action: "turn"; yaw?: number; pitch?: number }
  | { action: "control"; state: Partial<ControlState> }
  | { action: "jump" }
  | { action: "stop" }
  | { action: "attack"; username?: string }
  | { action: "dig"; x?: number; y?: number; z?: number }
  | { action: "stopDig" }
  | { action: "place"; x?: number; y?: number; z?: number; face?: PlaceFace }
  | { action: "activate"; x?: number; y?: number; z?: number }
  | { action: "swing" }
  | { action: "respawn" }
  | { action: "status" }
  | { action: "players" }
  | { action: "detection" }
  | { action: "clearDetection" }
  | { action: "clearServerListener"; username?: string }
  | { action: "entities" }
  | { action: "inventory" }
  | ({ action: "inv" } & InvCommand)
  /** Minecraft tab-complete for the partial command (e.g. "home " or "home ba"). */
  | { action: "tabComplete"; partial: string }
  /** Locally known home names. */
  | { action: "homes" }
  /** Run /homes and wait for the GUI (or chat list). Returns inventory view. */
  | { action: "openHomes" }
  | { action: "dump" }
  | { action: "view"; radius?: number; map?: boolean }
  | { action: "voxels"; radius?: number }
  | { action: "map"; radius?: number }
  | { action: "block"; x: number; y: number; z: number }
  | { action: "cursor" }
  | { action: "hunt" }
  | { action: "unhunt" }
  | { action: "mapStart"; mode?: string }
  | { action: "mapStop" }
  | { action: "mapStatus" }
  | { action: "mapConfig"; mapping?: Record<string, unknown> }
  | { action: "huntStart"; huntConfig?: Record<string, unknown> }
  | { action: "huntStop" }
  | { action: "huntPause" }
  | { action: "huntResume" }
  | { action: "huntStatus" }
  | { action: "huntConfig"; huntConfig?: Record<string, unknown> }
  | { action: "huntRouteSet"; waypoints?: Array<{ x: number; z: number }> }
  | { action: "huntRouteList" }
  | { action: "huntRestock" }
  | { action: "elytraStatus" }
  | { action: "elytraReplace" }
  | { action: "mendingStatus" }
  | { action: "survivalStatus" }
  | { action: "echestStatus" }
  | { action: "webhookTest" }
  | { action: "stashList"; search?: { tier?: string; dimension?: string; minScore?: number; text?: string; limit?: number } }
  | { action: "stashNearby" }
  | { action: "playerList"; query?: string }
  | { action: "huntDatabaseExport" }
  | { action: "huntDatabaseImport"; document?: string }
  | { action: "kitBotStart"; kitConfig?: Record<string, unknown> }
  | { action: "kitBotStop" }
  | { action: "kitBotStatus" }
  | { action: "kitBotConfig"; kitConfig?: Record<string, unknown> }
  | { action: "kitBotServe"; username: string; kit?: string }
  | { action: "kitBotStock"; kit?: string }
  | { action: "kitBotResetCooldowns" }
  | { action: "getSettings" }
  | { action: "saveSettings"; values: Record<string, string> }
  | { action: "fleetStatus" }
  | { action: "fleetAccounts" }
  | {
      action: "fleetAddAccount";
      account: {
        id?: string;
        username: string;
        password?: string;
        auth?: "offline" | "microsoft";
        host?: string;
        port?: number;
        label?: string;
        enabled?: boolean;
        task?: "idle" | "join" | "hunt" | "map" | "leave";
        taskOptions?: { mapMode?: string };
        features?: {
          online?: boolean;
          hunt?: boolean;
          map?: boolean;
          mapMode?: string;
          announcements?: boolean;
          antiAfk?: boolean;
        };
      };
    }
  | { action: "fleetRemoveAccount"; id: string }
  | { action: "fleetStart"; id: string }
  | { action: "fleetStop"; id: string }
  | { action: "fleetStartAll" }
  | { action: "fleetStopAll" }
  | {
      action: "fleetSetTask";
      id: string;
      task: "idle" | "join" | "hunt" | "map" | "leave";
      taskOptions?: { mapMode?: string };
    }
  | {
      action: "fleetSetFeatures";
      id: string;
      features: {
        online?: boolean;
        hunt?: boolean;
        map?: boolean;
        mapMode?: string;
                announcements?: boolean;
        antiAfk?: boolean;
      };
    }
  | {
      action: "fleetSetAnnouncements";
      announcements: { message: string; intervalMs: number }[];
    }
  | { action: "fleetMicrosoftAuth"; id: string }
  | { action: "set"; autoReconnect?: boolean; autoLobby?: boolean }
  | { action: "catalog" };

/** Optional target bot for single-bot RPC when fleet has many accounts */
export type ControlRequestWithBot = ControlRequest & { botId?: string };

export interface ControlResponse {
  ok: boolean;
  error?: string;
  data?: unknown;
}

export interface LiveBot {
  raw: Bot;
  position(): Vec3 | undefined;
}
