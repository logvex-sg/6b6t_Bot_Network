# AGENTS.md

FractalBot is a mineflayer control system for the **6b6t** anarchy server (Node.js ≥ 20, TypeScript,
ESM). It provides offline-account joining, lobby navigation, a fleet, a CLI, a web dashboard, an
HTTP/WebSocket control API, an elytra terrain mapper, and an autonomous base-hunting subsystem.

## Commands

```bash
npm install
npm run typecheck        # tsc --noEmit (the "build" script is also typecheck-only)
npm test                 # node:test — lobby + hunt + settings suites
npm start                # run the bot (npx tsx src/index.ts)
npm run dev              # interactive shell
```

There is no bundler step; the bot runs straight from TypeScript via `tsx`. `npm run build` only typechecks,
so a green build proves types, not runtime behaviour. Run `npm test` as well.

## Architecture

```
src/
├── index.ts                 entrypoint + CLI bootstrap
├── config.ts                FractalConfig from Settings/settings.json (+ legacy .env)
├── api/
│   ├── FractalBot.ts        the bot wrapper: join, inventory, mapping, hunt wiring
│   ├── controlServer.ts     HTTP + WebSocket RPC server
│   ├── catalog.ts           RPC action descriptors + allowlist
│   └── types.ts             ControlRequest/Response unions and event map
├── cli/program.ts           `fractalbot …` command tree (commander)
├── discord/control.ts       optional Discord command handling + log mirror
├── fleet/FleetManager.ts    multi-account supervisor
├── hunt/                    autonomous base hunting (see below)
├── kitbot/                  kit serving on chat (see below)
├── settings/                Settings/ layout, profiles, homes, hunt + kitbot config
├── minecraft/               join/auth/lobby/protocol/mapping helpers
├── mapper/                  Xaero region writer bridge
└── web/                     dashboard (index.html, app.js, app.css)
```

## Base hunting

The hunt subsystem lives in `src/hunt/`. Pure logic is separated from live Minecraft access so it can be
tested without a server:

- **Pure** — `flight.ts`, `mending.ts`, `survival.ts`, `inventory.ts`, `scoring.ts`, `exploration.ts`,
  `scheduler.ts`, `notifications.ts`.
- **Live** — `flightRuntime.ts`, `elytraRuntime.ts`, `mendingRuntime.ts`, `survivalRuntime.ts`,
  `enderChestRuntime.ts`, `scanner.ts` (reads the world), `database.ts` (disk), `controller.ts` (the loop).

`HuntController.tick()` is the only place automation runs, and it never throws. It runs survival →
scanning → route → mending each tick. It is a single scheduler owner, so it releases all its leases at the
top of a tick and re-acquires what the current phase needs — that is what prevents two concerns from
fighting over movement, the inventory or equipment.

Read `docs/BASE_HUNTING.md` before changing hunt behaviour; it documents the phases, config keys and design
rules.

### Hard rules

- **One owner per control resource.** Any code that moves the player, touches the inventory window, or
  equips items must acquire the matching `Scheduler` lease (`movement` / `inventory` / `equipment` /
  `chat`) first and release it after. Never move the player without a lease.
- **`ElytraManager`-equivalent ownership.** `elytraRuntime.equipBestElytra` is the only path that swaps an
  elytra. Do not add a second place that equips one — two owners racing to swap the same chest slot is
  worse than one.
- **Never block the tick.** Scanning is budgeted (`scanBudget`), disk writes are debounced + atomic,
  notifications are fire-and-forget. No synchronous network or unbounded disk work inside the loop.
- **Null-safe everywhere.** A tick with no bot, no world, or a mid-transition dimension must log and return.
- **Survival never disconnects.** `survival.ts` signals a critical condition; AutoLog owns the actual
  disconnect so the two do not run competing control loops.
- **XP must be real.** Mending only runs when there is a nearby `experience_orb` or throwable bottles —
  never assume an XP source.

