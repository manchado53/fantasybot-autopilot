// ESPN's fantasy football API has no official public docs — this client follows the
// request shapes used by long-running community projects (cwendt94/espn-api,
// mkreiser/ESPN-Fantasy-Football-API). Reads are well-trodden; the write calls
// (setLineup/submitWaiverClaim/respondToTrade) are the least-documented part of
// ESPN's private API and MUST be verified against the real league (build step 5+)
// before any live use.
import { fileURLToPath } from "node:url";
import { loadConfig } from "../state/store.js";
import type { BotConfig } from "../types.js";

const READ_BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";
// Confirmed live 2026-09-14: the "reads" host 405s on POST/PUT, and the
// classic fantasy.espn.com/apis/v3 host no longer serves the API at all
// (just the website). The real write host is the paired lm-api-writes one —
// confirmed via a deliberate empty-items POST that got back a proper JSON
// validation error (409 TRAN_ITEMS_MISSING) instead of HTML or a 405.
const WRITE_BASE = "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons";

function authHeaders(config: BotConfig): Record<string, string> {
  return {
    Cookie: `espn_s2=${config.espn.espnS2}; SWID=${config.espn.swid}`,
    "Content-Type": "application/json",
  };
}

function leagueUrl(config: BotConfig): string {
  return `${READ_BASE}/${config.espn.seasonYear}/segments/0/leagues/${config.espn.leagueId}`;
}

function writeLeagueUrl(config: BotConfig): string {
  return `${WRITE_BASE}/${config.espn.seasonYear}/segments/0/leagues/${config.espn.leagueId}`;
}

/** Thrown on 401/403 so callers (run.ts) can tell "cookies expired" apart from
 * any other failure and ping Telegram with a specific "send fresh cookies" ask
 * instead of a generic error. */
export class EspnAuthError extends Error {
  constructor(action: string, status: number) {
    super(`ESPN auth failed on ${action} (HTTP ${status}) — espn_s2/SWID cookies are likely expired.`);
    this.name = "EspnAuthError";
  }
}

async function assertOk(res: Response, action: string) {
  if (res.status === 401 || res.status === 403) throw new EspnAuthError(action, res.status);
  if (!res.ok) throw new Error(`${action} failed: ${res.status} ${res.statusText} — ${await res.text()}`);
}

async function espnGet(config: BotConfig, views: string[], extraHeaders: Record<string, string> = {}) {
  const qs = views.map((v) => `view=${v}`).join("&");
  const res = await fetch(`${leagueUrl(config)}?${qs}`, {
    headers: { ...authHeaders(config), ...extraHeaders },
  });
  await assertOk(res, `ESPN GET ${views.join(",")}`);
  return res.json();
}

/** Full league payload: settings, teams, rosters, current scoring period. */
export async function getLeague(config: BotConfig) {
  return espnGet(config, ["mSettings", "mTeam", "mRoster", "mMatchup"]);
}

/** All 12 teams with id + display name — used to resolve teamId from a team name. */
export async function listTeams(config: BotConfig) {
  const league: any = await espnGet(config, ["mTeam"]);
  return (league.teams ?? []).map((t: any) => ({
    id: t.id,
    name: `${t.location ?? ""} ${t.nickname ?? t.name ?? ""}`.trim(),
    owner: league.members?.find((m: any) => t.owners?.includes(m.id))?.displayName,
  }));
}

/** Your team's roster for the given team id (falls back to config.espn.teamId). */
export async function getMyRoster(config: BotConfig, teamId?: number) {
  const league: any = await espnGet(config, ["mRoster", "mTeam"]);
  const id = teamId ?? config.espn.teamId;
  const team = league.teams?.find((t: any) => t.id === id);
  if (!team) {
    throw new Error(
      `Team id ${id ?? "(none set)"} not found. Run with no teamId set and check league.teams in the raw payload to find yours by team name.`
    );
  }
  return team;
}

/**
 * Free agents / waiver-wire players. ESPN filters this list via the
 * X-Fantasy-Filter header rather than query params.
 */
export async function getFreeAgents(config: BotConfig, limit = 200) {
  const filter = {
    players: {
      filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
      limit,
      sortPercOwned: { sortAsc: false, sortPriority: 1 },
    },
  };
  return espnGet(config, ["kona_player_info"], {
    "X-Fantasy-Filter": JSON.stringify(filter),
  });
}

