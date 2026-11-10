export interface BotConfig {
  espn: {
    leagueId: string;
    seasonYear: number;
    swid: string;
    espnS2: string;
    teamId: number | null;
    teamName: string;
  };
  telegram: {
    botToken: string;
    chatId: string;
  };
  settings: {
    tradeLopsidedGapPct: number;
    lineupApplyTimeoutMinutesBeforeLock: number;
  };
}

export type SlotPosition =
  | "QB" | "RB" | "WR" | "TE" | "FLEX" | "D/ST" | "K" | "BE" | "IR";

export interface Player {
  id: number;
  name: string;
  proTeam: string;
  eligibleSlots: SlotPosition[];
  injuryStatus: "ACTIVE" | "QUESTIONABLE" | "DOUBTFUL" | "OUT" | "IR" | "BYE";
  onByeWeek: boolean;
  espnProjection: number | null;
}

export interface RosterEntry {
  player: Player;
  currentSlot: SlotPosition;
}

export interface ProjectionSource {
  name: "espn" | "sleeper" | "fantasypros";
  points: number | null;
}

export interface BlendedProjection {
  playerId: number;
  points: number;
  sources: ProjectionSource[];
}

export interface DecisionLogEntry {
  id: string;
  // "trade" = reactive: judging a trade someone already proposed (approve
  // dispatches to respondToTrade). Proactive trade-finder suggestions are
  // info-only (no safe way to verify ESPN's create-trade payload without it
  // immediately becoming a real, visible offer — see runTradeFinder in
  // run.ts), so they're never logged as an approvable decision here.
  type: "lineup" | "waiver" | "trade";
  week: number;
  createdAt: string;
  summary: string;
  payload: unknown;
  // "failed" = the ESPN write threw (stale moves, locked lineup, etc.). Kept
  // out of "pending" so a bad entry is never retried every run forever.
  status: "pending" | "approved" | "rejected" | "auto_applied" | "auto_skipped" | "failed";
  telegramMessageId?: number;
  resolvedAt?: string;
}
