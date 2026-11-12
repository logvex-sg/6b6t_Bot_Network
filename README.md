# Fractal42O Bot Network

Mineflayer control system for the **6b6t** anarchy server.

Offline-account join with stored `/login`, dual-portal lobby navigation, auto-rejoin with captcha handling, multi-account fleet, elytra terrain mapping (Xaero regions), a CLI with tab completion, a web dashboard, and an HTTP/WebSocket control API.

> Made by **Fractal42O** for the **6b6t** community.

---

## Features

- **Offline join** — credentials in `Settings/`; password is never prompted at runtime
- **Lobby navigation** — auto-walk the two server portals out of the lobby
- **Auto-reconnect** — exponential backoff; longer cooldown (or halt) on captcha / rate-limit kicks
- **Captcha alerts** — browser notifications + optional Discord mirror
- **CLI** — join, chat, movement, inventory, map, hunt, base hunting, shell with tab completion
- **Web dashboard** — cyberpunk control UI (fleet, live view, hunt, settings, activity log)
- **Control API** — HTTP + WebSocket RPC for external tools / UIs
- **Fleet** — multiple accounts with per-bot features: online, hunt, map, announcements, anti-AFK
- **Elytra mapper** — flight + Xaero region writer (box / spawn / ring / direction modes)
- **Base hunting** — autonomous exploration: elytra flight, stash scanning, ender-chest restocking, Mending, survival guard, persistent per-server database
- **Kit bot** — hand items out to players who type a chat prefix (`!kit`); prefix-gated, proximity/cooldown/rate-limited, drops real items only. Run it standalone with `npm run kibot` (browser control page, no config editing)
- **Optional Discord** — remote `!status`, `!chat`, `!map`, `!bh …`, `!kibot …`, etc.

> The base-hunting subsystem is documented in depth in **[docs/BASE_HUNTING.md](docs/BASE_HUNTING.md)**.
> The kit bot is documented in **[docs/KIT_BOT.md](docs/KIT_BOT.md)**.

---

## Requirements

- **Node.js ≥ 20**
- Offline Minecraft account that can join 6b6t (or Microsoft auth if configured)

---

## Setup

```bash
npm install
```

Configuration lives under **`Settings/`**:

| Path | Purpose |
|------|---------|
| `Settings/settings.json` | Global options (host, control API, reconnect, map, Discord, …) |
| `Settings/Profiles/<id>.json` | One file per account (credentials + features + overrides) |
| `Settings/announcements.json` | Default timed chat messages |

On first run, a legacy `.env` / `accounts.json` is migrated if present.

Minimal `Settings/settings.json`:

```json
{
  "version": 1,
  "values": {
    "MC_HOST": "alt3.6b6t.org",
    "MC_PORT": "25565",
    "MC_USERNAME": "your_account",
    "MC_PASSWORD": "...",
    "MC_AUTH": "offline",
    "CONTROL_HOST": "127.0.0.1",
    "CONTROL_PORT": "20972",
    "SERVER_PORTALS": "2"
  }
}
```

Optional CLI on PATH:

```bash
npm link
eval "$(fractalbot completion zsh)"   # or: fractalbot completion bash
```

---

## Usage

### Start (dashboard + control API)

```bash
npm start
# or
fractalbot
```

Open the dashboard at `http://127.0.0.1:20972` (port from `CONTROL_PORT`).

### CLI essentials

```bash
fractalbot join              # join + /login, then interactive shell
fractalbot join --daemon     # join and keep running in background
fractalbot status
fractalbot chat hello
fractalbot cmd home
fractalbot map               # ASCII top-down of the area
fractalbot hunt              # walk server portals out of lobby
fractalbot unhunt
fractalbot leave

fractalbot map-start box     # elytra map: box | spawn | ring | north | ...
fractalbot map-status
fractalbot map-stop

fractalbot bh start spiral   # autonomous base hunting: grid | spiral | adaptive | direction
fractalbot bh status
fractalbot bh stash          # nearest recorded stashes
fractalbot bh restock        # restock from the nearest ender chest
fractalbot bh stop

fractalbot kibot start       # serve kits to players who type `!kit`
fractalbot kibot status
fractalbot kibot give Steve  # hand a kit out now
fractalbot kibot stop

npm run kibot                # standalone kit bot: one process + browser control page (no config editing)
```

Other useful commands: `goto`, `look`, `walk`, `stop`, `attack`, `dig`, `inv`, `players`, `view`, `shell`, `completion`.

See **[docs/BASE_HUNTING.md](docs/BASE_HUNTING.md)** for the full `bh` command set, the hunt config, and
how the autonomous controller schedules flight, scanning, Mending and ender-chest restocking.
See **[docs/KIT_BOT.md](docs/KIT_BOT.md)** for the kit bot, its safety gates and its config.

### Discord (optional)

```bash
npm install discord.js
```

In `Settings/settings.json`:

```json
"DISCORD_ENABLED": "1",
"DISCORD_TOKEN": "your_bot_token",
"DISCORD_CHANNEL_ID": "123456789012345678",
"DISCORD_MIRROR_LOGS": "1"
```

Enable **Message Content Intent** for the bot. Commands: `!help`, `!status`, `!join` / `!leave`, `!chat`, `!cmd`, `!hunt`, `!map on|off|status`, `!captcha`.

### Fleet

Each account is a profile under `Settings/Profiles/`. Use the dashboard **Fleet** panel (or API) to add accounts, toggle features (online / hunt / map / announcements / anti-AFK), and start/stop bots.

### Programmatic use

```ts
import { FractalBot } from "fractalbot";
import { loadConfig } from "fractalbot/config";

const bot = new FractalBot(loadConfig());
await bot.join();
```

Control API: `POST /v1/rpc` with JSON body `{ "action": "...", ... }` (token required if `CONTROL_TOKEN` is set). Event stream: WebSocket `/v1/events`.

---

## Run

```bash
npm install
npm start
```

Opens the control API + web dashboard (default `http://127.0.0.1:20972`).

```bash
fractalbot join              # join and open interactive shell
fractalbot join --daemon     # join and keep running in background
```

Optional checks:

```bash
npm run typecheck
npm test
```

---

## Credits & Inspiration

**Made by [Fractal42O](https://github.com/Fractal42O) for the 6b6t community.**

Built on and inspired by:

| Project | Link |
|---------|------|
| Original 6bBotAPI | https://github.com/ClapFy/6bBotAPI |
| GaBaus Sky Logo Builder | https://github.com/RealGaBaus/GaBaus-Sky-Logo-Builder |
| Mineflayer Elytra Mapper | https://github.com/fpvwraith/Mineflayer-Elytra-Mapper |
| Mineflayer Mapart Bot | https://github.com/ComicSquid74273/mineflayer-Mapart-Bot |
| THC Announcements Bot | https://github.com/stubbledbannana/THC-Anouncements-Bot |
| 6b6t Join Bot | https://github.com/NOSLEEPSMOKE/6b6t-join-bot |

License: MIT — see [LICENSE](LICENSE).