/**
 * Look up specific players by ESPN id, wherever they are (free agent,
 * waivers, or rostered). The autopilot uses `status` here to choose between
 * an instant FREEAGENT add and a WAIVER claim.
 */
export async function getPlayersById(config: BotConfig, playerIds: number[]) {
  // No `limit` here: ESPN 400s (FILTER_LIMIT_MISSING_SORT) on a limit
  // without a sort, and filterIds already bounds the result. Found live 2026-11-09.
  const filter = { players: { filterIds: { value: playerIds } } };
  return espnGet(config, ["kona_player_info"], { "X-Fantasy-Filter": JSON.stringify(filter) });
}

export interface ProTeamInfo {
  abbrev: string;
  byeWeek: number | null;
  /** NFL week -> opponent NFL team id. */
  opponentByWeek: Record<number, number>;
}

/** NFL team id -> abbreviation, bye week and weekly opponents, from the season's pro-team schedule view. */
export async function getProTeams(config: BotConfig): Promise<Map<number, ProTeamInfo>> {
  const res = await fetch(`${READ_BASE}/${config.espn.seasonYear}?view=proTeamSchedules_wl`, { headers: authHeaders(config) });
  await assertOk(res, "ESPN GET proTeamSchedules_wl");
  const data: any = await res.json();
  return new Map(
    (data.settings?.proTeams ?? []).map((t: any) => {
      const opponentByWeek: Record<number, number> = {};
      for (const [week, games] of Object.entries<any[]>(t.proGamesByScoringPeriod ?? {})) {
        const g = games?.[0];
        if (g) opponentByWeek[Number(week)] = g.homeProTeamId === t.id ? g.awayProTeamId : g.homeProTeamId;
      }
      return [t.id, { abbrev: t.abbrev, byeWeek: t.byeWeek ?? null, opponentByWeek }];
    }),
  );
}

/** Per position id: league-average fantasy points allowed, and each NFL defense's average + rank (32 = easiest). */
export type DefenseVsPosition = Map<number, { average: number; byOpponent: Map<number, { average: number; rank: number }> }>;

/**
 * ESPN's "OPRK" data: how many fantasy points each NFL defense allows to each
 * position. Comes back as a side field (`positionAgainstOpponent`) on any
 * kona_player_info request, so ask for a single player to keep it cheap.
 * Verified live 2026-11-10: rank 32 = allows the most points = easiest matchup.
 */
export async function getDefenseVsPosition(config: BotConfig): Promise<DefenseVsPosition> {
  const filter = { players: { limit: 1, sortPercOwned: { sortAsc: false, sortPriority: 1 } } };
  const data: any = await espnGet(config, ["kona_player_info"], { "X-Fantasy-Filter": JSON.stringify(filter) });
  const out: DefenseVsPosition = new Map();
  for (const [posId, r] of Object.entries<any>(data.positionAgainstOpponent?.positionalRatings ?? {})) {
    const byOpponent = new Map<number, { average: number; rank: number }>();
    for (const [teamId, v] of Object.entries<any>(r.ratingsByOpponent ?? {})) byOpponent.set(Number(teamId), { average: v.average, rank: v.rank });
    out.set(Number(posId), { average: r.average, byOpponent });
  }
  return out;
}

export interface NewsItem {
  headline: string;
  published: string;
}

/**
 * Latest news blurbs (Rotowire, via ESPN) for one player — the "beyond the
 * numbers" signal: injury designations, coach quotes, role changes.
 * Public endpoint, no cookies. Best-effort ON PURPOSE: any failure (network,
 * host not on the routine's allowlist, shape change) returns [] so news can
 * never break a run — the playbook falls back to WebSearch.
 * Host must be on the routine environment's network allowlist: site.api.espn.com.
 */
export async function getPlayerNews(playerId: number, limit = 3): Promise<NewsItem[]> {
  try {
    // Over-fetch, then keep only player-specific blurbs. Found live
    // (2026-11-10): the feed also returns league-wide "Fantasy buzz" articles
    // tagged to many players — Gibbs, Collins and Judkins all showed the same
    // "Puka Nacua likely heading to IR" headline. Rotowire items are the
    // per-player notes; fall back to the raw feed only if there are none.
    const res = await fetch(`https://site.api.espn.com/apis/fantasy/v2/games/ffl/news/players?limit=${limit * 4}&playerId=${playerId}`);
    if (!res.ok) return [];
    const data: any = await res.json();
    const feed: any[] = data.feed ?? [];
    const playerSpecific = feed.filter((f) => f.type === "Rotowire");
    return (playerSpecific.length ? playerSpecific : []).slice(0, limit).map((f: any) => ({
      headline: String(f.headline ?? f.description ?? "").slice(0, 400),
      published: String(f.published ?? f.lastModified ?? "").slice(0, 10),
    }));
  } catch {
    return [];
  }
}

