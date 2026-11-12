# Kit Bot Guide

The kit bot hands items out to other players who ask for them in chat. It is designed to be **easy to use
and safe to leave running**: every hand-out is a normal Minecraft item drop, it is gated behind a chat
prefix, and it refuses to serve anyone the operator has not implicitly allowed.

This guide covers what it does, how to drive it, the safety model, and the design rules that keep it from
misbehaving.

---

## What it does

- Watches chat for `<prefix>kit` (default `!kit`).
- Checks the requester is close enough, not blacklisted, not the bot itself, and not on cooldown.
- Checks the bot actually has the kit items and free inventory space.
- Drops the kit items one stack at a time using `bot.toss` / `bot.tossStack` — exactly what a player does
  by pressing Q. **Nothing is forged**: if the item is not in the inventory, nothing is dropped.
- Optionally replies in chat, walks to the player first, and can be driven from the CLI, the dashboard or
  Discord.

It never creates items, never touches the network protocol, and never runs while the bot is disconnected.

---

## Standalone mode — one process, one web page (recommended)

The full client splits the bot (a daemon that serves the control API) from the CLI (a client that talks to
it). That is necessary for a fleet, but overkill for a single kit bot: you have to keep the daemon alive,
`npm link` the CLI, and edit `Settings/settings.json` before anything works.

**Standalone mode** collapses all of that into one process with a web page for control:

```bash
npm run kibot
```

It prints a URL — open it in any browser on the same machine:

```
Kit bot running. Open:  http://127.0.0.1:37777
```

The page lets you:

- Enter **host / port / username / password / version** and press **Connect** — no file editing.
- **Start / Stop** serving, view **Stock**, and read live **status** (health, food, position, world, kits,
  served counts, event log).
- Edit **kit settings** (prefix, cooldown, distance, announce, walk, blacklist) and save them.
- **Give a kit now** to a named player.

It reuses the exact same tested pieces the full client uses — `attachAuth` for the `/login` handshake,
`createPortalNavigator` to walk the lobby portals into the survival world, and `KitBotController` for the
serve path and every guard rail. It auto-reconnects if kicked, and the credentials are stored in
`Settings/kitbot-standalone.json` (git-ignored, mode 0600) only after you press Connect.

Change the port with `KITBOT_PORT=12345 npm run kibot`. The page binds to `127.0.0.1` only, so it is not
reachable from other machines.

Use standalone mode when you want *a kit bot*. Use the daemon + CLI below when you want it as one part of a
managed fleet.

---

## Quick start (fleet / daemon mode)

```bash
fractalbot join                 # connect the bot
fractalbot kibot start          # start serving kits (default prefix `!`)
fractalbot kibot status         # active state, kits, counters
fractalbot kibot stock          # what the bot is carrying for the default kit
fractalbot kibot stop
```

A player then types `!kit` in chat and the bot drops the default kit next to them.

From Discord (prefix `!` by default): `!kibot start`, `!kibot status`, `!kibot give Steve`.

From the web dashboard: open the **Kit Bot** tab.

---

## The safety model

The kit bot is intentionally conservative. A request is served only when **all** of the following hold:

| Gate | Rule | Config key |
| --- | --- | --- |
| Prefix | The message must start with the configured prefix. | `prefix` |
| Self | The bot never reacts to its own chat (no feedback loop). | — |
| Blacklist | Named players are never served. | `blacklist` |
| Proximity | The player must be within `maxDistance` blocks (0 disables the check). | `maxDistance` |
| Cooldown | One kit per player per `cooldownMs`. | `cooldownMs` |
| Rate limit | At most `maxServesPerMinute` kits across the whole bot per rolling minute. | `maxServesPerMinute` |
| Stock | At least one kit item must actually be in the inventory. | kit definition |
| Space | The bot must have at least `minFreeSlots` free main-inventory slots. | `minFreeSlots` |

Every refusal is reported (chat reply when `announce` is on, plus an event the UI mirrors) — the bot tells
the player *why* instead of silently ignoring them.

**Why a prefix?** It keeps the bot from reacting to ordinary conversation. Only a line that *starts* with
the prefix and *is* the `kit` command is acted on; everything else is ignored.

---

## Commands

### CLI (`fractalbot kibot …`)

```bash
fractalbot kibot start [options]     # start serving
fractalbot kibot stop                # stop serving
fractalbot kibot status              # state, kits, counters
fractalbot kibot stock [kit]         # available vs wanted for a kit
fractalbot kibot give <player> [kit] # hand a kit out now (bypasses the cooldown for the target)
fractalbot kibot reset               # clear all per-player cooldowns
fractalbot kibot config [options]    # show or update settings
```

`kibot start` options:

