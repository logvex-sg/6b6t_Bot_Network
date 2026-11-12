import assert from "node:assert/strict";
import test from "node:test";
import { KitBotController, type KitBotDeps } from "./controller.ts";
import { DEFAULT_KITBOT_CONFIG, type KitBotConfig } from "./kit.ts";

/** Minimal fake bot: just the fields the kit runtime reads. */
function fakeBot(options: {
  items?: Array<{ name: string; count: number }>;
  selfPos?: { x: number; y: number; z: number };
  playerPos?: { x: number; y: number; z: number } | null;
  playerName?: string;
  /** Explicit player → position map (takes precedence over playerPos/playerName). */
  players?: Record<string, { x: number; y: number; z: number }>;
}) {
  const slots: Array<{ name: string; count: number; type: number } | null> = new Array(46).fill(null);
  (options.items ?? []).forEach((item, i) => {
    slots[i] = { name: item.name, count: item.count, type: 100 + i };
  });
  const tossed: Array<{ name: string; count: number }> = [];
  const players: Record<string, unknown> = {};
  for (const [name, pos] of Object.entries(options.players ?? {})) {
    players[name] = { entity: { position: pos } };
  }
  if (options.playerPos) {
    players[options.playerName ?? "Steve"] = { entity: { position: options.playerPos } };
  }
  const bot = {
    inventory: { slots },
    entity: { position: options.selfPos ?? { x: 0, y: 64, z: 0 } },
    players,
    chat: () => {},
    tossStack: async (stack: { name: string; count: number }) => {
      tossed.push({ name: stack.name, count: stack.count });
      const idx = slots.findIndex((s) => s === stack);
      if (idx >= 0) slots[idx] = null;
    },
    toss: async (type: number, _meta: null, count: number) => {
      const idx = slots.findIndex((s) => s?.type === type);
      const stack = idx >= 0 ? slots[idx] : null;
      if (!stack) return;
      tossed.push({ name: stack.name, count });
      if (count >= stack.count) slots[idx] = null;
      else slots[idx] = { ...stack, count: stack.count - count };
    },
  };
  return { bot, tossed };
}

function makeDeps(overrides: Partial<KitBotDeps> = {}): { deps: KitBotDeps; chatLines: string[] } {
  const chatLines: string[] = [];
  const { bot } = fakeBot({
    items: [
      { name: "diamond_sword", count: 2 },
      { name: "cooked_beef", count: 32 },
      { name: "ender_pearl", count: 16 },
    ],
    playerPos: { x: 2, y: 64, z: 2 },
  });
  const deps: KitBotDeps = {
    requireBot: () => bot as never,
    chat: (m) => chatLines.push(m),
    selfUsername: () => "Bot",
    delay: async () => {},
    now: () => 1_000_000,
    ...overrides,
  };
  return { deps, chatLines };
}

const config: KitBotConfig = {
  ...DEFAULT_KITBOT_CONFIG,
  kits: [
    {
      name: "default",
      items: [
        { item: "diamond_sword", count: 1 },
        { item: "cooked_beef", count: 8 },
      ],
    },
  ],
  announce: false,
};

test("serves a kit to a nearby player", async () => {
  const { deps } = makeDeps();
  const controller = new KitBotController(deps, config);
  const outcome = await controller.serve("Steve");
  assert.ok(outcome.ok);
  assert.equal(outcome.dropped, 9);
});

test("ignores chat that is not a kit request", async () => {
  const { deps } = makeDeps();
  const controller = new KitBotController(deps, config);
  assert.equal(await controller.handleChat("<Steve> hello there"), null);
  assert.equal(await controller.handleChat("Steve joined the game"), null);
});

test("serves through a chat line", async () => {
  const { deps } = makeDeps();
  const controller = new KitBotController(deps, config);
  const outcome = await controller.handleChat("<Steve> !kit");
  assert.ok(outcome?.ok);
  assert.equal(controller.status().servedTotal, 1);
});

test("does not react to the bot's own chat", async () => {
  const { deps } = makeDeps();
  const controller = new KitBotController(deps, config);
  const outcome = await controller.handleChat("<Bot> !kit");
  assert.ok(!outcome?.ok);
  assert.equal(outcome?.reason, "denied-self");
});

test("enforces the per-player cooldown", async () => {
  const { deps } = makeDeps();
  const controller = new KitBotController(deps, config);
  assert.ok((await controller.serve("Steve")).ok);
  const second = await controller.serve("Steve");
  assert.ok(!second.ok);
  assert.equal(second.reason, "denied-cooldown");
});