/** Pending + recent trades/waiver transactions for the league. */
export async function getTransactions(config: BotConfig) {
  return espnGet(config, ["mTransactions2"]);
}

// --- Writes (unverified — test against the real league before trusting) ---

export interface SlotMove {
  playerId: number;
  fromLineupSlotId: number;
  toLineupSlotId: number;
}

/**
 * Set the starting lineup for the current scoring period. `moves` must
 * include every player whose slot is actually changing (both the player
 * entering a starting slot AND whoever it displaces to bench) with their
 * real current slot as `fromLineupSlotId` — ESPN needs the real origin, not
 * a wildcard.
 * NEEDS LIVE VERIFICATION: exact payload shape for roster-change transactions
 * varies across ESPN API versions; confirm against your league before going live.
 */
export async function setLineup(config: BotConfig, scoringPeriodId: number, moves: SlotMove[]) {
  const teamId = config.espn.teamId;
  if (!teamId) throw new Error("config.espn.teamId must be set before writing lineup changes.");
  const items = moves.map((m) => ({
    playerId: m.playerId,
    type: "LINEUP",
    fromLineupSlotId: m.fromLineupSlotId,
    toLineupSlotId: m.toLineupSlotId,
  }));
  const res = await fetch(`${writeLeagueUrl(config)}/transactions/`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({
      isLeagueManager: false,
      teamId,
      type: "ROSTER",
      scoringPeriodId,
      items,
    }),
  });
  await assertOk(res, "setLineup");
  return res.json();
}

/**
 * Re-sync planned lineup moves against the LIVE roster right before writing:
 * drop moves that are already done (or whose player is gone) and use each
 * player's real current slot as the origin. Moved here from run.ts so the
 * autopilot CLI uses the same guard — ESPN rejects the whole transaction
 * with 409 TRAN_ROSTER_SAME_SLOT if any single move is stale (real crash,
 * 2026-10-18).
 */
export async function resyncLineupMoves(config: BotConfig, moves: SlotMove[]): Promise<SlotMove[]> {
  const league: any = await getLeague(config);
  const team = league.teams?.find((t: any) => t.id === config.espn.teamId);
  const liveSlotByPlayerId = new Map<number, number>(
    (team?.roster?.entries ?? []).map((e: any) => [e.playerId, e.lineupSlotId]),
  );
  return moves.flatMap((m) => {
    const live = liveSlotByPlayerId.get(m.playerId);
    if (live === undefined || live === m.toLineupSlotId) return [];
    return [{ ...m, fromLineupSlotId: live }];
  });
}

/**
 * Shared add/drop transaction for WAIVER claims and instant FREEAGENT adds.
 *
 * MUST send scoringPeriodId. Real failure found live (2026-11-10, first live
 * autopilot run): without it ESPN answers 409 TRAN_INVALID_SCORINGPERIOD
 * "Transaction type can only be executed in the current scoring period" —
 * the old body left it out (setLineup always had it, which is why lineups
 * worked). Pass the league's current `scoringPeriodId`.
 *
 * Items carry team ids (toTeamId on ADD, fromTeamId on DROP) as the ESPN web
 * app does; the -1 slot ids are kept for compatibility with the old shape.
 */
async function addDropTransaction(
  config: BotConfig,
  type: "WAIVER" | "FREEAGENT",
  scoringPeriodId: number,
  addPlayerId: number,
  dropPlayerId?: number,
) {
  const teamId = config.espn.teamId;
  if (!teamId) throw new Error("config.espn.teamId must be set before adding players.");
  const items = [
    { playerId: addPlayerId, type: "ADD", toTeamId: teamId, fromLineupSlotId: -1, toLineupSlotId: -1 },
    ...(dropPlayerId
      ? [{ playerId: dropPlayerId, type: "DROP", fromTeamId: teamId, fromLineupSlotId: -1, toLineupSlotId: -1 }]
      : []),
  ];
  const res = await fetch(`${writeLeagueUrl(config)}/transactions/`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({
      isLeagueManager: false,
      teamId,
      type,
      memberId: config.espn.swid,
      scoringPeriodId,
      executionType: "EXECUTE",
      items,
    }),
  });
  await assertOk(res, type === "WAIVER" ? "submitWaiverClaim" : "addFreeAgent");
  return res.json();
}

