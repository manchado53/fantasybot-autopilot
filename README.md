# FantasyBot

Autopilot for an ESPN fantasy football league. A **Claude Code scheduled
routine** runs on a schedule, reads the league, and manages the team itself:
lineup, IR, free agents, waivers, trades. Then it reports what it did on
Telegram.

> ⚠️ Uses ESPN's **unofficial** fantasy API with your own login cookies. It isn't affiliated with or endorsed by ESPN, and may break or conflict with ESPN's terms. Use at your own risk. Start in `dry` mode.

## How it works

### The big picture

```mermaid
flowchart LR
    subgraph cloud["☁️ Anthropic cloud (Claude Code routine)"]
        CRON["⏰ Schedule<br/>daily 9:07 · Tue 20:07<br/>Mon/Thu 17:07 · Sun 11:07 + 14:37 CT"]
        AGENT["🧠 Claude (Opus 5.5)<br/>follows bot/AUTOPILOT.md"]
        CLI["🔧 Tool CLI<br/>bot/tools/cli.ts"]
        GUARD{"🛡️ Write guard<br/>(code)"}
        CRON --> AGENT
        AGENT -- "npm run tool -- …" --> CLI
        CLI --> GUARD
    end

    subgraph sources["📥 What it reads"]
        ESPN_R["ESPN league<br/>roster · free agents · trades<br/>projections · rest-of-season · byes"]
        NEWS["ESPN / Rotowire<br/>player news"]
        SLEEP["Sleeper<br/>trending adds"]
        FC["FantasyCalc<br/>trade values"]
        WEB["WebSearch<br/>breaking news"]
    end

    CLI --> ESPN_R & NEWS & SLEEP & FC
    AGENT --> WEB

    GUARD -- "live" --> ESPN_W["✍️ ESPN writes<br/>lineup · IR · add/drop · trades"]
    GUARD -- "dry / paused" --> LOG["📝 logged only"]

    CLI <--> STATE[("🗂️ bot-state branch<br/>action log · mode · memory")]
    CLI -- "report" --> TG["📱 Telegram<br/>(you)"]
    TG -- "/pause /live /dry<br/>or any instruction" --> CLI
```

### One run, step by step

```mermaid
sequenceDiagram
    autonumber
    participant R as Routine
    participant C as Claude
    participant T as Tool CLI
    participant E as ESPN
    participant Y as You (Telegram)

    R->>C: fresh cloud box + repo + prompt
    C->>T: state:pull (memory from bot-state)
    C->>T: inbox
    T-->>C: your texts (/pause, /live, "don't drop X")
    C->>T: status
    T->>E: league, roster, news, byes
    T-->>C: roster w/ ROS + news, standings, its recent moves
    C->>T: news <ids> (+ WebSearch)
    Note over C: decide: IR → lineup → waivers → trades
    C->>T: set-lineup / move-ir / add / respond-trade --reason "…"
    T->>T: write guard: paused? dry? propose locked?
    T->>E: real write (live only)
    E-->>T: ok / error
    C->>T: report "what I did + why"
    T->>Y: 📱 Telegram report
    C->>T: state:push (save memory)
```

### The safety switches

```mermaid
flowchart TD
    W["Claude calls a write<br/>(must give --reason)"] --> P{"paused?<br/>(/pause)"}
    P -- yes --> REF["❌ refused"]
    P -- no --> PT{"propose-trade<br/>and not verified?"}
    PT -- yes --> REF
    PT -- no --> M{"mode?"}
    M -- "dry (/dry)" --> WD["🧪 would_do<br/>nothing sent"]
    M -- "live (/live)" --> SEND["✅ sent to ESPN"]
    REF & WD & SEND --> AL[("action-log.json<br/>+ Telegram report")]
```

These checks live **in code** (`guardedWrite` in `bot/tools/cli.ts`), not in the prompt, so Claude can't talk its way past them.

### How trade ideas work

Trades are split between **code** (deterministic math, `bot/decisions/tradeFinder.ts`) and **the agent** (judgment, `bot/AUTOPILOT.md`). The rules come from published fantasy trade strategy (PFF, FantasyPros, Footballguys, Fantasy Footballers).

```mermaid
flowchart TD
    subgraph code["🔢 Code: same input → same output"]
        V["1. Value every player<br/>rest-of-season pts/game"]
        R["2. Replacement level<br/>2nd-best healthy free agent per position"]
        VORP["3. VORP = value − replacement<br/>(raw points overrate QBs)"]
        CH["4. Trade chips<br/>depth beyond starters+backups<br/>with VORP ≥ 1"]
        ND["5. Needs<br/>starter level below league median<br/>(RB/WR count the real FLEX)"]
        M["6. Match<br/>1-for-1 · two-way 1-for-1 · 2-for-1"]
        F{"7. Filters<br/>FantasyCalc gap ≤ 35%?<br/>their VORP change ≥ −1.5?"}
        RK["8. Rank<br/>two-way › likely › upgrade<br/>+ buy-low / sell-high / easy playoffs"]
        V --> VORP
        R --> VORP
        VORP --> CH & ND --> M --> F
        F -- pass --> RK
        F -- fail --> X["dropped:<br/>they'd say no"]
    end

    subgraph agent["🧠 Agent: judgment"]
        N["read news on every player"]
        G["gut check from THEIR side"]
        O["opening offer<br/>(sweetener only if they counter)"]
        RPT["📱 report the best idea<br/>(propose-trade locked)"]
        N --> G --> O --> RPT
    end

    RK --> N
```