### Persistence

- Hunt database: `Settings/hunt/<server>/database.json` — atomic writes, versioned, corrupt files
  quarantined as `*.corrupt-<ts>`, de-duplicated records, pruned by age.
- Hunt config: `Settings/hunt/<server>/config.json` — atomic, per-server, merged over defaults on load.
- `Settings/hunt/` is git-ignored. Never commit it.

## Kit bot

The kit bot lives in `src/kitbot/` and hands items to players who type a chat prefix (`!kit` by default).

Two ways to run it:

- **Standalone** — `npm run kibot` starts `src/kitbot/standalone.ts`: one process that connects a bot, walks
  the lobby, serves kits, and hosts a control page on `http://127.0.0.1:37777`. It needs no daemon, no
  `npm link` and no hand-edited config — credentials and kit settings are entered in the page and persisted
  to `Settings/kitbot-standalone.json`. This is the recommended path for a single kit bot.
- **Fleet** — the `fractalbot kibot …` CLI / Discord / dashboard commands, which proxy over the control API
  to a bot started with `fractalbot join`.

- **Pure** — `chatParse.ts` (chat line → username + prefix match), `kit.ts` (kit definitions, stock
  planning, cooldowns, rate limiter, eligibility).
- **Live** — `runtime.ts` (reads the inventory, drops via `toss`/`tossStack`), `controller.ts` (the serve
  path and every guard rail).

`FractalBot` calls `KitBotController.handleChat` from the chat hook **only when the kit bot is active**, and
the controller returns `null` for anything that is not a kit request — an idle kit bot costs nothing.
`src/settings/kitBotConfigStore.ts` persists the per-server config to `Settings/kitbot/<server>/config.json`.

`standalone.ts` reuses the same tested pieces rather than reimplementing them: `attachAuth` for the in-game
`/login`, `createPortalNavigator` for the lobby portal walk, and `KitBotController` for the serve path. It
does **not** reimplement or duplicate that logic — keep it that way.

Read `docs/KIT_BOT.md` before changing kit-bot behaviour.

### Hard rules

- **Never create items.** Only `bot.toss` / `bot.tossStack` — the same calls a player makes. If the item is
  not in the inventory, nothing is dropped.
- **Never react to your own chat.** `checkEligibility` rejects the bot's own username; this is the kit-bot
  feedback loop guard.
- **A chat handler never throws.** `handleChat` catches everything and returns a reason; `FractalBot` wraps
  the call again.
- **Report, do not pretend.** Every refusal returns a reason (`denied-far`, `out-of-stock`, `rate-limited`,
  …) which the CLI / Discord / dashboard surface. Where the server prevents an operation, say so.
- **Bounded memory.** Cooldowns are pruned each serve; the rate limiter keeps at most `maxServesPerMinute`
  timestamps.
- `Settings/kitbot/` is git-ignored. Never commit it. The standalone config `Settings/kitbot-standalone.json`
  holds credentials — keep it git-ignored and never print it.

## Conventions

- TypeScript ESM: imports use explicit `.ts` extensions (tsx resolves them).
- Tests use `node:test` + `node:assert/strict`, are named `*.test.ts`, and must be added to the `test`
  script's globs in `package.json` if they live in a new directory.
- Live-Minecraft code takes a `Bot` and reads only the members it needs; tests supply a minimal fake bot
  rather than a full mineflayer instance.
- Do not add dependencies for the hunt subsystem — it uses only what is already present.
- Keep credentials out of the repo. Accounts/profiles live under `Settings/` (git-ignored); never hardcode
  a username, password or token in source, tests, docs or commit messages.

## Control API

RPC actions are declared in `src/api/catalog.ts` (descriptor + allowlist), typed in `src/api/types.ts`,
and handled in `src/api/controlServer.ts`. When adding an action, update all three, plus any Discord/CLI/web
surface that should expose it.