/**
 * Instant free-agent pickup (player status FREEAGENT, not on waivers).
 * Players with status WAIVERS must go through submitWaiverClaim instead.
 */
export async function addFreeAgent(config: BotConfig, scoringPeriodId: number, addPlayerId: number, dropPlayerId?: number) {
  return addDropTransaction(config, "FREEAGENT", scoringPeriodId, addPlayerId, dropPlayerId);
}

/** Submit a waiver claim: add one player on waivers, optionally drop a roster player. */
export async function submitWaiverClaim(config: BotConfig, scoringPeriodId: number, addPlayerId: number, dropPlayerId?: number) {
  return addDropTransaction(config, "WAIVER", scoringPeriodId, addPlayerId, dropPlayerId);
}

/** Accept or reject a pending trade proposal by its transaction id. */
export async function respondToTrade(config: BotConfig, transactionId: string, accept: boolean) {
  const res = await fetch(`${writeLeagueUrl(config)}/transactions/${transactionId}`, {
    method: "PUT",
    headers: authHeaders(config),
    body: JSON.stringify({ status: accept ? "ACCEPTED" : "DECLINED" }),
  });
  await assertOk(res, "respondToTrade");
  return res.json();
}

/**
 * Propose a new trade to another team: send `offerPlayerIds` (yours),
 * request `requestPlayerIds` (theirs).
 * UNVERIFIED AND INTENTIONALLY UNWIRED — probed live (2026-09-14/15) with
 * safe placeholder payloads (empty items, a nonexistent team id); both got
 * a generic 400 "Invalid Input," meaning the `items` shape here is likely
 * wrong. Unlike lineup/waiver, there's no safe way to iterate on the real
 * shape: ESPN has no server-side draft state for trades (confirmed via
 * ESPN's own support docs — the in-app "Review" screen is client-side only,
 * before the one-shot submit call), so a *successful* guess would
 * immediately create a real, visible offer to another manager. Not called
 * anywhere in run.ts — trade-finder suggestions are sent as info only, and
 * the actual offer is sent manually in the ESPN app. Leave unwired unless
 * a documented payload shape turns up, or the user explicitly wants to
 * supervise a real live test.
 */
export async function proposeTrade(
  config: BotConfig,
  toTeamId: number,
  offerPlayerIds: number[],
  requestPlayerIds: number[]
) {
  const teamId = config.espn.teamId;
  if (!teamId) throw new Error("config.espn.teamId must be set before proposing a trade.");
  const items = [
    ...offerPlayerIds.map((playerId) => ({ playerId, type: "TRADE_PROPOSAL", fromTeamId: teamId, toTeamId })),
    ...requestPlayerIds.map((playerId) => ({ playerId, type: "TRADE_PROPOSAL", fromTeamId: toTeamId, toTeamId: teamId })),
  ];
  const res = await fetch(`${writeLeagueUrl(config)}/transactions/`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({ isLeagueManager: false, teamId, type: "TRADE", items }),
  });
  await assertOk(res, "proposeTrade");
  return res.json();
}

// Run directly (`npm run espn:test`) to sanity-check auth. If teamId isn't set
// in config.json yet, prints every team in the league so you can pick yours;
// once teamId is set, prints your roster size as final confirmation.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = await loadConfig();

  if (!config.espn.teamId) {
    const teams = await listTeams(config);
    console.log("Auth OK. Set espn.teamId in bot/config.json to one of these:");
    for (const t of teams) console.log(`  id ${t.id}: ${t.name}${t.owner ? ` (owner: ${t.owner})` : ""}`);
  } else {
    const team = await getMyRoster(config);
    console.log(`Auth OK. Team: ${team.location ?? ""} ${team.nickname ?? team.name ?? "(unnamed)"} (id ${team.id})`);
    console.log(`Roster size: ${team.roster?.entries?.length ?? "unknown"}`);
  }
}