| Option | Meaning |
| --- | --- |
| `-p, --prefix <prefix>` | Chat prefix (default `!`). |
| `-c, --cooldown <seconds>` | Per-player cooldown. |
| `-d, --distance <blocks>` | Max serve distance (0 = anywhere). |
| `--no-announce` | Do not reply in chat on hand-out. |
| `--walk` | Walk to the player before dropping. |

`kibot config` options mirror the above plus `--blacklist <names>` (comma-separated).

### Discord

```
!kibot start [prefix] [cooldownSec] [distance]
!kibot stop
!kibot status
!kibot stock [kit]
!kibot give <player> [kit]
!kibot reset
!kibot config prefix ! cooldown 300 distance 24 announce on blacklist griefer,spammer
```

### Dashboard

The **Kit Bot** tab has Start / Stop / Refresh / Stock / Reset controls, a settings form (prefix, cooldown,
distance, announce, walk, blacklist) and a "give now" box. Settings are written back to the per-server
config, so they survive a restart.

### Control API

All of the above are RPC actions: `kitBotStart`, `kitBotStop`, `kitBotStatus`, `kitBotConfig`,
`kitBotServe`, `kitBotStock`, `kitBotResetCooldowns`.

---

## Configuration

Stored per server at `Settings/kitbot/<server>/config.json` (atomic writes; a corrupt file is ignored and
the defaults are used). `Settings/` is git-ignored.

| Key | Default | Meaning |
| --- | --- | --- |
| `prefix` | `!` | Chat prefix a player must type. |
| `defaultKit` | `default` | Kit handed out when no kit name is given. |
| `kits` | one `default` kit | The kit definitions (see below). |
| `cooldownMs` | `300000` | Per-player cooldown between kits. |
| `maxServesPerMinute` | `6` | Global rolling rate limit (0 = unlimited). |
| `maxDistance` | `24` | Serve radius in blocks (0 = anywhere). |
| `announce` | `true` | Reply in chat on hand-out / refusal. |
| `walkToPlayer` | `false` | Walk to the player before dropping. |
| `minFreeSlots` | `1` | Minimum free main-inventory slots to serve. |
| `blacklist` | `[]` | Player names never served. |

### Defining kits

A kit is a name plus a list of `{ item, count }` where `item` is a Minecraft item id:

```json
{
  "kits": [
    {
      "name": "default",
      "items": [
        { "item": "stone_sword", "count": 1 },
        { "item": "bread", "count": 8 }
      ]
    },
    {
      "name": "pvp",
      "cooldownMs": 600000,
      "items": [
        { "item": "diamond_sword", "count": 1 },
        { "item": "cooked_beef", "count": 16 },
        { "item": "ender_pearl", "count": 16 }
      ]
    }
  ]
}
```

A kit may override `cooldownMs` for itself. Players ask for a named kit with `!kit pvp`; asking for
`!kit` alone gives the `defaultKit`. An unknown kit name is refused.

---

## How it is built

```
src/kitbot/
├── chatParse.ts     pure: chat line → { username, message } and prefix matching
├── kit.ts           pure: kit defs, stock maths, cooldowns, rate limiter, eligibility
├── runtime.ts       live: reads the inventory, drops items via toss/tossStack
├── controller.ts    ties it together: the serve path and all the guards
└── *.test.ts        unit tests with a fake bot
```

- **Pure logic is separate from live Minecraft access.** `chatParse.ts` and `kit.ts` take plain values, so
  every rule (cooldown, rate limit, eligibility, stock plan) is unit-tested without a server.
- **The controller holds no `Bot`.** It goes through injected `deps`, which is why the whole serve path can
  be tested with a fake bot.
- **The chat hook is cheap when idle.** `FractalBot` calls the controller only when the kit bot is active,
  and the controller returns `null` immediately for any line that is not a kit request.
- **Drops are clamped to the live inventory.** `dropItem` re-reads the inventory between items, so a
  partial failure cannot over-drop.
- **A failed toss never aborts the kit.** A window race or server rejection is caught and reported, not
  thrown.

### Hard rules

- **Never create items.** Only `toss` / `tossStack` — the same calls a player makes. If it is not in the
  inventory, nothing is dropped.
- **Never react to your own chat.** The self-check in `checkEligibility` prevents the classic kit-bot
  feedback loop.
- **A chat handler never throws.** `handleChat` catches everything and reports; the caller wraps it again.
- **Bounded memory.** Cooldowns are pruned on every serve and the rate limiter never stores more than
  `maxServesPerMinute` timestamps.
- **Report, do not pretend.** A refusal returns a reason (`denied-far`, `out-of-stock`, …) and the UI /
  Discord surface it. Where the server prevents an operation, say so.

---

## Tests

`src/kitbot/*.test.ts` and `src/settings/kitBotConfigStore.test.ts` cover chat parsing, stock planning,
cooldowns, the rate limiter, eligibility, the config store, and the full serve path against a fake bot.
Run them with `npm test`.