test("a different player is not blocked by someone else's cooldown", async () => {
  const { bot } = fakeBot({
    items: [
      { name: "diamond_sword", count: 4 },
      { name: "cooked_beef", count: 64 },
    ],
    players: { Steve: { x: 2, y: 64, z: 2 }, Alex: { x: 3, y: 64, z: 1 } },
  });
  const { deps } = makeDeps({ requireBot: () => bot as never });
  const controller = new KitBotController(deps, config);
  assert.ok((await controller.serve("Steve")).ok);
  const other = await controller.serve("Alex");
  assert.ok(other.ok);
});

test("refuses a player who is too far away", async () => {
  const { deps } = makeDeps({
    requireBot: () => {
      const { bot } = fakeBot({
        items: [{ name: "diamond_sword", count: 1 }],
        playerPos: { x: 500, y: 64, z: 500 },
      });
      return bot as never;
    },
  });
  const controller = new KitBotController(deps, { ...config, maxDistance: 24 });
  const outcome = await controller.serve("Steve");
  assert.ok(!outcome.ok);
  assert.equal(outcome.reason, "denied-far");
});

test("refuses a blacklisted player", async () => {
  const { deps } = makeDeps();
  const controller = new KitBotController(deps, { ...config, blacklist: ["Steve"] });
  const outcome = await controller.serve("Steve");
  assert.ok(!outcome.ok);
  assert.equal(outcome.reason, "denied-blacklist");
});

test("reports out of stock when nothing can be given", async () => {
  const { deps } = makeDeps({
    requireBot: () => {
      const { bot } = fakeBot({ items: [{ name: "dirt", count: 3 }], playerPos: { x: 1, y: 64, z: 1 } });
      return bot as never;
    },
  });
  const controller = new KitBotController(deps, config);
  const outcome = await controller.serve("Steve");
  assert.ok(!outcome.ok);
  assert.equal(outcome.reason, "out-of-stock");
});

test("honours the global rate limit", async () => {
  let items = [
    { name: "diamond_sword", count: 10 },
    { name: "cooked_beef", count: 100 },
  ];
  const { deps } = makeDeps({
    requireBot: () => {
      const { bot } = fakeBot({ items, playerPos: { x: 1, y: 64, z: 1 } });
      return bot as never;
    },
  });
  const controller = new KitBotController(deps, { ...config, maxServesPerMinute: 1, maxDistance: 0 });
  assert.ok((await controller.serve("A")).ok);
  const blocked = await controller.serve("B");
  assert.ok(!blocked.ok);
  assert.equal(blocked.reason, "rate-limited");
  void items;
});

test("reports not connected rather than throwing", async () => {
  const { deps } = makeDeps({
    requireBot: () => {
      throw new Error("Bot is not connected. Run `join` first.");
    },
  });
  const controller = new KitBotController(deps, config);
  const outcome = await controller.serve("Steve");
  assert.ok(!outcome.ok);
  assert.equal(outcome.reason, "not-connected");
});

test("an unknown kit name is refused", async () => {
  const { deps } = makeDeps();
  const controller = new KitBotController(deps, config);
  const outcome = await controller.serve("Steve", "nope");
  assert.ok(!outcome.ok);
  assert.equal(outcome.reason, "unknown-kit");
});

test("status reports counters", async () => {
  const { deps } = makeDeps();
  const controller = new KitBotController(deps, config);
  await controller.serve("Steve");
  const status = controller.status();
  assert.equal(status.servedTotal, 1);
  assert.deepEqual(status.kits, ["default"]);
  assert.equal(status.prefix, "!");
});

test("resetCooldowns clears the block", async () => {
  const { deps } = makeDeps();
  const controller = new KitBotController(deps, config);
  assert.ok((await controller.serve("Steve")).ok);
  controller.resetCooldowns();
  assert.ok((await controller.serve("Steve")).ok);
});

test("stockSummary lists available counts", async () => {
  const { deps } = makeDeps();
  const controller = new KitBotController(deps, config);
  const summary = controller.stockSummary();
  assert.match(summary, /diamond_sword 2\/1/);
  assert.match(summary, /cooked_beef 32\/8/);
});

test("a chat handler never throws", async () => {
  const { deps } = makeDeps({
    requireBot: () => {
      throw new Error("boom");
    },
  });
  const controller = new KitBotController(deps, config);
  const outcome = await controller.handleChat("<Steve> !kit");
  assert.ok(outcome);
  assert.ok(!outcome.ok);
});
