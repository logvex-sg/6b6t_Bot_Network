/**
 * Live kit delivery.
 *
 * The only place that touches the mineflayer bot for kit purposes. All drops go through normal
 * `bot.toss` / `bot.tossStack` calls — the same actions a player performs by pressing Q. No packets are
 * forged and nothing is created from thin air: if the item is not in the inventory, nothing is dropped.
 */

import type { Bot } from "mineflayer";
import type { KitPlan, StockLine } from "./kit.ts";

export interface HeldItem {
  name: string;
  count: number;
  slot: number;
}

export interface KitRuntimeDeps {
  /** Resolves to the live bot, or throws when not connected. */
  requireBot: () => Bot;
  /** Sleep helper so the runtime can be tested without real timers. */
  delay?: (ms: number) => Promise<void>;
}

/** Snapshot of what the bot is carrying, excluding the armour/offhand tail of the inventory. */
export function readHeld(bot: Bot): HeldItem[] {
  const slots = bot?.inventory?.slots ?? [];
  const out: HeldItem[] = [];
  for (let slot = 0; slot < slots.length; slot++) {
    const item = slots[slot];
    if (!item) continue;
    const name = (item as { name?: string }).name;
    const count = (item as { count?: number }).count;
    if (!name || !Number.isFinite(count) || (count ?? 0) <= 0) continue;
    out.push({ name, count: count as number, slot });
  }
  return out;
}

/** Aggregates held items into an item-name → total-count map for `planKit`. */
export function heldTotals(items: HeldItem[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const item of items) {
    totals[item.name] = (totals[item.name] ?? 0) + item.count;
  }
  return totals;
}

/** Free slots in the main inventory (36 = PlayerInventory main size). */
export function freeSlots(bot: Bot): number {
  const slots = bot?.inventory?.slots ?? [];
  const main = Math.min(slots.length, 36);
  let used = 0;
  for (let i = 0; i < main; i++) if (slots[i]) used++;
  return Math.max(0, main - used);
}

export interface DropResult {
  item: string;
  requested: number;
  dropped: number;
}

/**
 * Drops the items named in `plan`. Counts are clamped to what the bot holds at drop time, and the loop
 * re-reads the inventory between items so a partial failure cannot over-drop.
 *
 * Returns one `DropResult` per plan line. Never throws for a missing item — it reports `dropped: 0`.
 */
export async function dropPlan(
  deps: KitRuntimeDeps,
  plan: KitPlan,
  onLine?: (line: DropResult) => void,
): Promise<DropResult[]> {
  const bot = deps.requireBot();
  const wait = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const results: DropResult[] = [];

  for (const line of plan.lines) {
    if (line.give <= 0) {
      const empty: DropResult = { item: line.item, requested: line.wanted, dropped: 0 };
      results.push(empty);
      onLine?.(empty);
      continue;
    }
    const dropped = await dropItem(bot, line, wait);
    const result: DropResult = { item: line.item, requested: line.wanted, dropped };
    results.push(result);
    onLine?.(result);
    // Small gap between items so the client does not outrun the server's item-drop rate.
    await wait(120);
  }

  return results;
}

/** Drops up to `line.give` of a single item. Returns how many were actually dropped. */
async function dropItem(bot: Bot, line: StockLine, wait: (ms: number) => Promise<void>): Promise<number> {
  let remaining = line.give;
  let dropped = 0;

  while (remaining > 0) {
    const held = readHeld(bot).filter((i) => i.name === line.item);
    if (held.length === 0) break;
    // Prefer the fullest stack so we drop whole stacks first and leave no fragments.
    held.sort((a, b) => b.count - a.count);
    const source = held[0];
    if (!source) break;

    const take = Math.min(remaining, source.count);
    const stack = bot.inventory.slots[source.slot] as { type: number; count: number } | null | undefined;
    if (!stack) break;

    try {
      if (take >= source.count) {
        await bot.tossStack(stack as never);
        dropped += source.count;
        remaining -= source.count;
      } else {
        await bot.toss(stack.type, null, take);
        dropped += take;
        remaining -= take;
      }
    } catch {
      // A failed toss (window race, server rejection) must not abort the whole kit.
      break;
    }
    await wait(80);
  }

  return dropped;
}

/** Walks to within `range` blocks of the player. Best-effort: returns false when it cannot. */
export async function approachPlayer(bot: Bot, username: string, range = 3, timeoutMs = 8000): Promise<boolean> {
  const player = bot?.players?.[username];
  const entity = player?.entity;
  if (!entity) return false;
  try {
    const { goals } = await import("mineflayer-pathfinder");
    await bot.pathfinder.goto(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, range));
    return true;
  } catch {
    return false;
  }
}
