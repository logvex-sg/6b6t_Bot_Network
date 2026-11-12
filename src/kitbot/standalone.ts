/**
 * Standalone kit bot.
 *
 * A single process that connects one mineflayer bot to 6b6t, walks the lobby, and serves kits to players
 * who type a chat prefix. Everything is controlled from a small web page it hosts on loopback — no config
 * files to hand-edit, no control-API/fleet/daemon machinery.
 *
 * It reuses the same tested pieces the full client uses:
 *   - `attachAuth`            — the in-game `/login` handshake
 *   - `createPortalNavigator` — the lobby portal walk (so it reaches the survival world)
 *   - `KitBotController`      — the serve path and every guard rail
 *   - `attachProtocolCompat` / `attachAnarchyMod` — chat/NBT safety
 *
 * Run:  npm run kibot        (then open the printed URL)
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import mineflayer, { type Bot } from "mineflayer";
import { log } from "../logger.ts";
import { settingsDir } from "../settings/store.ts";
import { pathfinder } from "../minecraft/pathfinder.ts";
import { attachAnarchyMod } from "../minecraft/anarchyMod.ts";
import { attachAuth, type AuthController } from "../minecraft/auth.ts";
import { attachProtocolCompat, patchPrismarineChatBigInt } from "../minecraft/protocolCompat.ts";
import { createPortalNavigator, type PortalNavigator } from "../minecraft/lobby/navigator.ts";
import { classifyWorld, isMainWorld } from "../minecraft/lobby/worldKind.ts";
import { KitBotController } from "./controller.ts";
import { DEFAULT_KITBOT_CONFIG, type KitBotConfig } from "./kit.ts";
import type { WorldKind } from "../api/types.ts";

// Patch prismarine-chat before any bot connects (same as the main client).
patchPrismarineChatBigInt();

interface StandaloneConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  version: string;
  autoLobby: boolean;
  requiredServerPortals: number;
  kit: KitBotConfig;
}

const CONFIG_PATH = () => path.join(settingsDir(), "kitbot-standalone.json");

const DEFAULT_CONFIG: StandaloneConfig = {
  host: "alt3.6b6t.org",
  port: 25565,
  username: "",
  password: "",
  version: "1.21.11",
  autoLobby: true,
  requiredServerPortals: 2,
  kit: DEFAULT_KITBOT_CONFIG,
};

/** Load the standalone config, ignoring a corrupt file rather than refusing to start. */
function loadConfig(): StandaloneConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StandaloneConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      kit: { ...DEFAULT_KITBOT_CONFIG, ...(parsed.kit ?? {}) },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Atomic write so a crash mid-save cannot leave a half-written config. */
function saveConfig(config: StandaloneConfig): void {
  const file = CONFIG_PATH();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** What the GUI is allowed to change about the kit config. */
function mergeKitConfig(base: KitBotConfig, patch: Partial<KitBotConfig>): KitBotConfig {
  const merged = { ...base, ...patch };
  if (!Array.isArray(merged.kits) || merged.kits.length === 0) merged.kits = DEFAULT_KITBOT_CONFIG.kits;
  if (!merged.prefix) merged.prefix = DEFAULT_KITBOT_CONFIG.prefix;
  return merged;
}

class StandaloneKitBot {
  private config: StandaloneConfig;
  private bot: Bot | null = null;
  private controller: KitBotController;
  private auth: AuthController | null = null;
  private navigator: PortalNavigator | null = null;
  private worldTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private authenticated = false;
  private serverPortalsEntered = 0;
  private worldKind: WorldKind = "unknown";
  private kitActive = false;
  private wantConnected = false;
  private lastError: string | null = null;
  private events: string[] = [];

  constructor(config: StandaloneConfig) {
    this.config = config;
    this.controller = new KitBotController(
      {
        requireBot: () => this.requireBot(),
        chat: (message) => {
          try {
            this.bot?.chat(message);
          } catch {
            /* ignore */
          }
        },
        selfUsername: () => this.bot?.username ?? this.config.username,
        onEvent: (event) => this.note(`${event.kind}: ${event.username}${event.kit ? ` (${event.kit})` : ""}${event.detail ? ` — ${event.detail}` : ""}`),
      },
      config.kit,
    );
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  connect(patch?: Partial<StandaloneConfig>): string {
    if (patch) {
      this.config = { ...this.config, ...patch, kit: mergeKitConfig(this.config.kit, patch.kit ?? {}) };
    }
    if (!this.config.username) return "username is required";
    if (!this.config.password) return "in-game password is required";
    saveConfig(this.config);
    this.controller.setConfig(this.config.kit);
    this.wantConnected = true;
    if (this.bot) return "already connected";
    this.spawn();
    return `connecting to ${this.config.host}:${this.config.port} as ${this.config.username}`;
  }

  disconnect(): string {
    this.wantConnected = false;
    this.kitActive = false;
    this.teardown();
    return "disconnected";
  }

  private spawn(): void {
    this.teardown();
    this.authenticated = false;
    this.serverPortalsEntered = 0;
    this.worldKind = "unknown";
    let bot: Bot;
    try {
      bot = mineflayer.createBot({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        auth: "offline",
        version: this.config.version || undefined,
        brand: "fabric",
        hideErrors: true,
        checkTimeoutInterval: 45_000,
        keepAlive: true,
        viewDistance: 6,
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.note(`connect failed: ${this.lastError}`);
      this.scheduleReconnect();
      return;
    }
    this.bot = bot;
    bot.loadPlugin(pathfinder);
    attachAnarchyMod(bot);
    attachProtocolCompat(bot);

    this.auth = attachAuth(bot, this.config.password, () => {
      this.authenticated = true;
      this.note("authenticated (in-game /login)");
      if (this.config.autoLobby) this.navigator?.start();
    });

    this.navigator = createPortalNavigator(bot, 60_000, {
      onFound: (portal) => this.note(`portal found ${portal.kind}`),
      onEntered: (portal) => {
        this.serverPortalsEntered += 1;
        this.note(`entered portal ${this.serverPortalsEntered}/${this.config.requiredServerPortals} (${portal.kind})`);
        setTimeout(() => {
          if (this.bot && this.config.autoLobby && !isMainWorld(this.worldKind) && this.serverPortalsEntered < this.config.requiredServerPortals) {
            this.navigator?.start();
          }
        }, 1200);
      },
      onMiss: (reason) => this.note(`portal miss: ${reason}`),
      getWorldKind: () => this.worldKind,
      allowServerPortals: () =>
        this.config.autoLobby &&
        this.authenticated &&
        this.serverPortalsEntered < this.config.requiredServerPortals &&
        !isMainWorld(this.worldKind),
    });

    const emitChat = (raw: unknown) => {
      let text = "";
      try {
        text = typeof raw === "string" ? raw : (raw as { toString?: () => string })?.toString?.() ?? String(raw ?? "");
      } catch {
        text = "";
      }
      if (!text) return;
      if (this.kitActive) {
        void this.controller.handleChat(text).catch((error) => {
          log.warn("[kibot] chat handler failed", error instanceof Error ? error.message : error);
        });
      }
    };
    bot.on("messagestr", (m) => emitChat(m));
    bot.on("message", (m) => emitChat(m));

    bot.once("spawn", () => this.note("spawned"));
    bot.on("kicked", (reason) => this.note(`kicked: ${String(reason).slice(0, 160)}`));
    bot.on("error", (error) => this.note(`error: ${error instanceof Error ? error.message : String(error)}`));
    bot.on("end", (reason) => {
      this.note(`disconnected: ${reason ?? "unknown"}`);
      this.teardown();
      if (this.wantConnected) this.scheduleReconnect();
    });

    // Keep the world classification fresh so the lobby navigator knows when to stop.
    this.worldTimer = setInterval(() => this.tickWorld(), 1000);
  }

  private tickWorld(): void {
    const bot = this.bot;
    if (!bot?.entity) return;
    try {
      const previous = this.worldKind;
      this.worldKind = classifyWorld(bot, {
        authenticated: this.authenticated,
        serverPortalsEntered: this.serverPortalsEntered,
        requiredServerPortals: this.config.requiredServerPortals,
      });
      if (previous !== this.worldKind) this.note(`world: ${previous} → ${this.worldKind}`);
      if (isMainWorld(this.worldKind) && !isMainWorld(previous)) {
        this.note("reached the main world");
        this.navigator?.stop();
      }
    } catch {
      /* classification is best-effort */
    }
  }

  private scheduleReconnect(): void {
    if (!this.wantConnected || this.reconnectTimer) return;
    this.note("reconnecting in 8s");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wantConnected && !this.bot) this.spawn();
    }, 8000);
  }

  private teardown(): void {
    if (this.worldTimer) {
      clearInterval(this.worldTimer);
      this.worldTimer = null;
    }
    try {
      this.navigator?.stop();
    } catch {
      /* ignore */
    }
    try {
      this.auth?.destroy();
    } catch {
      /* ignore */
    }
    try {
      this.bot?.removeAllListeners();
      this.bot?.quit?.();
    } catch {
      /* ignore */
    }
    this.bot = null;
    this.auth = null;
    this.navigator = null;
  }

  private requireBot(): Bot {
    if (!this.bot) throw new Error("not connected");
    return this.bot;
  }

  // ── kit control ──────────────────────────────────────────────────────────

  startKit(patch?: Partial<KitBotConfig>): string {
    if (!this.bot?.entity) return "not connected — connect first";
    if (patch) {
      this.config.kit = mergeKitConfig(this.config.kit, patch);
      this.controller.setConfig(this.config.kit);
      saveConfig(this.config);
    }
    this.kitActive = true;
    return `kit bot active — players type "${this.controller.getConfig().prefix}kit"`;
  }

  stopKit(): string {
    if (!this.kitActive) return "kit bot not running";
    this.kitActive = false;
    return "kit bot stopped";
  }

  async serve(username: string, kit?: string): Promise<string> {
    const outcome = await this.controller.serve(username, kit);
    if (outcome.ok) return `served ${kit ?? this.controller.getConfig().defaultKit} to ${username} (${outcome.dropped} items)`;
    return `could not serve ${username}: ${outcome.message ?? outcome.reason ?? "unknown reason"}`;
  }

  setKitConfig(patch: Partial<KitBotConfig>): string {
    this.config.kit = mergeKitConfig(this.config.kit, patch);
    this.controller.setConfig(this.config.kit);
    saveConfig(this.config);
    return "kit config updated";
  }

  private note(message: string): void {
    const line = `${new Date().toISOString().slice(11, 19)}  ${message}`;
    this.events.push(line);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
    log.info(`[kibot] ${message}`);
  }

  status(): Record<string, unknown> {
    const bot = this.bot;
    const pos = bot?.entity?.position;
    const cfg = this.controller.getConfig();
    return {
      connected: Boolean(bot?.entity),
      authenticated: this.authenticated,
      world: this.worldKind,
      username: bot?.username ?? this.config.username,
      health: bot?.health ?? null,
      food: bot?.food ?? null,
      position: pos ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } : null,
      kitActive: this.kitActive,
      kit: {
        prefix: cfg.prefix,
        cooldownMs: cfg.cooldownMs,
        maxDistance: cfg.maxDistance,
        announce: cfg.announce,
        walkToPlayer: cfg.walkToPlayer,
        blacklist: cfg.blacklist,
        kits: cfg.kits.map((k) => k.name),
        served: this.controller.status().servedTotal,
        lastMinute: this.controller.status().servedLastMinute,
        onCooldown: this.controller.status().playersOnCooldown,
      },
      stock: this.bot?.entity ? this.controller.stockSummary() : "not connected",
      connection: { host: this.config.host, port: this.config.port, username: this.config.username, version: this.config.version },
      lastError: this.lastError,
      events: this.events.slice(-40),
    };
  }
}

