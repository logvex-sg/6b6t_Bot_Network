import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { WebSocketServer, type WebSocket } from "ws";
import type { FractalBot } from "./FractalBot.ts";
import type { ControlRequest, ControlResponse, JoinOptions } from "./types.ts";
import { apiCatalog } from "./catalog.ts";
import { log } from "../logger.ts";
import type { FleetManager } from "../fleet/FleetManager.ts";
import {
  MAX_BODY_BYTES,
  authorized,
  clampChat,
  clientAllowed,
  cookieHeader,
  isJsonContentType,
  securityHeaders,
} from "./security.ts";

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../web");
const DASHBOARD: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/survey.js": { file: "survey.js", type: "text/javascript; charset=utf-8" },
  "/sw.js": { file: "sw.js", type: "text/javascript; charset=utf-8" },
  "/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json; charset=utf-8" },
  "/brand-banner.png": { file: "brand-banner.png", type: "image/png" },
  "/brand-banner-full.png": { file: "brand-banner-full.png", type: "image/png" },
  "/logo-icon.png": { file: "logo-icon.png", type: "image/png" },
  "/logo.jpg": { file: "logo.jpg", type: "image/jpeg" },
};

export interface ControlServer {
  url: string;
  close(): Promise<void>;
}

export function startControlServer(
  fleet: FleetManager,
  host: string,
  port: number,
  token: string,
): Promise<ControlServer> {
  const sockets = new Set<WebSocket>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    if (!clientAllowed(req, port)) {
      res.writeHead(403, securityHeaders({ "content-type": "application/json" }));
      res.end(JSON.stringify({ ok: false, error: "forbidden" }));
      return;
    }
    if (req.method === "GET" && serveDashboard(url.pathname, res, token)) return;
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, { ok: true, data: { status: "up" } });
    }
    // Same-origin asset proxy — CSP blocks external img CDNs (Brave/shields)
    if (req.method === "GET" && url.pathname.startsWith("/asset/")) {
      await serveAssetProxy(url, res);
      return;
    }

    if (!authorized(req, token)) {
      res.writeHead(401, securityHeaders({ "content-type": "application/json" }));
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }

    if (req.method === "GET" && (url.pathname === "/v1" || url.pathname === "/v1/catalog")) {
      return json(res, { ok: true, data: apiCatalog() });
    }

    if (req.method === "GET" && url.pathname === "/v1/status") {
      const botId = url.searchParams.get("botId");
      const bot = fleet.resolveBot(botId);
      if (bot) {
        return json(res, {
          ok: true,
          data: { botId: botId || fleet.defaultBotId(), ...bot.getStatus() },
        });
      }
      // Selected profile exists but is not running — return idle scoped to that account
      const fleetStatus = fleet.getFleetStatus();
      const account = botId
        ? fleetStatus.bots.find((b) => b.id === botId)
        : undefined;
      return json(res, {
        ok: true,
        data: {
          botId: botId || null,
          phase: "idle",
          connected: false,
          username: account?.username,
          host: account?.host,
          port: account?.port,
          fleet: fleetStatus,
        },
      });
    }
    if (req.method === "GET" && url.pathname === "/v1/fleet") {
      return json(res, { ok: true, data: fleet.getFleetStatus() });
    }
    const getBot = () => fleet.resolveBot(url.searchParams.get("botId"));
    if (req.method === "GET" && url.pathname === "/v1/players") {
      const b = getBot();
      if (!b) return json(res, { ok: true, data: [] });
      return json(res, wrap(() => b.getPlayers()));
    }
    if (req.method === "GET" && url.pathname === "/v1/inventory") {
      const b = getBot();
      if (!b) return json(res, { ok: true, data: { quickBarSlot: 0, held: null, slots: [] } });
      return json(res, wrap(() => b.getInventory()));
    }
    if (req.method === "GET" && url.pathname === "/v1/dump") {
      return json(res, wrap(() => getBot()!.dump()));
    }
    if (req.method === "GET" && url.pathname === "/v1/voxels") {
      const q = String(url.searchParams.get("q") || "full").toLowerCase() === "lite" ? "lite" : "full";
      const rDefault = q === "lite" ? "12" : "20";
      return json(
        res,
        wrap(() => getBot()!.getVoxels(Number(url.searchParams.get("r") ?? rDefault), q)),
      );
    }
    if (req.method === "GET" && url.pathname === "/v1/view") {
      return json(
        res,
        wrap(() =>
          getBot()!.getView(Number(url.searchParams.get("r") ?? "20"), truthy(url.searchParams.get("map"))),
        ),
      );
    }
    if (req.method === "GET" && url.pathname === "/v1/map") {
      return json(res, wrap(() => getBot()!.getMap(Number(url.searchParams.get("r") ?? "24"))));
    }
    if (req.method === "GET" && url.pathname === "/v1/block") {
      const x = Number(url.searchParams.get("x"));
      const y = Number(url.searchParams.get("y"));
      const z = Number(url.searchParams.get("z"));
      if (![x, y, z].every(Number.isFinite)) return json(res, { ok: false, error: "block needs x y z" }, 400);
      return json(res, wrap(() => getBot()!.getBlock(x, y, z)));
    }
    if (req.method === "GET" && url.pathname === "/v1/cursor") {
      return json(res, wrap(() => getBot()!.getLook()));
    }
    if (req.method === "GET" && url.pathname === "/v1/entities") {
      return json(res, wrap(() => getBot()!.getEntities()));
    }

    if (req.method !== "POST") {
      res.writeHead(404, securityHeaders({ "content-type": "application/json" }));
      res.end(JSON.stringify({ ok: false, error: "not found" }));
      return;
    }

    if (!isJsonContentType(req)) {
      return json(res, { ok: false, error: "content-type must be application/json" }, 415);
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === "payload too large";
      return json(res, { ok: false, error: tooLarge ? "payload too large" : "bad request" }, tooLarge ? 413 : 400);
    }
    let payload: ControlRequest | undefined;
    try {
      payload = body ? (JSON.parse(body) as ControlRequest) : undefined;
    } catch {
      return json(res, { ok: false, error: "invalid json" }, 400);
    }

    if (url.pathname === "/v1/rpc") {
      const result = await dispatch(fleet, payload);
      return json(res, result, result.ok ? 200 : 400);
    }

    const action = url.pathname.replace(/^\/v1\//, "") as ControlRequest["action"];
    const merged = { ...(payload ?? {}), action } as ControlRequest;
    const result = await dispatch(fleet, merged);
    return json(res, result, result.ok ? 200 : 400);
  });

  const wss = new WebSocketServer({ server, path: "/v1/events" });
  wss.on("connection", (socket, req) => {
    if (!clientAllowed(req, port) || !authorized(req, token)) {
      socket.close(1008, "unauthorized");
      return;
    }
    sockets.add(socket);
    const primary = fleet.resolveBot(null);
    socket.send(JSON.stringify({ event: "fleet", data: fleet.getFleetStatus() }));
    if (primary) socket.send(JSON.stringify({ event: "status", data: primary.getStatus() }));
    socket.on("close", () => sockets.delete(socket));
  });

  const forward = (event: string, data: unknown) => {
    const message = JSON.stringify({ event, data });
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(message);
    }
  };

  fleet.on("fleet", (data) => forward("fleet", data));
  fleet.on("botEvent", (payload: { id: string; event: string; args: unknown[] }) => {
    const data = payload.args[0];
    if (payload.event === "error") {
      const err = data as Error;
      forward(payload.event, {
        botId: payload.id,
        message: err?.message,
      });
      return;
    }
    if (payload.event === "kicked" && data && typeof data === "object") {
      forward("kicked", { botId: payload.id, ...(data as object) });
      return;
    }
    if (payload.event === "status") {
      forward("status", { botId: payload.id, ...(data as object) });
      forward("fleet", fleet.getFleetStatus());
      return;
    }
    if (payload.event === "chat") {
      const chat =
        data && typeof data === "object"
          ? { botId: payload.id, ...(data as object) }
          : { botId: payload.id, raw: String(data ?? "") };
      forward("chat", chat);
      return;
    }
    if (payload.event === "phase" || payload.event === "authenticated" || payload.event === "disconnected") {
      forward(payload.event, { botId: payload.id, value: data });
      return;
    }
    if (payload.event === "detection") {
      forward("detection", { botId: payload.id, ...(data && typeof data === "object" ? (data as object) : { value: data }) });
      return;
    }
    if (payload.event === "msaCode") {
      forward("msaCode", {
        botId: payload.id,
        ...(data && typeof data === "object" ? (data as object) : { value: data }),
      });
      return;
    }
    if (payload.event === "window") {
      forward("window", {
        botId: payload.id,
        ...(data && typeof data === "object" ? (data as object) : { value: data }),
      });
      return;
    }
    forward(payload.event, data);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const url = `http://${host}:${port}`;
      log.info(`Dashboard ${url}  ·  API POST /v1/rpc  GET /v1/status  WS /v1/events`);
      resolve({
        url,
        close() {
          return new Promise((resClose) => {
            for (const socket of sockets) socket.close();
            wss.close();
            server.close(() => resClose());
          });
        },
      });
    });
  });
}

