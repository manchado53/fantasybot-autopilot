import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { BotConfig, DecisionLogEntry } from "../types.js";

const STATE_DIR = path.resolve(import.meta.dirname, ".");

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path.join(STATE_DIR, file), "utf-8");
    return JSON.parse(raw) as T;
  } catch (err: any) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(path.join(STATE_DIR, file), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/**
 * Two sources, same shape: GitHub Actions injects real secrets as env vars
 * (from GitHub's encrypted secrets vault — never touches the repo or a file).
 * Locally, bot/config.json (gitignored, never committed) is just a dev
 * convenience so you don't have to export env vars by hand while testing.
 */
export async function loadConfig(): Promise<BotConfig> {
  if (process.env.ESPN_S2) {
    return {
      espn: {
        leagueId: process.env.ESPN_LEAGUE_ID!,
        seasonYear: Number(process.env.ESPN_SEASON_YEAR),
        swid: process.env.ESPN_SWID!,
        espnS2: process.env.ESPN_S2!,
        teamId: process.env.ESPN_TEAM_ID ? Number(process.env.ESPN_TEAM_ID) : null,
        teamName: process.env.ESPN_TEAM_NAME ?? "",
      },
      telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN!,
        chatId: process.env.TELEGRAM_CHAT_ID!,
      },
      settings: {
        tradeLopsidedGapPct: Number(process.env.TRADE_LOPSIDED_GAP_PCT ?? 35),
        lineupApplyTimeoutMinutesBeforeLock: Number(process.env.LINEUP_APPLY_TIMEOUT_MINUTES ?? 60),
      },
    };
  }

  const configPath = path.resolve(import.meta.dirname, "../config.json");
  const raw = await readFile(configPath, "utf-8");
  return JSON.parse(raw) as BotConfig;
}

export async function loadDecisionLog(): Promise<DecisionLogEntry[]> {
  return readJson<DecisionLogEntry[]>("decision-log.json", []);
}

export async function saveDecisionLog(entries: DecisionLogEntry[]): Promise<void> {
  await writeJson("decision-log.json", entries);
}

export interface ProjectionAccuracyRecord {
  source: "espn" | "sleeper" | "fantasypros";
  position: string;
  trailingMae: number;
  weight: number;
  updatedAt: string;
}

export async function loadProjectionAccuracy(): Promise<ProjectionAccuracyRecord[]> {
  return readJson<ProjectionAccuracyRecord[]>("projection-accuracy.json", []);
}

export async function saveProjectionAccuracy(records: ProjectionAccuracyRecord[]): Promise<void> {
  await writeJson("projection-accuracy.json", records);
}

export interface TelegramCursor {
  lastUpdateId: number;
}

export async function loadTelegramCursor(): Promise<TelegramCursor> {
  return readJson<TelegramCursor>("telegram-cursor.json", { lastUpdateId: 0 });
}

export async function saveTelegramCursor(cursor: TelegramCursor): Promise<void> {
  await writeJson("telegram-cursor.json", cursor);
}

export async function loadRosterSnapshot<T>(week: number, fallback: T): Promise<T> {
  return readJson<T>(`roster-week-${week}.json`, fallback);
}

export interface TradeFinderState {
  lastRunDate: string; // YYYY-MM-DD, UTC — trade finder runs at most once/day
}

export async function loadTradeFinderState(): Promise<TradeFinderState> {
  return readJson<TradeFinderState>("trade-finder-state.json", { lastRunDate: "" });
}

export async function saveTradeFinderState(state: TradeFinderState): Promise<void> {
  await writeJson("trade-finder-state.json", state);
}

export async function saveRosterSnapshot(week: number, data: unknown): Promise<void> {
  await writeJson(`roster-week-${week}.json`, data);
}

// --- Autopilot (Claude routine) state ---

/**
 * The autopilot's hard switches. Lives in committed state (bot-state branch),
 * NOT in the prompt, so the write guard in bot/tools/cli.ts enforces it in
 * code — Claude can't talk its way past "dry" or "paused".
 * - mode "dry": every write is logged as WOULD-DO, no ESPN call.
 * - paused: every write is refused (set by the owner texting /pause).
 * - verified.proposeTrade: ESPN's create-trade payload is unverified and a
 *   successful guess sends a REAL offer to another manager. Stays false until
 *   a supervised live test passes; the CLI refuses propose-trade until then,
 *   even in live mode.
 */
export interface AutopilotState {
  mode: "dry" | "live";
  paused: boolean;
  outgoingTradeOffersPerWeek: number;
  verified: { proposeTrade: boolean };
}

const DEFAULT_AUTOPILOT: AutopilotState = {
  mode: "dry",
  paused: false,
  outgoingTradeOffersPerWeek: 2,
  verified: { proposeTrade: false },
};

export async function loadAutopilotState(): Promise<AutopilotState> {
  const s = await readJson<Partial<AutopilotState>>("autopilot.json", {});
  return { ...DEFAULT_AUTOPILOT, ...s, verified: { ...DEFAULT_AUTOPILOT.verified, ...(s.verified ?? {}) } };
}

export async function saveAutopilotState(state: AutopilotState): Promise<void> {
  await writeJson("autopilot.json", state);
}

export interface ActionLogEntry {
  at: string;
  week: number;
  mode: "dry" | "live";
  command: string;
  args: unknown;
  reason: string;
  result: "would_do" | "ok" | "error" | "refused";
  detail?: string;
}

export async function loadActionLog(): Promise<ActionLogEntry[]> {
  return readJson<ActionLogEntry[]>("action-log.json", []);
}

export async function saveActionLog(entries: ActionLogEntry[]): Promise<void> {
  await writeJson("action-log.json", entries);
}
