import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadKitBotConfig, saveKitBotConfig } from "./kitBotConfigStore.ts";
import { DEFAULT_KITBOT_CONFIG } from "../kitbot/kit.ts";

// The store takes an explicit root for tests so nothing writes to the real Settings directory.
function withTempRoot(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bh-kitcfg-"));
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a missing kit config loads the defaults", () => {
  withTempRoot((root) => {
    const config = loadKitBotConfig("play.example.net:25565", root);
    assert.equal(config.prefix, DEFAULT_KITBOT_CONFIG.prefix);
    assert.equal(config.cooldownMs, DEFAULT_KITBOT_CONFIG.cooldownMs);
    assert.ok(config.kits.length > 0);
  });
});

test("a saved kit config round-trips", () => {
  withTempRoot((root) => {
    const server = "play.example.net:25565";
    const config = {
      ...DEFAULT_KITBOT_CONFIG,
      prefix: ".",
      cooldownMs: 1000,
      maxDistance: 8,
      announce: false,
      blacklist: ["griefer"],
      kits: [{ name: "default", items: [{ item: "bread", count: 2 }] }],
    };
    saveKitBotConfig(server, config, root);
    const loaded = loadKitBotConfig(server, root);
    assert.equal(loaded.prefix, ".");
    assert.equal(loaded.cooldownMs, 1000);
    assert.equal(loaded.maxDistance, 8);
    assert.equal(loaded.announce, false);
    assert.deepEqual(loaded.blacklist, ["griefer"]);
    assert.deepEqual(loaded.kits, [{ name: "default", items: [{ item: "bread", count: 2 }] }]);
  });
});

test("an empty kit list falls back to the built-in default kit", () => {
  withTempRoot((root) => {
    const server = "play.example.net:25565";
    saveKitBotConfig(server, { ...DEFAULT_KITBOT_CONFIG, kits: [] }, root);
    const loaded = loadKitBotConfig(server, root);
    assert.ok(loaded.kits.length > 0, "a config with no kits is useless, so the default is restored");
  });
});

test("a corrupt kit config is ignored rather than throwing", () => {
  withTempRoot((root) => {
    const server = "play.example.net:25565";
    const file = path.join(root, "kitbot", "play.example.net_25565", "config.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    const loaded = loadKitBotConfig(server, root);
    assert.equal(loaded.prefix, DEFAULT_KITBOT_CONFIG.prefix);
  });
});

test("servers are isolated from each other", () => {
  withTempRoot((root) => {
    saveKitBotConfig("a.example.net:25565", { ...DEFAULT_KITBOT_CONFIG, prefix: "!" }, root);
    saveKitBotConfig("b.example.net:25565", { ...DEFAULT_KITBOT_CONFIG, prefix: "." }, root);
    assert.equal(loadKitBotConfig("a.example.net:25565", root).prefix, "!");
    assert.equal(loadKitBotConfig("b.example.net:25565", root).prefix, ".");
  });
});