function serveDashboard(pathname: string, res: http.ServerResponse, token: string): boolean {
  const asset = DASHBOARD[pathname];
  if (!asset) return false;
  const webRoot = path.resolve(WEB_DIR);
  const full = path.resolve(webRoot, asset.file);
  const rel = path.relative(webRoot, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  try {
    const body = fs.readFileSync(full);
    const headers: Record<string, string> = {
      ...securityHeaders({ "content-type": asset.type }),
    };
    if (asset.file === "index.html") headers["set-cookie"] = cookieHeader(token);
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404, securityHeaders({ "content-type": "text/plain; charset=utf-8" }));
    res.end("dashboard file missing");
  }
  return true;
}

function json(res: http.ServerResponse, body: ControlResponse, status = 200): void {
  res.writeHead(status, securityHeaders({ "content-type": "application/json" }));
  res.end(JSON.stringify(body));
}

function wrap<T>(fn: () => T): ControlResponse {
  try {
    return { ok: true, data: fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function truthy(value: string | null): boolean {
  if (!value) return false;
  return value === "1" || value === "true" || value === "yes";
}

async function dispatch(fleet: FleetManager, request?: ControlRequest): Promise<ControlResponse> {
  if (!request?.action) return { ok: false, error: "missing action" };
  try {
    // Fleet management
    if (request.action === "fleetStatus") {
      return { ok: true, data: fleet.getFleetStatus() };
    }
    if (request.action === "fleetAccounts") {
      return { ok: true, data: { accounts: fleet.listAccounts(), path: fleet.getFleetStatus().accountsPath } };
    }
    if (request.action === "fleetAddAccount") {
      const account = (request.account ?? request) as { username?: string; id?: string };
      if (!account || typeof account !== "object" || !account.username) {
        return { ok: false, error: "fleetAddAccount requires account.username" };
      }
      try {
        const acc = fleet.addOrUpdateAccount(account as { username: string });
        return { ok: true, data: acc };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    if (request.action === "fleetRemoveAccount") {
      fleet.deleteAccount(request.id);
      return { ok: true, data: fleet.getFleetStatus() };
    }
    if (request.action === "fleetStart") {
      try {
        const msg = await fleet.startBot(request.id);
        const failed =
          msg.startsWith("unknown account") ||
          msg.startsWith("account missing") ||
          msg.includes("has no password");
        if (failed) return { ok: false, error: msg };
        return { ok: true, data: { result: msg, fleet: fleet.getFleetStatus() } };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    if (request.action === "fleetStop") {
      const msg = await fleet.stopBot(request.id);
      return { ok: true, data: { result: msg, fleet: fleet.getFleetStatus() } };
    }
    if (request.action === "fleetStartAll") {
      const results = await fleet.startAllEnabled();
      return { ok: true, data: { results, fleet: fleet.getFleetStatus() } };
    }
    if (request.action === "fleetStopAll") {
      await fleet.stopAll();
      return { ok: true, data: fleet.getFleetStatus() };
    }
    if (request.action === "fleetSetTask") {
      const msg = await fleet.setTask(request.id, request.task, request.taskOptions);
      return { ok: true, data: { result: msg, fleet: fleet.getFleetStatus() } };
    }
    if (request.action === "fleetSetFeatures") {
      const msg = await fleet.setFeatures(request.id, request.features || {});
      return { ok: true, data: { result: msg, fleet: fleet.getFleetStatus() } };
    }
    if (request.action === "fleetSetAnnouncements") {
      fleet.setDefaultAnnouncements(request.announcements || []);
      return { ok: true, data: { defaultAnnouncements: fleet.getDefaultAnnouncements() } };
    }
    if (request.action === "fleetMicrosoftAuth") {
      try {
        const msg = await fleet.authenticateMicrosoft(request.id);
        const failed =
          msg.startsWith("unknown account") ||
          msg.startsWith("account missing") ||
          msg.includes("is offline") ||
          msg.includes("switch Auth");
        if (failed) return { ok: false, error: msg };
        return { ok: true, data: { result: msg, fleet: fleet.getFleetStatus() } };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    const botId = (request as { botId?: string }).botId || fleet.defaultBotId();
    const bot = fleet.resolveBot(botId);
    if (!bot) {
      return {
        ok: false,
        error: "No bot running. Add an account and fleetStart it, or fleetStartAll.",
      };
    }

    switch (request.action) {
      case "join":
        await bot.join(safeJoinOptions(request.options));
        return { ok: true, data: bot.getStatus() };
      case "leave":
        await bot.leave(request.reason);
        return { ok: true, data: bot.getStatus() };
      case "reconnect":
        await bot.reconnect();
        return { ok: true, data: bot.getStatus() };
      case "chat":
        bot.chat(clampChat(request.message ?? ""));
        return { ok: true };
      case "command":
        bot.runCommand(clampChat(request.command ?? ""));
        return { ok: true };
      case "goto":
        bot.goto(request.x, request.y, request.z, request.range);
        return { ok: true };
      case "lookAt":
        await bot.lookAt(request.x, request.y, request.z);
        return { ok: true, data: bot.getLook() };
      case "look":
        return {
          ok: true,
          data: await bot.look({
            yaw: request.yaw,
            pitch: request.pitch,
            x: request.x,
            y: request.y,
            z: request.z,
            force: request.force,
          }),
        };
      case "turn":
        return { ok: true, data: await bot.turn(request.yaw ?? 0, request.pitch ?? 0) };
      case "control":
        bot.setControl(request.state);
        return { ok: true, data: bot.getStatus().control };
      case "jump":
        bot.jump();
        return { ok: true };
      case "stop":
        bot.stopMovement();
        return { ok: true };
      case "attack":
        bot.attack(request.username);
        return { ok: true };
      case "dig":
        return { ok: true, data: await bot.dig(request.x, request.y, request.z) };
      case "stopDig":
        bot.stopDig();
        return { ok: true };
      case "place":
        await bot.place(request.x, request.y, request.z, request.face);
        return { ok: true };
      case "activate":
        await bot.activate(request.x, request.y, request.z);
        return { ok: true };
      case "swing":
        bot.swing();
        return { ok: true };
      case "respawn":
        bot.respawn();
        return { ok: true };
      case "status":
        return { ok: true, data: bot.getStatus() };
      case "players":
        return { ok: true, data: bot.getPlayers() };
      case "detection":
        return { ok: true, data: bot.getDetection() };
      case "clearDetection":
        bot.clearDetectionLog();
        return { ok: true, data: bot.getDetection() };
      case "clearServerListener": {
        const { clearServerListenerLog, defaultServerListenerPath } = await import(
          "../minecraft/serverListener.ts"
        );
        const { settingsDir } = await import("../settings/store.ts");
        const username =
          String((request as { username?: unknown }).username || "").trim() ||
          bot.getStatus()?.username ||
          "";
        const folder = settingsDir();
        const result = await clearServerListenerLog(username || undefined, folder);
        // If still empty (bot offline / never attached), clear default path for username
        if (result.cleared.length === 0 && username) {
          const fallback = await clearServerListenerLog(username, folder);
          return {
            ok: true,
            data: {
              ...fallback,
              path: fallback.cleared[0] || defaultServerListenerPath(folder, username),
            },
          };
        }
        return {
          ok: true,
          data: {
            ...result,
            path: result.cleared[0] || defaultServerListenerPath(folder, username),
          },
        };
      }
      case "entities":
        return { ok: true, data: bot.getEntities() };
      case "inventory":
        return { ok: true, data: bot.getInventory() };
      case "inv":
        return { ok: true, data: await bot.manageInventory(request) };
      case "tabComplete": {
        const partial = String((request as { partial?: unknown }).partial ?? "");
        return { ok: true, data: await bot.tabComplete(partial) };
      }
      case "homes":
        return { ok: true, data: bot.getHomes() };
      case "openHomes":
        return { ok: true, data: await bot.openHomesGui() };
      case "dump":
        return { ok: true, data: bot.dump() };
      case "view":
        return { ok: true, data: bot.getView(request.radius, request.map) };
      case "voxels": {
        const q = (request as { quality?: string }).quality === "lite" ? "lite" : "full";
        return { ok: true, data: bot.getVoxels(request.radius, q) };
      }
      case "map":
        return { ok: true, data: bot.getMap(request.radius) };
      case "block":
        return { ok: true, data: bot.getBlock(request.x, request.y, request.z) };
      case "cursor":
        return { ok: true, data: bot.getLook() };
      case "hunt":
        bot.startPortalHunt();
        return { ok: true, data: bot.getStatus() };
      case "unhunt":
        bot.stopPortalHunt();
        return { ok: true, data: bot.getStatus() };
      case "mapStart": {
        const result = bot.startMapping(request.mode);
        return { ok: true, data: { result, status: bot.getMappingStatus() } };
      }
      case "mapStop": {
        const result = bot.stopMapping();
        return { ok: true, data: { result, status: bot.getMappingStatus() } };
      }
      case "mapStatus":
        return { ok: true, data: bot.getMappingStatus() };
      case "mapConfig":
        if (request.mapping) bot.setMappingConfig(request.mapping);
        return { ok: true, data: bot.getMappingStatus() };
      case "huntStart": {
        const result = bot.startHunt((request as { huntConfig?: Record<string, unknown> }).huntConfig as never);
        return { ok: true, data: { result, status: bot.huntStatus() } };
      }
      case "huntStop": {
        const result = bot.stopHunt();
        return { ok: true, data: { result, status: bot.huntStatus() } };
      }
      case "huntPause":
        return { ok: true, data: { result: bot.pauseHunt(), status: bot.huntStatus() } };
      case "huntResume":
        return { ok: true, data: { result: bot.resumeHunt(), status: bot.huntStatus() } };
      case "huntStatus":
        return { ok: true, data: bot.huntStatus() };
      case "elytraStatus":
        return { ok: true, data: bot.elytraStatus() };
      case "elytraReplace": {
        const result = await bot.replaceElytra();
        return { ok: true, data: { result, status: bot.elytraStatus() } };
      }
      case "mendingStatus":
        return { ok: true, data: { candidates: bot.mendingStatus(), target: bot.mendingTarget() } };
      case "survivalStatus":
        return { ok: true, data: bot.survivalStatus() };
      case "echestStatus": {
        const result = await bot.echestStatus();
        return { ok: true, data: result };
      }
      case "webhookTest":
        return { ok: true, data: { result: bot.webhookTest() } };
      case "huntConfig":
        if ((request as { huntConfig?: unknown }).huntConfig) {
          bot.setHuntConfig((request as { huntConfig: Record<string, unknown> }).huntConfig as never);
        }
        return { ok: true, data: { status: bot.huntStatus(), config: bot.huntConfig() } };
      case "huntRouteSet": {
        const waypoints = (request as { waypoints?: Array<{ x: number; z: number }> }).waypoints ?? [];
        const count = bot.setHuntRoute(waypoints);
        return { ok: true, data: { count, route: bot.huntRoute() } };
      }
      case "huntRouteList":
        return { ok: true, data: { route: bot.huntRoute() } };
      case "huntRestock": {
        const result = await bot.huntRestock();
        return { ok: true, data: { result, status: bot.huntStatus() } };
      }
      case "stashList": {
        const db = bot.huntDatabase();
        if (!db) return { ok: true, data: { stashes: [], total: 0 } };
        const rows = db.searchStashes((request as { search?: never }).search);
        return { ok: true, data: { stashes: rows, total: rows.length } };
      }
      case "stashNearby": {
        const db = bot.huntDatabase();
        if (!db) return { ok: true, data: { stashes: [], total: 0 } };
        const pos = bot.getStatus().position;
        const stashes = [...db.getStashes()]
          .map((s) => ({ ...s, distance: pos ? Math.round(Math.hypot(s.x - pos.x, s.z - pos.z)) : -1 }))
          .sort((a, b) => a.distance - b.distance)
          .slice(0, 25);
        return { ok: true, data: { stashes, total: db.getStashes().length } };
      }
      case "playerList": {
        const db = bot.huntDatabase();
        if (!db) return { ok: true, data: { players: [], total: 0 } };
        const text = (request as { query?: string }).query ?? "";
        const players = db.searchPlayers(text, 100);
        return { ok: true, data: { players, total: db.getPlayers().length } };
      }
      case "huntDatabaseExport": {
        const db = bot.huntDatabase();
        if (!db) return { ok: false, error: "hunt database not initialised (start hunting once)" };
        return { ok: true, data: { document: db.exportJson(), stats: db.stats() } };
      }
      case "huntDatabaseImport": {
        const db = bot.huntDatabase();
        if (!db) return { ok: false, error: "hunt database not initialised (start hunting once)" };
        const document = (request as { document?: string }).document;
        if (!document) return { ok: false, error: "missing document" };
        const counts = db.importJson(document, "merge");
        return { ok: true, data: { counts, stats: db.stats() } };
      }
      case "kitBotStart": {
        const result = bot.startKitBot((request as { kitConfig?: Record<string, unknown> }).kitConfig as never);
        return { ok: true, data: { result, status: bot.kitBotStatus(), config: bot.kitBotConfig() } };
      }
      case "kitBotStop": {
        const result = bot.stopKitBot();
        return { ok: true, data: { result, status: bot.kitBotStatus() } };
      }
      case "kitBotStatus":
        return { ok: true, data: { active: bot.isKitBotActive(), status: bot.kitBotStatus(), config: bot.kitBotConfig() } };
      case "kitBotConfig": {
        const patch = (request as { kitConfig?: Record<string, unknown> }).kitConfig;
        if (patch) bot.setKitBotConfig(patch as never);
        return { ok: true, data: { status: bot.kitBotStatus(), config: bot.kitBotConfig() } };
      }
      case "kitBotServe": {
        const { username, kit } = request as { username: string; kit?: string };
        if (!username) return { ok: false, error: "missing username" };
        const result = await bot.serveKit(username, kit);
        return { ok: true, data: { result, status: bot.kitBotStatus() } };
      }
      case "kitBotStock": {
        const kit = (request as { kit?: string }).kit;
        return { ok: true, data: { stock: bot.kitBotStock(kit) } };
      }
      case "kitBotResetCooldowns": {
        const result = bot.resetKitBotCooldowns();
        return { ok: true, data: { result, status: bot.kitBotStatus() } };
      }
      case "getSettings": {
        const { getSettingsSnapshot } = await import("../config.ts");
        return { ok: true, data: getSettingsSnapshot() };
      }
      case "saveSettings": {
        const { saveSettingsValues, reloadConfigFromEnv, getSettingsSnapshot, SETTINGS_FIELDS } = await import(
          "../config.ts"
        );
        const values = (request as { values?: Record<string, string> }).values || {};
        const result = saveSettingsValues(values);
        const next = reloadConfigFromEnv();
        fleet.applyBaseConfig(next);
        const restartKeys = SETTINGS_FIELDS.filter((f) => f.restart && result.saved.includes(f.key)).map((f) => f.key);
        return {
          ok: true,
          data: {
            ...result,
            restartRequired: restartKeys.length > 0,
            restartKeys,
            settings: getSettingsSnapshot(),
          },
        };
      }
      case "set": {
        const flags: { autoReconnect?: boolean; autoLobby?: boolean } = {};
        if (typeof (request as { autoReconnect?: unknown }).autoReconnect === "boolean") {
          flags.autoReconnect = (request as { autoReconnect: boolean }).autoReconnect;
        }
        if (typeof (request as { autoLobby?: unknown }).autoLobby === "boolean") {
          flags.autoLobby = (request as { autoLobby: boolean }).autoLobby;
        }
        bot.setFlags(flags);
        return { ok: true, data: bot.getStatus() };
      }
      case "catalog":
        return { ok: true, data: apiCatalog() };
      default:
        return { ok: false, error: `unknown action ${(request as { action: string }).action}` };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    req.on("data", (chunk) => {
      const buf = Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        finish(new Error("payload too large"));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => finish());
    req.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
  });
}

function safeJoinOptions(options?: JoinOptions): JoinOptions {
  return {
    autoLobby: options?.autoLobby,
    autoReconnect: options?.autoReconnect,
  };
}


/** In-memory texture/skin cache (process lifetime). */
const assetCache = new Map<string, { buf: Buffer; type: string; at: number }>();
const ASSET_TTL_MS = 6 * 60 * 60 * 1000;
const MC_ASSET_VER = "1.21.1";
const MC_TEXTURE_BASES = [
  `https://cdn.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@${MC_ASSET_VER}/assets/minecraft/textures`,
  `https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/${MC_ASSET_VER}/assets/minecraft/textures`,
  `https://assets.mcasset.cloudflare.com/${MC_ASSET_VER}/assets/minecraft/textures`,
];
const MC_MODEL_BASES = [
  `https://cdn.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@${MC_ASSET_VER}/assets/minecraft/models/item`,
  `https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/${MC_ASSET_VER}/assets/minecraft/models/item`,
];

/**
 * Items whose registry name has no dedicated texture file.
 * Vanilla models point at another layer0 (glint / animation / standby pose is client-side).
 * Spawn eggs: any `*_spawn_egg` is rewritten to `spawn_egg` in resolveItemTextureIds().
 */
const ITEM_TEXTURE_ALIASES: Record<string, string> = {
  enchanted_golden_apple: "golden_apple",
  crossbow: "crossbow_standby",
  clock: "clock_00",
  compass: "compass_16",
  recovery_compass: "recovery_compass_16",
  debug_stick: "stick",
  tipped_arrow: "tipped_arrow_base",
  large_fern: "large_fern_top",
  // Entity-rendered blocks — best flat stand-ins
  chest: "oak_planks",
  trapped_chest: "oak_planks",
  ender_chest: "obsidian",
  decorated_pot: "decorated_pot_side",
  shield: "dark_oak_planks",
  // Infested blocks share the host block texture
  infested_stone: "stone",
  infested_cobblestone: "cobblestone",
  infested_stone_bricks: "stone_bricks",
  infested_mossy_stone_bricks: "mossy_stone_bricks",
  infested_cracked_stone_bricks: "cracked_stone_bricks",
  infested_chiseled_stone_bricks: "chiseled_stone_bricks",
  infested_deepslate: "deepslate",
};

function sanitizeItemId(raw: string): string {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, "")
    .replace(/[^a-z0-9_/.-]/g, "")
    .slice(0, 96);
}

/** Ordered texture ids to try for a registry item name (before model lookup). */
function resolveItemTextureIds(id: string): string[] {
  const out: string[] = [];
  const push = (t: string) => {
    const s = sanitizeItemId(t);
    if (s && !out.includes(s)) out.push(s);
  };
  if (id.endsWith("_spawn_egg")) push("spawn_egg");
  const alias = ITEM_TEXTURE_ALIASES[id];
  if (alias) push(alias);
  push(id);
  // Common multi-face block item fallbacks
  for (const suf of ["_side", "_top", "_front", "_bottom"]) {
    push(id + suf);
  }
  return out;
}

async function fetchBuffer(
  url: string,
  timeoutMs = 8000,
  opts?: { accept?: string; allowNonImage?: boolean },
): Promise<{ buf: Buffer; type: string } | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        "user-agent": "FractalBot-AssetProxy/1.0",
        accept: opts?.accept || "image/*,*/*",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "application/octet-stream";
    if (
      !opts?.allowNonImage &&
      !type.startsWith("image/") &&
      !type.includes("octet-stream")
    ) {
      return null;
    }
    const ab = await res.arrayBuffer();
    if (!ab.byteLength || ab.byteLength > 2_000_000) return null;
    const outType = type.startsWith("image/")
      ? type
      : opts?.allowNonImage
        ? type
        : "image/png";
    return { buf: Buffer.from(ab), type: outType };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve texture path candidates from item model JSON.
 * Returns layer0/particle/layer1 and, if missing, the parent block/item id.
 * Cached as a comma-separated list.
 */
async function resolveTextureFromModel(id: string): Promise<string[]> {
  const cacheKey = `model:${id}`;
  const hit = assetCache.get(cacheKey);
  if (hit && Date.now() - hit.at < ASSET_TTL_MS && hit.type === "text/texture-id") {
    const s = hit.buf.toString("utf8");
    return s ? s.split(",").filter(Boolean) : [];
  }
  const found: string[] = [];
  const push = (raw: string) => {
    const path = raw
      .replace(/^minecraft:/, "")
      .replace(/^(item|block)\//, "")
      .replace(/^entity\//, ""); // e.g. entity/decorated_pot/...
    // Keep nested paths like decorated_pot/decorated_pot_side → last segment is usable
    const clean = sanitizeItemId(path.includes("/") ? path.split("/").pop()! : path);
    if (clean && !found.includes(clean)) found.push(clean);
  };

  for (const base of MC_MODEL_BASES) {
    const got = await fetchBuffer(`${base}/${id}.json`, 5000, {
      accept: "application/json,text/plain,*/*",
      allowNonImage: true,
    });
    if (!got) continue;
    try {
      const model = JSON.parse(got.buf.toString("utf8")) as {
        textures?: Record<string, string>;
        parent?: string;
      };
      for (const key of ["layer0", "particle", "layer1", "all", "side", "end", "top", "front"] as const) {
        const t = model.textures?.[key];
        if (t) push(t);
      }
      // parent: "minecraft:block/furnace" → try furnace (+ _side/_front via resolveItemTextureIds later)
      const parent = model.parent || "";
      const m = parent.match(/^(?:minecraft:)?(?:block|item)\/([a-z0-9_/.-]+)$/i);
      if (m) push(m[1]);
      if (found.length) {
        assetCache.set(cacheKey, {
          buf: Buffer.from(found.join(","), "utf8"),
          type: "text/texture-id",
          at: Date.now(),
        });
        return found;
      }
    } catch {
      /* ignore bad JSON */
    }
  }
  return found;
}

/** Extract hash from textures.minecraft.net/texture/<hash> (and https variants). */
function extractMinecraftTextureHash(direct: string): string | null {
  if (!direct) return null;
  const m = direct.match(/textures\.minecraft\.net\/texture\/([a-f0-9]{32,64})/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Crop a classic/slim skin sheet into a face avatar or a simple front-body preview.
 * Used when CDN renderers fail (cracked SkinRestorer custom hosts).
 */
function renderSkinFromSheet(buf: Buffer, style: "avatar" | "body"): Buffer | null {
  try {
    const src = PNG.sync.read(buf);
    const w = src.width;
    const h = src.height;
    // Classic 64×64 or 64×32 (legacy)
    if (w < 64 || h < 32) return null;

    const scale = style === "avatar" ? 8 : 4;
    // Face is at (8,8) size 8×8 on a 64-wide sheet
    if (style === "avatar") {
      const out = new PNG({ width: 8 * scale, height: 8 * scale });
      blitNearest(src, 8, 8, 8, 8, out, scale);
      // Hat layer (40,8) if non-transparent
      blitNearest(src, 40, 8, 8, 8, out, scale, true);
      return PNG.sync.write(out);
    }

    // Body preview: head + torso + legs, front view (approx 16×32 source px)
    // head 8×8 @ (8,8), body 8×12 @ (20,20), leg 4×12 @ (4,20), arm 4×12 @ (44,20)
    const outW = 16 * scale;
    const outH = 32 * scale;
    const out = new PNG({ width: outW, height: outH });
    // clear transparent
    out.data.fill(0);
    // head
    blitNearestInto(src, 8, 8, 8, 8, out, 4 * scale, 0, scale);
    blitNearestInto(src, 40, 8, 8, 8, out, 4 * scale, 0, scale, true); // hat
    // body
    blitNearestInto(src, 20, 20, 8, 12, out, 4 * scale, 8 * scale, scale);
    // right leg / left leg
    blitNearestInto(src, 4, 20, 4, 12, out, 4 * scale, 20 * scale, scale);
    blitNearestInto(src, 20, 52, 4, 12, out, 8 * scale, 20 * scale, scale); // left leg (64×64)
    // arms
    blitNearestInto(src, 44, 20, 4, 12, out, 0, 8 * scale, scale);
    blitNearestInto(src, 36, 52, 4, 12, out, 12 * scale, 8 * scale, scale);
    return PNG.sync.write(out);
  } catch {
    return null;
  }
}

type SkinPng = { width: number; height: number; data: Buffer };

function blitNearest(
  src: SkinPng,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dst: SkinPng,
  scale: number,
  overlay = false,
): void {
  blitNearestInto(src, sx, sy, sw, sh, dst, 0, 0, scale, overlay);
}

function blitNearestInto(
  src: SkinPng,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dst: SkinPng,
  dx: number,
  dy: number,
  scale: number,
  overlay = false,
): void {
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const si = ((sy + y) * src.width + (sx + x)) << 2;
      const r = src.data[si];
      const g = src.data[si + 1];
      const b = src.data[si + 2];
      const a = src.data[si + 3];
      if (overlay && a < 10) continue;
      for (let oy = 0; oy < scale; oy++) {
        for (let ox = 0; ox < scale; ox++) {
          const di = ((dy + y * scale + oy) * dst.width + (dx + x * scale + ox)) << 2;
          if (di < 0 || di + 3 >= dst.data.length) continue;
          if (overlay && a < 250) {
            // simple alpha over
            const inv = 255 - a;
            dst.data[di] = (r * a + dst.data[di] * inv) / 255;
            dst.data[di + 1] = (g * a + dst.data[di + 1] * inv) / 255;
            dst.data[di + 2] = (b * a + dst.data[di + 2] * inv) / 255;
            dst.data[di + 3] = Math.min(255, dst.data[di + 3] + a);
          } else {
            dst.data[di] = r;
            dst.data[di + 1] = g;
            dst.data[di + 2] = b;
            dst.data[di + 3] = a || 255;
          }
        }
      }
    }
  }
}

async function serveAssetProxy(url: URL, res: http.ServerResponse): Promise<void> {
  // /asset/item/<id>.png  or  /asset/item?name=diamond_sword
  // /asset/skin?u=Name&url=<optional server texture>&kind=avatar|body
  const pathParts = url.pathname.split("/").filter(Boolean);
  const kind = pathParts[1];

  if (kind === "item") {
    let id = pathParts[2] || url.searchParams.get("name") || "";
    id = sanitizeItemId(id.replace(/\.png$/i, ""));
    if (!id) {
      res.writeHead(400, securityHeaders({ "content-type": "text/plain" }));
      res.end("bad item");
      return;
    }
    const cacheKey = `item:${id}`;
    const hit = assetCache.get(cacheKey);
    if (hit && Date.now() - hit.at < ASSET_TTL_MS && hit.type.startsWith("image/")) {
      res.writeHead(200, securityHeaders({ "content-type": hit.type, "cache-control": "public, max-age=86400" }));
      res.end(hit.buf);
      return;
    }

    // alias / spawn_egg / multi-face → original → model layer0 / parent
    const textureIds = resolveItemTextureIds(id);
    for (const mid of await resolveTextureFromModel(id)) {
      if (!textureIds.includes(mid)) textureIds.push(mid);
      // parent block names often need _side / _front
      for (const suf of ["_side", "_top", "_front"]) {
        const withSuf = sanitizeItemId(mid + suf);
        if (withSuf && !textureIds.includes(withSuf)) textureIds.push(withSuf);
      }
    }

    const candidates: string[] = [];
    for (const tid of textureIds) {
      for (const base of MC_TEXTURE_BASES) {
        candidates.push(`${base}/item/${tid}.png`);
        candidates.push(`${base}/block/${tid}.png`);
      }
    }
    for (const src of candidates) {
      const got = await fetchBuffer(src);
      if (got) {
        assetCache.set(cacheKey, { ...got, at: Date.now() });
        res.writeHead(200, securityHeaders({ "content-type": got.type, "cache-control": "public, max-age=86400" }));
        res.end(got.buf);
        return;
      }
    }
    res.writeHead(404, securityHeaders({ "content-type": "text/plain" }));
    res.end("texture not found");
    return;
  }

  if (kind === "skin") {
    // kind=avatar → face only (nearby list); kind=body → full figure (inventory panel)
    const style = String(url.searchParams.get("kind") || "avatar").toLowerCase() === "body" ? "body" : "avatar";
    const user = String(url.searchParams.get("u") || "").trim().slice(0, 32);
    const direct = String(url.searchParams.get("url") || "").trim();
    const cacheKey = `skin:${style}:${user}|${direct}`;
    const hit = assetCache.get(cacheKey);
    if (hit && Date.now() - hit.at < ASSET_TTL_MS && hit.type.startsWith("image/")) {
      res.writeHead(200, securityHeaders({ "content-type": hit.type, "cache-control": "public, max-age=3600" }));
      res.end(hit.buf);
      return;
    }

    const candidates: string[] = [];
    // Prefer rendered heads/bodies — never serve the raw 64×64 skin sheet as an avatar.
    if (user) {
      if (style === "body") {
        candidates.push(`https://mc-heads.net/body/${encodeURIComponent(user)}/right`);
        candidates.push(`https://crafthead.net/body/${encodeURIComponent(user)}`);
        candidates.push(`https://mc-heads.net/player/${encodeURIComponent(user)}`);
      } else {
        candidates.push(`https://mc-heads.net/avatar/${encodeURIComponent(user)}/64`);
        candidates.push(`https://crafthead.net/avatar/${encodeURIComponent(user)}`);
        candidates.push(`https://mc-heads.net/head/${encodeURIComponent(user)}/64`);
      }
    }
    // textures.minecraft.net/texture/<hash> → render by hash (premium + some cracked)
    const texHash = extractMinecraftTextureHash(direct);
    if (texHash) {
      if (style === "body") {
        candidates.push(`https://mc-heads.net/body/${texHash}/right`);
        candidates.push(`https://crafthead.net/body/${texHash}`);
      } else {
        candidates.push(`https://mc-heads.net/avatar/${texHash}/64`);
        candidates.push(`https://crafthead.net/avatar/${texHash}`);
      }
    }

    for (const src of candidates) {
      const got = await fetchBuffer(src);
      if (got) {
        assetCache.set(cacheKey, { ...got, at: Date.now() });
        res.writeHead(200, securityHeaders({ "content-type": got.type, "cache-control": "public, max-age=3600" }));
        res.end(got.buf);
        return;
      }
    }

    // SkinRestorer / custom URL: fetch raw sheet and crop face (or scale body region)
    if (direct && /^https?:\/\//i.test(direct)) {
      const raw = await fetchBuffer(direct);
      if (raw) {
        const rendered = renderSkinFromSheet(raw.buf, style);
        if (rendered) {
          assetCache.set(cacheKey, { buf: rendered, type: "image/png", at: Date.now() });
          res.writeHead(200, securityHeaders({ "content-type": "image/png", "cache-control": "public, max-age=3600" }));
          res.end(rendered);
          return;
        }
      }
    }

    res.writeHead(404, securityHeaders({ "content-type": "text/plain" }));
    res.end("skin not found");
    return;
  }

  res.writeHead(404, securityHeaders({ "content-type": "text/plain" }));
  res.end("unknown asset");
}