// ── HTTP GUI ───────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const bot = new StandaloneKitBot(config);
  const port = Number(process.env.KITBOT_PORT || 37777);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/rpc") {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid JSON" }));
        return;
      }
      const result = await handleRpc(bot, body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  server.listen(port, "127.0.0.1", () => {
    log.info(`Kit bot control page: http://127.0.0.1:${port}`);
    console.log(`\n  Kit bot running. Open:  http://127.0.0.1:${port}\n`);
  });

  const shutdown = () => {
    bot.disconnect();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function handleRpc(bot: StandaloneKitBot, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const action = String(body.action ?? "");
  try {
    switch (action) {
      case "status":
        return { ok: true, data: bot.status() };
      case "connect":
        return { ok: true, data: { result: bot.connect(body.config as Partial<StandaloneConfig> | undefined), status: bot.status() } };
      case "disconnect":
        return { ok: true, data: { result: bot.disconnect(), status: bot.status() } };
      case "start":
        return { ok: true, data: { result: bot.startKit(body.kitConfig as Partial<KitBotConfig> | undefined), status: bot.status() } };
      case "stop":
        return { ok: true, data: { result: bot.stopKit(), status: bot.status() } };
      case "config":
        return { ok: true, data: { result: body.kitConfig ? bot.setKitConfig(body.kitConfig as Partial<KitBotConfig>) : "current config", status: bot.status() } };
      case "serve":
        return { ok: true, data: { result: await bot.serve(String(body.username ?? ""), body.kit as string | undefined), status: bot.status() } };
      case "stock":
        return { ok: true, data: { result: bot.status().stock, status: bot.status() } };
      default:
        return { ok: false, error: `unknown action: ${action}` };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kit Bot</title>
<style>
  :root{--bg:#0e1116;--panel:#161b22;--line:#243040;--bone:#e8eef7;--mute:#8b98a9;--accent:#4cc2ff;--ok:#39d98a;--warn:#ffb84d;--bad:#ff5c7a}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--bone);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
  header{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px}
  h1{font-size:16px;margin:0;font-weight:600}
  .pill{border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute)}
  .pill.on{border-color:var(--ok);color:var(--ok)}
  main{padding:18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;max-width:1100px;margin:0 auto}
  section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--mute);margin:0 0 12px}
  label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--mute);margin-bottom:8px}
  input{background:#0b0e13;border:1px solid var(--line);border-radius:6px;color:var(--bone);padding:7px 9px;font-size:13px}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  button{background:#1d2735;border:1px solid var(--line);border-radius:6px;color:var(--bone);padding:7px 13px;cursor:pointer;font-size:13px}
  button:hover{border-color:var(--accent)}
  button.primary{background:#12384d;border-color:var(--accent);color:#cdeeff}
  button.danger{border-color:var(--bad);color:#ffc3d0}
  .chk{flex-direction:row;align-items:center;gap:6px}
  dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0;font-size:13px}
  dt{color:var(--mute)}dd{margin:0;font-variant-numeric:tabular-nums}
  pre{background:#0b0e13;border:1px solid var(--line);border-radius:6px;padding:10px;font-size:12px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:10px 0 0}
  .out{color:var(--accent);min-height:18px;font-size:12px;margin-top:8px}
</style></head><body>
<header>
  <h1>Kit Bot</h1>
  <span id="conn" class="pill">disconnected</span>
  <span id="auth" class="pill">no auth</span>
  <span id="world" class="pill">world ?</span>
  <span id="kit" class="pill">kit off</span>
</header>
<main>
  <section>
    <h2>Connection</h2>
    <label>Host <input id="host"></label>
    <div class="row">
      <label style="flex:1">Port <input id="port" type="number"></label>
      <label style="flex:2">Username <input id="username"></label>
    </div>
    <label>In-game password <input id="password" type="password"></label>
    <label>Version <input id="version"></label>
    <div class="row">
      <button id="btn-connect" class="primary">Connect</button>
      <button id="btn-disconnect" class="danger">Disconnect</button>
    </div>
    <div id="conn-out" class="out"></div>
  </section>

  <section>
    <h2>Kit bot</h2>
    <div class="row">
      <button id="btn-start" class="primary">Start serving</button>
      <button id="btn-stop">Stop</button>
      <button id="btn-stock">Stock</button>
    </div>
    <h2 style="margin-top:14px">Kit settings</h2>
    <div class="row">
      <label style="flex:1">Prefix <input id="prefix"></label>
      <label style="flex:1">Cooldown (s) <input id="cooldown" type="number"></label>
      <label style="flex:1">Distance <input id="distance" type="number"></label>
    </div>
    <div class="row">
      <label class="chk"><input id="announce" type="checkbox"> Announce</label>
      <label class="chk"><input id="walk" type="checkbox"> Walk to player</label>
    </div>
    <label>Blacklist (comma-separated) <input id="blacklist"></label>
    <button id="btn-save">Save settings</button>
    <h2 style="margin-top:14px">Give a kit now</h2>
    <div class="row">
      <label style="flex:2">Player <input id="give-player"></label>
      <label style="flex:1">Kit <input id="give-kit" placeholder="default"></label>
      <button id="btn-give" style="align-self:flex-end">Give</button>
    </div>
    <div id="kit-out" class="out"></div>
  </section>

  <section>
    <h2>Status</h2>
    <dl id="status"></dl>
    <pre id="log"></pre>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
async function rpc(action, extra = {}) {
  const res = await fetch("/api/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
  return res.json();
}
function setPill(el, on, text) { el.textContent = text; el.classList.toggle("on", !!on); }
function fillForm(c) {
  if (!c) return;
  if (document.activeElement === $("password")) return;
  $("host").value = c.host ?? ""; $("port").value = c.port ?? ""; $("username").value = c.username ?? ""; $("version").value = c.version ?? "";
}
function fillKit(k) {
  if (!k) return;
  if (document.activeElement !== $("prefix")) $("prefix").value = k.prefix ?? "";
  if (document.activeElement !== $("cooldown")) $("cooldown").value = k.cooldownMs != null ? k.cooldownMs / 1000 : "";
  if (document.activeElement !== $("distance")) $("distance").value = k.maxDistance ?? "";
  if (document.activeElement !== $("blacklist")) $("blacklist").value = (k.blacklist || []).join(", ");
  $("announce").checked = !!k.announce; $("walk").checked = !!k.walkToPlayer;
}
let seeded = false;
async function refresh() {
  const body = await rpc("status");
  if (!body.ok) return;
  const d = body.data;
  setPill($("conn"), d.connected, d.connected ? "connected" : "disconnected");
  setPill($("auth"), d.authenticated, d.authenticated ? "authed" : "no auth");
  setPill($("world"), d.world && d.world !== "unknown", d.world || "world ?");
  setPill($("kit"), d.kitActive, d.kitActive ? "kit on" : "kit off");
  $("status").innerHTML = [
    ["user", d.username || "—"], ["health", d.health ?? "—"], ["food", d.food ?? "—"],
    ["position", d.position ? d.position.x + "," + d.position.y + "," + d.position.z : "—"],
    ["kits", (d.kit && d.kit.kits || []).join(", ") || "—"],
    ["served", d.kit ? d.kit.served : 0], ["last min", d.kit ? d.kit.lastMinute : 0],
    ["on cooldown", d.kit ? d.kit.onCooldown : 0], ["stock", d.stock || "—"],
  ].map(([k, v]) => "<dt>" + k + "</dt><dd>" + v + "</dd>").join("");
  $("log").textContent = (d.events || []).join("\\n");
  if (!seeded) { fillForm(d.connection); fillKit(d.kit); seeded = true; }
}
async function run(action, extra, outEl, label) {
  if (outEl) outEl.textContent = "…";
  const body = await rpc(action, extra);
  const text = body.ok ? (body.data.result || label || "ok") : ("error: " + body.error);
  if (outEl) outEl.textContent = text;
  await refresh();
}
$("btn-connect").onclick = () => run("connect", { config: {
  host: $("host").value, port: Number($("port").value), username: $("username").value,
  password: $("password").value, version: $("version").value } }, $("conn-out"), "connecting");
$("btn-disconnect").onclick = () => run("disconnect", {}, $("conn-out"), "disconnected");
$("btn-start").onclick = () => run("start", {}, $("kit-out"), "started");
$("btn-stop").onclick = () => run("stop", {}, $("kit-out"), "stopped");
$("btn-stock").onclick = () => run("stock", {}, $("kit-out"), "stock");
$("btn-save").onclick = () => run("config", { kitConfig: {
  prefix: $("prefix").value, cooldownMs: Math.max(0, Number($("cooldown").value || 0)) * 1000,
  maxDistance: Math.max(0, Number($("distance").value || 0)), announce: $("announce").checked,
  walkToPlayer: $("walk").checked,
  blacklist: $("blacklist").value.split(",").map(s => s.trim()).filter(Boolean) } }, $("kit-out"), "saved");
$("btn-give").onclick = () => run("serve", { username: $("give-player").value, kit: $("give-kit").value || undefined }, $("kit-out"), "served");
refresh();
setInterval(refresh, 2000);
</script></body></html>`;

void main();