**Why VORP matters (real example, week 9):**

| Player | ROS pts/game | Free-agent replacement | VORP |
|---|---|---|---|
| Patrick Mahomes (your 3rd QB) | 17.4 | 15.0 (QB) | **+2.4** |
| Tony Pollard (target) | 15.4 | 8.6 (RB) | **+6.8** |
| Josh Jacobs (target) | 17.6 | 8.6 (RB) | **+9.0** |

On raw points Mahomes ≈ Jacobs. On VORP he's worth about a quarter of him, because a 15/g QB is free on waivers. So the finder returns **no idea** rather than an offer nobody would accept. The playbook then treats a low-VORP extra QB as a wasted roster spot to drop for a needed waiver add.

**Signals on every player line:**

```
PO x1.21 easy   -> weeks 15-17 opponents allow 21% more fantasy pts than average (ESPN defense-vs-position)
PO x0.77 hard   -> 23% fewer
BUY-LOW?        -> scoring well below his rest-of-season projection: likely to bounce back
SELL-HIGH?      -> scoring well above it: likely to cool off
```

### What the agent sees each run

| Source | What it gives | Command |
|---|---|---|
| ESPN league | roster, slots, injury tag, % owned, locked?, record, opponent, standings, waiver rules, trade deadline | `status` |
| ESPN stats | this-week projection, **rest-of-season pts/game**, season average | `status`, `free-agents` |
| ESPN / Rotowire | **player news**: injuries, coach quotes, timelines | `news <ids>` (+ inline headline) |
| ESPN schedule | bye weeks | `status` (`upcomingByes`) |
| ESPN opponent ratings ("OPRK") | fantasy-playoff schedule strength per player, weeks 15–17 (`PO x1.12 easy`) | `status`, `free-agents`, `trade-ideas` |
| Derived | buy-low / sell-high flag (actual vs ROS), VORP vs the 2nd-best free agent | `status`, `trade-ideas` |
| Its own log | its moves from the last 7 days (no flip-flopping) | `status` (`recentActions`) |
| Sleeper | trending adds (24h) | `free-agents` |
| FantasyCalc | trade values / fairness | `trades`, `trade-ideas` |
| WebSearch | breaking news, game-day inactives | Claude's own tool |
| You | `/pause` `/resume` `/dry` `/live` + free-text instructions | `inbox` |

### Key pieces

- **Brain**: Claude, following `bot/AUTOPILOT.md`. The old projection and
  optimizer code is still there as tools Claude can call.
- **Memory**: `bot/state/*.json` lives on the `bot-state` branch
  (`npm run state:pull` / `state:push`). Runs never commit to `master`.
- **Audit trail**: every write attempt (dry or live) and Claude's reason
  goes in `bot/state/action-log.json`.
- **Secrets**: environment variables on the routine's cloud environment.
  Claude can read them. That's an accepted tradeoff (no true vault there).
- `bot/run.ts` (the old tap-to-approve bot) still works as a manual fallback,
  but nothing schedules it anymore.

## Local setup (for testing)

1. `npm install`
2. Copy `bot/config.example.json` to `bot/config.json` and fill in your
   ESPN cookies, team info, and Telegram bot token/chat id.
   **`bot/config.json` is gitignored — local-only, never committed.**
3. `npm run espn:test` — confirms cookie auth works, prints your roster (or
   lists all teams if `teamId` isn't set yet, so you can find yours).
4. `npm run telegram:test` — sends a test message with a button; tap it, run
   again to confirm the bot sees the tap.
5. `DRY_RUN=1 npm run bot:run` — one full pass, logs intended actions instead
   of touching ESPN/Telegram live.
6. Once verified: `npm run bot:run` for a real local run.

## Production setup (Claude routine)

1. Cloud environment env vars (same names `bot/state/store.ts` reads):
   `ESPN_LEAGUE_ID ESPN_SEASON_YEAR ESPN_SWID ESPN_S2 ESPN_TEAM_ID
   ESPN_TEAM_NAME TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID`.
2. Network access: **Custom**, allowing `lm-api-reads.fantasy.espn.com`,
   `lm-api-writes.fantasy.espn.com`, `site.api.espn.com` (player news), `api.telegram.org`, `api.sleeper.app`,
   `api.fantasycalc.com`, `*.fantasypros.com`, plus the default package hosts.
3. Routine prompt: run `npm ci` and `npm run state:pull`, follow
   `bot/AUTOPILOT.md`, finish with `npm run state:push`. Never edit code.
4. Schedule (`CRON_TZ=America/Chicago`): daily 09:07, Tue 20:07,
   Thu 17:07, Sun 11:07 + 14:37, Mon 17:07.
5. Start in `dry` mode. After a week of good reports, text the bot `/live`.

## Status

- Reads, the write guard, dry mode, and waiver claims are tested against the real league.
- `setLineup` is verified live. `move-ir` (slot 21), `add` for instant free
  agents (`FREEAGENT` txn) and `respond-trade` still say NEEDS LIVE
  VERIFICATION in `bot/espn/client.ts`.
- `propose-trade` is locked until the supervised live test.
