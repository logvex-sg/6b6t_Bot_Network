/**
 * Optional Discord remote control for Fractal.
 * Opt-in via DISCORD_ENABLED=1 + DISCORD_TOKEN + DISCORD_CHANNEL_ID.
 * discord.js is loaded lazily so installs without Discord stay light.
 */
import { createRequire } from "node:module";
import { log } from "../logger.ts";
import type { FractalBot } from "../api/FractalBot.ts";

const require = createRequire(import.meta.url);

export interface DiscordControlOptions {
  token: string;
  channelId: string;
  /** Prefix for commands, default "!" */
  prefix?: string;
  /** Mirror bot logs into the channel */
  mirrorLogs?: boolean;
  /** Fallback profile label when none is provided (primary bot). */
  defaultProfile?: string;
}

export interface DiscordControl {
  start(): void;
  stop(): void;
  /** Queue a line for batched send to the control channel */
  log(text: string, profile?: string): void;
  /** Mirror a structured fleet/bot event with profile tag */
  mirrorEvent(profile: string, event: string, args?: unknown[]): void;
}

export function createDiscordControl(bot: FractalBot, options: DiscordControlOptions): DiscordControl {
  let Client: new (opts: unknown) => {
    on: (e: string, fn: (...args: unknown[]) => void) => void;
    once: (e: string, fn: (...args: unknown[]) => void) => void;
    login: (token: string) => Promise<unknown>;
    destroy: () => void;
    user?: { tag?: string };
    channels: { cache: { get: (id: string) => { send: (t: string) => Promise<unknown> } | undefined } };
  };
  let GatewayIntentBits: { Guilds: number; GuildMessages: number; MessageContent: number };

  try {
    const discord = require("discord.js") as {
      Client: typeof Client;
      GatewayIntentBits: typeof GatewayIntentBits;
    };
    Client = discord.Client;
    GatewayIntentBits = discord.GatewayIntentBits;
  } catch {
    throw new Error(
      'DISCORD_ENABLED is set but "discord.js" is not installed. Run: npm install discord.js',
    );
  }

  const prefix = options.prefix ?? "!";
  const channelId = options.channelId;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  let buffer: string[] = [];
  let flushScheduled = false;
  const LIMIT = 1900;

  const flush = () => {
    flushScheduled = false;
    if (!buffer.length) return;
    const ch = client.channels.cache.get(channelId);
    const lines = buffer;
    buffer = [];
    if (!ch) return;
    let cur = "";
    const chunks: string[] = [];
    for (const l of lines) {
      const cand = cur ? `${cur}\n${l}` : l;
      if (cand.length > LIMIT) {
        if (cur) chunks.push(cur);
        cur = l.slice(0, LIMIT);
      } else cur = cand;
    }
    if (cur) chunks.push(cur);
    for (const t of chunks) {
      ch.send(t).catch((err: Error) => log.warn(`[discord] send failed: ${err.message}`));
    }
  };

  const defaultProfile =
    String(options.defaultProfile || bot.getStatus()?.username || "bot").trim() || "bot";

  const formatLine = (text: string, profile?: string) => {
    const tag = String(profile || defaultProfile).trim() || defaultProfile;
    const body = String(text ?? "").trim();
    if (!body) return "";
    // Avoid double-prefix if caller already tagged
    if (/^\[[^\]]+\]\s/.test(body)) return body;
    return `[${tag}] ${body}`;
  };

  const queueLog = (text: string, profile?: string) => {
    if (!options.mirrorLogs) return;
    const line = formatLine(text, profile);
    if (!line) return;
    buffer.push(line);
    if (!flushScheduled) {
      flushScheduled = true;
      setTimeout(flush, 4000);
    }
  };

  const mirrorEvent = (profile: string, event: string, args?: unknown[]) => {
    if (!options.mirrorLogs) return;
    const a0 = args?.[0];
    switch (event) {
      case "phase":
        queueLog(`phase → ${String(a0 ?? "")}`, profile);
        break;
      case "worldKind":
        queueLog(`world → ${String(a0 ?? "")}`, profile);
        break;
      case "connected":
        queueLog("connected", profile);
        break;
      case "disconnected":
        queueLog(`disconnected${a0 ? `: ${String(a0).slice(0, 120)}` : ""}`, profile);
        break;
      case "authenticated":
        queueLog("authenticated", profile);
        break;
      case "portalFound": {
        const p = a0 as { position?: { x?: number; y?: number; z?: number }; distance?: number } | undefined;
        const pos = p?.position;
        queueLog(
          pos
            ? `portal found @ ${Number(pos.x).toFixed(0)},${Number(pos.y).toFixed(0)},${Number(pos.z).toFixed(0)} (${Number(p?.distance ?? 0).toFixed(1)}m)`
            : "portal found",
          profile,
        );
        break;
      }
      case "portalEntered": {
        const p = a0 as { count?: number } | undefined;
        queueLog(`portal entered (${p?.count ?? "?"})`, profile);
        break;
      }
      case "chat": {
        const c = a0 as { raw?: string } | string | undefined;
        const raw = typeof c === "string" ? c : c?.raw;
        if (raw) queueLog(`chat: ${String(raw).slice(0, 200)}`, profile);
        break;
      }
      case "detection": {
        const d = a0 as { kind?: string; username?: string; label?: string } | undefined;
        if (d?.kind) {
          queueLog(
            `detect ${d.kind}${d.username || d.label ? `: ${d.username || d.label}` : ""}`,
            profile,
          );
        }
        break;
      }
      case "huntNotification": {
        const n = a0 as { kind?: string; title?: string; body?: string; data?: Record<string, unknown> } | undefined;
        if (n?.title) {
          const where = n.data && typeof n.data.x === "number" ? ` @ ${n.data.x},${n.data.z}` : "";
          queueLog(`[hunt:${n.kind ?? "info"}] ${n.title}${where}${n.body ? ` — ${n.body}` : ""}`, profile);
          // Discovery/emergency alerts are worth a prompt flush rather than waiting for the batch window.
          if (n.kind === "emergency" || n.kind === "major-storage" || n.kind === "stash-discovery") {
            setTimeout(flush, 500);
          }
        }
        break;
      }
      case "kicked": {
        const info = a0 as { reason?: string; kind?: string; links?: string[] } | undefined;
        const kind = info?.kind || "kick";
        queueLog(`[${kind.toUpperCase()}] ${String(info?.reason || "").slice(0, 240)}`, profile);
        for (const link of info?.links || []) queueLog(link, profile);
        // Faster flush for kicks/captcha
        if (!flushScheduled) {
          flushScheduled = true;
          setTimeout(flush, 500);
        } else {
          setTimeout(flush, 500);
        }
        break;
      }
      case "msaCode":
        queueLog(`Microsoft device code: ${String(a0 ?? "")}`, profile);
        break;
      case "error":
        queueLog(`error: ${String(a0 ?? "").slice(0, 200)}`, profile);
        break;
      default:
        break;
    }
  };

  const replyHelp = () =>
    [
      "**Fractal Discord control**",
      `\`${prefix}status\` — bot + mapper status`,
      `\`${prefix}join\` / \`${prefix}leave\` / \`${prefix}reconnect\``,
      `\`${prefix}chat <msg>\` / \`${prefix}cmd <command>\``,
      `\`${prefix}hunt\` / \`${prefix}unhunt\` — lobby portals`,
      `\`${prefix}bh start [mode]\` — autonomous base hunting (spiral, grid, adaptive, direction)`,
      `\`${prefix}bh stop\` / \`${prefix}bh pause\` / \`${prefix}bh resume\``,
      `\`${prefix}bh status\` — phase, target, elytra, survival`,
      `\`${prefix}bh stash\` — nearest recorded stashes`,
      `\`${prefix}bh restock\` — restock from the nearest ender chest`,
      `\`${prefix}bh elytra [status|replace]\` — worn elytra durability / swap in a spare`,
      `\`${prefix}bh mending\` — damaged Mending gear, worst first`,
      `\`${prefix}bh survival\` — health, food, totems, fireworks, capacity`,
      `\`${prefix}bh echest\` — read the nearest ender chest`,
      `\`${prefix}bh route [set x,z …|list|clear]\` — custom waypoint route`,
      `\`${prefix}bh webhook\` — send a test notification`,
      `\`${prefix}kibot start [prefix] [cooldownSec] [distance]\` — serve kits on chat`,
      `\`${prefix}kibot stop\` / \`${prefix}kibot status\` / \`${prefix}kibot stock\``,
      `\`${prefix}kibot give <player> [kit]\` — hand a kit out now`,
      `\`${prefix}kibot config prefix ! cooldown 300 distance 24\``,
      `\`${prefix}map on [mode]\` — start elytra mapping (box, spawn, ring, north, …)`,
      `\`${prefix}map on box:x1,z1,x2,z2\` — map a box`,
      `\`${prefix}map off\` / \`${prefix}map status\``,
      `\`${prefix}captcha\` — last kick / captcha links / code`,
      `\`${prefix}help\` — this list`,
    ].join("\n");

  const handleCommand = async (sub: string, arg: string, reply: (t: string) => void) => {
    const s = sub.toLowerCase();

    // !map … namespace (Elytra-compatible)
    if (s === "map") {
      const parts = arg.trim().split(/\s+/);
      const mapSub = (parts[0] || "").toLowerCase();
      const mapArg = parts.slice(1).join(" ");
      if (mapSub === "on") {
        let mode = mapArg || "box";
        const bm = mode.match(/^box[:\s]+(-?\d+)[,\s]+(-?\d+)[,\s]+(-?\d+)[,\s]+(-?\d+)/i);
        if (bm) {
          bot.setMappingConfig({
            box: {
              x1: Number(bm[1]),
              z1: Number(bm[2]),
              x2: Number(bm[3]),
              z2: Number(bm[4]),
            },
          });
          mode = "box";
        }
        reply(bot.startMapping(mode));
        return;
      }
      if (mapSub === "off") {
        reply(bot.stopMapping());
        return;
      }
      if (mapSub === "status") {
        const st = bot.getMappingStatus();
        const m = (st.mapping || {}) as Record<string, unknown>;
        reply(
          `active=${st.active} state=${m.state ?? "?"} mode=${m.mode ?? "?"} covered=${m.covered ?? "?"}/${m.waypoints ?? "?"} out=${st.output?.dir ?? "?"}`,
        );
        return;
      }
      reply(`map commands: \`${prefix}map on [mode]\`, \`${prefix}map off\`, \`${prefix}map status\``);
      return;
    }

    switch (s) {
      case "help":
        reply(replyHelp());
        break;
      case "status": {
        const st = bot.getStatus();
        const map = bot.getMappingStatus();
        reply(
          [
            `phase=${st.phase} world=${st.worldKind} auth=${st.authenticated}`,
            `pos=${st.position ? `${st.position.x.toFixed(0)},${st.position.y.toFixed(0)},${st.position.z.toFixed(0)}` : "?"}`,
            `hp=${st.health ?? "?"} food=${st.food ?? "?"} players=${st.players}`,
            `mapping=${map.active ? "on" : "off"} lastKick=${st.lastKickKind ?? "none"}`,
            st.lastKick ? `kick: ${String(st.lastKick).slice(0, 200)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
        break;
      }
      case "join":
        await bot.join();
        reply("join requested");
        break;
      case "leave":
        await bot.leave("discord");
        reply("left");
        break;
      case "reconnect":
        await bot.reconnect();
        reply("reconnect requested");
        break;
      case "chat":
        if (!arg.trim()) {
          reply("usage: chat <message>");
          break;
        }
        bot.chat(arg);
        reply("sent");
        break;
      case "cmd":
        if (!arg.trim()) {
          reply("usage: cmd <command without slash>");
          break;
        }
        bot.runCommand(arg.replace(/^\//, ""));
        reply("command sent");
        break;
      case "hunt":
        bot.startPortalHunt();
        reply("portal hunt on");
        break;
      case "unhunt":
        bot.stopPortalHunt();
        reply("portal hunt off");
        break;
      case "bh": {
        const parts = arg.trim().split(/\s+/).filter(Boolean);
        const sub = (parts[0] || "status").toLowerCase();
        const rest = parts.slice(1).join(" ");
        if (sub === "start") {
          const mode = (rest || "spiral") as "spiral" | "grid" | "adaptive" | "direction";
          reply(await bot.startHunt({ mode }));
          break;
        }
        if (sub === "stop") {
          reply(bot.stopHunt());
          break;
        }
        if (sub === "pause") {
          reply(bot.pauseHunt());
          break;
        }
        if (sub === "resume") {
          reply(bot.resumeHunt());
          break;
        }
        if (sub === "restock") {
          reply(await bot.huntRestock());
          break;
        }
        if (sub === "elytra") {
          const action = (parts[1] || "status").toLowerCase();
          if (action === "replace") {
            reply(await bot.replaceElytra());
            break;
          }
          const s = bot.elytraStatus();
          reply(
            s
              ? `equipped=${s.equipped} remaining=${s.remaining} spares=${s.spares} bestSpare=${s.bestSpareRemaining}`
              : "not connected",
          );
          break;
        }
        if (sub === "mending") {
          const target = bot.mendingTarget();
          const rows = bot.mendingStatus();
          reply(
            rows.length
              ? [
                  target ? `target: ${target.name} (${target.remaining}/${target.maxDamage})` : "target: none",
                  ...rows.map((c) => `${c.name} slot ${c.slot} ${c.remaining}/${c.maxDamage}`),
                ].join("\n")
              : "nothing needs mending",
          );
          break;
        }
        if (sub === "survival") {
          const snap = bot.survivalStatus();
          reply(
            snap
              ? `health=${snap.health} food=${snap.food} elytra=${snap.elytraRemaining} totems=${snap.totems} food-items=${snap.foodItems} fireworks=${snap.fireworks} free=${snap.freeSlots}`
              : "not connected",
          );
          break;
        }
        if (sub === "echest") {
          const result = await bot.echestStatus();
          reply(`${result.ok ? "ok" : "failed"}: ${result.result}${result.items != null ? ` (${result.items} slots)` : ""}`);
          break;
        }
        if (sub === "webhook") {
          reply(bot.webhookTest());
          break;
        }
        if (sub === "route") {
          const action = (parts[1] || "list").toLowerCase();
          if (action === "clear") {
            bot.setHuntRoute([]);
            bot.setHuntConfig({ mode: "spiral" });
            reply("route cleared — back to spiral mode");
            break;
          }
          if (action === "set" || action === "add") {
            const waypoints: Array<{ x: number; z: number }> = [];
            for (const token of parts.slice(2)) {
              const m = token.match(/^(-?\d+)[,:](-?\d+)$/);
              if (m) waypoints.push({ x: Number(m[1]), z: Number(m[2]) });
            }
            if (!waypoints.length) {
              reply("usage: bh route set x,z x,z … (chunk coordinates)");
              break;
            }
            const count = bot.setHuntRoute(waypoints);
            reply(`route set: ${count} waypoints`);
            break;
          }
          const route = bot.huntRoute();
          reply(route.length ? route.map((w) => `${w.x},${w.z}`).join("  ") : "route is empty");
          break;
        }
        if (sub === "stash") {
          const db = bot.huntDatabase();
          if (!db) {
            reply("hunt database not initialised (start hunting once)");
            break;
          }
          const st = bot.getStatus();
          const pos = st.position;
          const rows = [...db.getStashes()]
            .map((s) => ({ ...s, distance: pos ? Math.round(Math.hypot(s.x - pos.x, s.z - pos.z)) : -1 }))
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 8);
          reply(
            rows.length
              ? rows.map((s) => `${s.tier} ${s.score} @ ${s.x},${s.z} (${s.distance}b)`).join("\n")
              : "no stashes recorded yet",
          );
          break;
        }
        // Default: status
        {
          const s = bot.huntStatus();
          if (!s) {
            reply("base hunting not started — try `bh start spiral`");
            break;
          }
          reply(
            [
              `phase=${s.paused ? "paused" : s.active ? s.phase : "stopped"} mode=${s.mode}`,
              `flight=${s.flight.state} elytra=${s.flight.elytraRemaining >= 0 ? s.flight.elytraRemaining : "none"} spares=${s.flight.elytraSpares}`,
              `waypoint=${s.waypointIndex}/${s.waypointsTotal} target=${s.target ? `${s.target.x.toFixed(0)},${s.target.z.toFixed(0)}` : "none"}`,
              `explored=${s.exploredChunks} stashes=${s.stashes} players=${s.players}`,
              s.notes.length ? `notes: ${s.notes.join(" · ")}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }
        break;
      }
      case "kibot": {
        const parts = arg.trim().split(/\s+/).filter(Boolean);
        const sub = (parts[0] || "status").toLowerCase();
        if (sub === "start") {
          const kitConfig: Record<string, unknown> = {};
          // Positional: prefix, cooldown seconds, distance
          if (parts[1]) kitConfig.prefix = parts[1];
          if (parts[2] && Number.isFinite(Number(parts[2]))) kitConfig.cooldownMs = Math.max(0, Number(parts[2])) * 1000;
          if (parts[3] && Number.isFinite(Number(parts[3]))) kitConfig.maxDistance = Math.max(0, Number(parts[3]));
          reply(bot.startKitBot(kitConfig as never));
          break;
        }
        if (sub === "stop") {
          reply(bot.stopKitBot());
          break;
        }
        if (sub === "give") {
          const username = parts[1];
          if (!username) {
            reply("usage: kibot give <player> [kit]");
            break;
          }
          reply(await bot.serveKit(username, parts[2]));
          break;
        }
        if (sub === "stock") {
          reply(bot.kitBotStock(parts[1]));
          break;
        }
        if (sub === "reset") {
          reply(bot.resetKitBotCooldowns());
          break;
        }
        if (sub === "config") {
          const kitConfig: Record<string, unknown> = {};
          for (let i = 1; i < parts.length; i += 2) {
            const key = (parts[i] || "").toLowerCase();
            const value = parts[i + 1];
            if (value == null) break;
            if (key === "prefix") kitConfig.prefix = value;
            else if (key === "cooldown") kitConfig.cooldownMs = Math.max(0, Number(value)) * 1000;
            else if (key === "distance") kitConfig.maxDistance = Math.max(0, Number(value));
            else if (key === "announce") kitConfig.announce = value !== "off";
            else if (key === "blacklist") kitConfig.blacklist = value.split(",").map((s) => s.trim()).filter(Boolean);
          }
          if (Object.keys(kitConfig).length === 0) {
            const cfg = bot.kitBotConfig();
            reply(`prefix=${cfg.prefix} cooldown=${cfg.cooldownMs / 1000}s distance=${cfg.maxDistance} announce=${cfg.announce} kits=${cfg.kits.map((k) => k.name).join(",")}`);
            break;
          }
          bot.setKitBotConfig(kitConfig as never);
          reply(`kit bot config updated (${Object.keys(kitConfig).join(", ")})`);
          break;
        }
        // Default: status
        {
          const active = bot.isKitBotActive();
          const st = bot.kitBotStatus();
          const cfg = bot.kitBotConfig();
          reply(
            [
              `kit bot ${active ? "ACTIVE" : "stopped"}`,
              `prefix=${cfg.prefix} cooldown=${cfg.cooldownMs / 1000}s distance=${cfg.maxDistance}`,
              `kits=${cfg.kits.map((k) => k.name).join(", ")}`,
              st ? `served=${st.servedTotal} lastMinute=${st.servedLastMinute} onCooldown=${st.playersOnCooldown}` : "",
              `stock: ${bot.kitBotStock()}`,
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }
        break;
      }
      case "captcha": {
        const st = bot.getStatus();
        const links = st.lastKickLinks || [];
        reply(
          [
            `kind=${st.lastKickKind ?? "none"}`,
            st.lastKick ? String(st.lastKick).slice(0, 300) : "no kick stored",
            links.length ? links.map((u) => u).join("\n") : "no links",
          ].join("\n"),
        );
        break;
      }
      default:
        reply(`unknown \`${prefix}${s}\` — try \`${prefix}help\``);
    }
  };

  client.on("error", (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`[discord] client error: ${msg}`);
  });

  const onMessageCreate = (msg: {
    author?: { bot?: boolean };
    channelId?: string;
    content?: string;
    reply: (t: string) => Promise<unknown>;
  }): void => {
    if (msg.author?.bot || msg.channelId !== channelId) return;
    const content = String(msg.content ?? "").trim();
    if (!content.startsWith(prefix)) return;
    const body = content.slice(prefix.length).trim();
    const parts = body.split(/\s+/);
    const sub = parts[0] || "";
    const arg = parts.slice(1).join(" ");
    if (!sub) return;
    void handleCommand(sub, arg, (text) => {
      msg.reply(String(text)).catch(() => {});
    }).catch((err: Error) => {
      log.warn(`[discord] command error: ${err.message}`);
      msg.reply(`error: ${err.message}`).catch(() => {});
    });
  };
  client.on("messageCreate", onMessageCreate as (...args: unknown[]) => void);

  // Primary bot kicks (fleet path also mirrors via mirrorEvent)
  bot.on("kicked", (info) => {
    const label =
      bot.getStatus()?.username || defaultProfile;
    mirrorEvent(label, "kicked", [info]);
  });

  // Base-hunting notifications (stash found, elytra replaced, emergency, …).
  bot.on("huntNotification", (notification) => {
    const label = bot.getStatus()?.username || defaultProfile;
    mirrorEvent(label, "huntNotification", [notification]);
  });

  return {
    start() {
      const onReady = () => {
        log.info(`[discord] connected as ${client.user?.tag ?? "?"}, channel ${channelId}`);
      };
      client.once("clientReady", onReady);
      client.once("ready", onReady);
      client.login(options.token).catch((e: Error) => {
        log.error(`[discord] login failed: ${e.message}`);
      });
    },
    stop() {
      try {
        client.destroy();
      } catch {
        /* ignore */
      }
    },
    log: queueLog,
    mirrorEvent,
  };
}
