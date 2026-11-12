import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_KITBOT_CONFIG,
  RateLimiter,
  checkCooldown,
  checkEligibility,
  cooldownFor,
  countStock,
  findKit,
  formatDuration,
  planIsServiceable,
  planKit,
  pruneCooldowns,
  recordServe,
  type KitBotConfig,
  type KitDefinition,
} from "./kit.ts";

const config: KitBotConfig = { ...DEFAULT_KITBOT_CONFIG };

const pvpKit: KitDefinition = {
  name: "pvp",
  items: [
    { item: "diamond_sword", count: 1 },
    { item: "cooked_beef", count: 16 },
    { item: "ender_pearl", count: 16 },
  ],
};

test("countStock ignores non-positive and non-finite entries", () => {
  assert.deepEqual(countStock({ bread: 5, stone: 0, air: -3, x: Number.NaN }), { bread: 5 });
});

test("planKit reports a full kit when stocked", () => {
  const plan = planKit(pvpKit, { diamond_sword: 2, cooked_beef: 64, ender_pearl: 32 });
  assert.equal(plan.missing.length, 0);
  assert.equal(plan.partial.length, 0);
  assert.deepEqual(
    plan.lines.map((l) => l.give),
    [1, 16, 16],
  );
  assert.ok(planIsServiceable(plan));
});

test("planKit reports missing items when out of stock", () => {
  const plan = planKit(pvpKit, { cooked_beef: 8 });
  assert.deepEqual(
    plan.missing.map((l) => l.item),
    ["diamond_sword", "ender_pearl"],
  );
  assert.ok(planIsServiceable(plan), "a partly stocked bot still serves what it can");
});

test("planKit reports partial lines", () => {
  const plan = planKit(pvpKit, { diamond_sword: 1, cooked_beef: 4, ender_pearl: 16 });
  assert.deepEqual(plan.partial.map((l) => [l.item, l.available, l.wanted]), [["cooked_beef", 4, 16]]);
});

test("planKit with nothing at all is not serviceable", () => {
  const plan = planKit(pvpKit, {});
  assert.equal(plan.lines.length, 0);
  assert.equal(plan.missing.length, 3);
  assert.ok(!planIsServiceable(plan));
});

test("findKit is case-insensitive", () => {
  const c = { ...config, kits: [pvpKit] };
  assert.equal(findKit(c, "PVP")?.name, "pvp");
  assert.equal(findKit(c, "nope"), null);
});

test("cooldownFor prefers the kit override", () => {
  const kit: KitDefinition = { ...pvpKit, cooldownMs: 1000 };
  assert.equal(cooldownFor(config, kit), 1000);
  assert.equal(cooldownFor({ ...config, cooldownMs: 5000 }, { ...pvpKit }), 5000);
});

test("cooldown allows the first request and blocks the next", () => {
  let state = { nextAt: {} };
  const now = 1_000_000;
  assert.ok(checkCooldown(state, "Steve", 60_000, now).allowed);
  state = recordServe(state, "Steve", 60_000, now);
  const blocked = checkCooldown(state, "Steve", 60_000, now + 30_000);
  assert.ok(!blocked.allowed);
  assert.equal(blocked.remainingMs, 30_000);
  assert.ok(checkCooldown(state, "Steve", 60_000, now + 60_000).allowed);
});

test("cooldowns are case-insensitive", () => {
  const state = recordServe({ nextAt: {} }, "Steve", 60_000, 1000);
  assert.ok(!checkCooldown(state, "sTeVe", 60_000, 1500).allowed);
});

test("pruneCooldowns drops expired entries", () => {
  const state = { nextAt: { a: 500, b: 5000 } };
  assert.deepEqual(pruneCooldowns(state, 1000), { nextAt: { b: 5000 } });
});

test("rate limiter blocks past the cap and recovers after the window", () => {
  const limiter = new RateLimiter(3);
  const t = 1_000_000;
  assert.ok(limiter.tryAcquire(t));
  assert.ok(limiter.tryAcquire(t + 1));
  assert.ok(limiter.tryAcquire(t + 2));
  assert.ok(!limiter.tryAcquire(t + 3), "fourth inside the window is refused");
  assert.equal(limiter.count(t + 3), 3);
  assert.ok(limiter.tryAcquire(t + 60_001), "allowed again after the window");
});

test("rate limiter of 0 means unlimited", () => {
  const limiter = new RateLimiter(0);
  for (let i = 0; i < 100; i++) assert.ok(limiter.tryAcquire(1000 + i));
});

test("eligibility refuses the bot itself", () => {
  const e = checkEligibility({ username: "Bot", selfUsername: "bot", blacklist: [], distance: 1, maxDistance: 24 });
  assert.equal(e.reason, "self");
  assert.ok(!e.eligible);
});

test("eligibility refuses blacklisted players", () => {
  const e = checkEligibility({ username: "Griefer", selfUsername: "Bot", blacklist: ["griefer"], distance: 1, maxDistance: 24 });
  assert.equal(e.reason, "blacklisted");
});

test("eligibility refuses distant players", () => {
  const e = checkEligibility({ username: "Steve", selfUsername: "Bot", blacklist: [], distance: 50, maxDistance: 24 });
  assert.equal(e.reason, "too-far");
});

test("eligibility refuses players with no known position", () => {
  const e = checkEligibility({ username: "Steve", selfUsername: "Bot", blacklist: [], distance: null, maxDistance: 24 });
  assert.equal(e.reason, "unknown-player");
});

test("distance 0 disables the proximity check", () => {
  const e = checkEligibility({ username: "Steve", selfUsername: "Bot", blacklist: [], distance: null, maxDistance: 0 });
  assert.ok(e.eligible);
});

test("eligibility allows a normal nearby player", () => {
  const e = checkEligibility({ username: "Steve", selfUsername: "Bot", blacklist: [], distance: 4, maxDistance: 24 });
  assert.ok(e.eligible);
});

test("formatDuration is human readable", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(252_000), "4m 12s");
});
