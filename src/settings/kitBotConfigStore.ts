/**
 * Per-server kit-bot configuration persistence.
 *
 * Path: `Settings/kitbot/<server>/config.json`. Atomic writes, corrupt file ignored — a bad kit config must
 * never stop the bot loading. Same contract as the hunt config store.
 */
import fs from "node:fs";
import path from "node:path";
import { settingsDir } from "./store.ts";
import { log } from "../logger.ts";
import { DEFAULT_KITBOT_CONFIG, type KitBotConfig } from "../kitbot/kit.ts";
import { safeServerName } from "../hunt/database.ts";

interface ConfigFile {
  version: 1;
  server: string;
  updatedAt: number;
  config: Partial<KitBotConfig>;
}

function configFile(server: string, root?: string): string {
  return path.join(root ?? settingsDir(), "kitbot", safeServerName(server), "config.json");
}

/** Loads a stored kit-bot config, merged over the defaults. Returns the defaults on any failure. */
export function loadKitBotConfig(server: string, root?: string): KitBotConfig {
  const file = configFile(server, root);
  try {
    if (!fs.existsSync(file)) return { ...DEFAULT_KITBOT_CONFIG, kits: [...DEFAULT_KITBOT_CONFIG.kits] };
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ConfigFile>;
    const stored = raw?.config && typeof raw.config === "object" ? raw.config : {};
    return {
      ...DEFAULT_KITBOT_CONFIG,
      ...stored,
      kits: Array.isArray(stored.kits) && stored.kits.length > 0 ? stored.kits : DEFAULT_KITBOT_CONFIG.kits,
      blacklist: Array.isArray(stored.blacklist) ? stored.blacklist : [],
    };
  } catch (err) {
    log.warn("loadKitBotConfig failed", { server, err: err instanceof Error ? err.message : err });
    return { ...DEFAULT_KITBOT_CONFIG, kits: [...DEFAULT_KITBOT_CONFIG.kits] };
  }
}

/** Writes a kit-bot config atomically. A failure is logged, never thrown. */
export function saveKitBotConfig(server: string, config: KitBotConfig, root?: string): void {
  const file = configFile(server, root);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const doc: ConfigFile = { version: 1, server, updatedAt: Date.now(), config };
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    log.warn("saveKitBotConfig failed", { server, err: err instanceof Error ? err.message : err });
  }
}
