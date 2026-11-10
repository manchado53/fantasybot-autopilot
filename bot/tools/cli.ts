// The autopilot's hands. The Claude routine reads bot/AUTOPILOT.md, then calls
// this CLI to read the league and act on it. Every command prints ONE JSON
// object to stdout so Claude can parse it.
//
//   npm run tool -- <command> [args] [--reason "why"]
//
// THE WRITE GUARD LIVES HERE, IN CODE — not in the prompt. Every ESPN write
// goes through guardedWrite(), which reads bot/state/autopilot.json:
//   paused        -> refused, nothing sent
//   mode "dry"    -> logged as would_do, nothing sent
//   mode "live"   -> sent to ESPN
// and records every attempt in bot/state/action-log.json with Claude's
// --reason. Don't add a write command that skips guardedWrite: the user's
// "dry-run first" and "/pause" guarantees depend on it.

import { loadConfig, loadAutopilotState, saveAutopilotState, loadActionLog, saveActionLog, type ActionLogEntry, type AutopilotState } from "../state/store.js";
import {
  getLeague, getFreeAgents, getTransactions, getPlayersById, setLineup, resyncLineupMoves,
  addFreeAgent, submitWaiverClaim, respondToTrade, proposeTrade, getProTeams, getPlayerNews, getDefenseVsPosition, EspnAuthError, type SlotMove, type ProTeamInfo, type DefenseVsPosition,
} from "../espn/client.js";
import { extractEspnProjection, extractSeasonStats, getSleeperTrendingByEspnId } from "../projections/sources.js";
import { adjustProjection } from "../projections/blend.js";
import { optimizeLineup, diffLineupMoves, type LineupCandidate, type SlotRequirement } from "../decisions/lineupOptimizer.js";
import { pickWaiverCandidates, type WaiverCandidate, type RosterPlayer } from "../decisions/waiverPicker.js";
import { getFantasyCalcValues, evaluateTrade } from "../decisions/tradeEvaluator.js";
import { findTradeCandidates, type TeamRoster } from "../decisions/tradeFinder.js";
import { sendPlain, readInbox } from "../telegram/client.js";
import { SLOT_ID_TO_ELIGIBLE_POSITIONS, SLOT_ID_TO_NAME, PLAYER_POSITION_ID_TO_NAME, STARTING_SLOT_IDS } from "../espn/constants.js";
import type { BotConfig } from "../types.js";

const BENCH = 20;
const IR = 21;

// ---------- small helpers ----------

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[a.slice(2)] = next;
        i++;
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function teamName(t: any): string {
  return `${t.location ?? ""} ${t.nickname ?? t.name ?? ""}`.trim();
}

function slotIdFromName(name: string): number {
  const upper = name.toUpperCase();
  if (upper === "BENCH") return BENCH;
  const hit = Object.entries(SLOT_ID_TO_NAME).find(([, n]) => n === upper);
  if (!hit) throw new Error(`Unknown slot "${name}". Use one of: ${Object.values(SLOT_ID_TO_NAME).join(", ")}`);
  return Number(hit[0]);
}

function playerOf(entry: any): any {
  return entry.playerPoolEntry?.player ?? entry.player;
}

interface Ctx {
  config: BotConfig;
  league: any;
  week: number;
  team: any;
  slots: SlotRequirement[];
  nameById: Map<number, string>;
  proTeams: Map<number, ProTeamInfo>;
  dvp: DefenseVsPosition;
  /** Fantasy playoff weeks (e.g. 15-17 when the regular season is 14 weeks). */
  playoffWeeks: number[];
}

async function loadCtx(): Promise<Ctx> {
  const config = await loadConfig();
  const [league, proTeams, dvp]: [any, Ctx["proTeams"], DefenseVsPosition] = await Promise.all([
    getLeague(config),
    // Byes, schedules and matchup ratings are nice-to-have; never fail a command over them.
    getProTeams(config).catch(() => new Map()),
    getDefenseVsPosition(config).catch(() => new Map()),
  ]);
  const sched = league.settings?.scheduleSettings ?? {};
  const regular = Number(sched.matchupPeriodCount ?? 14);
  const playoffWeeks = Object.keys(sched.matchupPeriods ?? {}).map(Number).filter((w) => w > regular).sort((a, b) => a - b);
  const team = league.teams?.find((t: any) => t.id === config.espn.teamId);
  if (!team) throw new Error(`Team id ${config.espn.teamId} not found in league.`);
  const week: number = league.scoringPeriodId ?? league.status?.currentMatchupPeriod ?? 1;
  const slotCounts: Record<string, number> = league.settings?.rosterSettings?.lineupSlotCounts ?? {};
  const slots: SlotRequirement[] = Object.entries(slotCounts)
    .filter(([id, count]) => STARTING_SLOT_IDS.has(Number(id)) && count > 0)
    .map(([id, count]) => ({
      slotId: Number(id),
      slotName: SLOT_ID_TO_NAME[Number(id)] ?? `slot ${id}`,
      count,
      eligiblePositions: SLOT_ID_TO_ELIGIBLE_POSITIONS[Number(id)] ?? [],
    }));
  const nameById = new Map<number, string>();
  for (const t of league.teams ?? []) {
    for (const e of t.roster?.entries ?? []) nameById.set(e.playerId, playerOf(e)?.fullName ?? String(e.playerId));
  }
  return { config, league, week, team, slots, nameById, proTeams, dvp, playoffWeeks: playoffWeeks.length ? playoffWeeks : [15, 16, 17] };
}

/**
 * Fantasy-playoff schedule strength for one player. factor = average points
 * his playoff opponents allow to his position ÷ league average (1.10 = 10%
 * easier than average). A playoff-week bye is called out: it's a zero.
 */
function playoffSchedule(positionId: number, proTeamId: number, ctx: Ctx): { factor: number | null; label: string } {
  const team = ctx.proTeams.get(proTeamId);
  const pos = ctx.dvp.get(positionId);
  if (!team || !pos || !pos.average) return { factor: null, label: "" };
  const factors: number[] = [];
  const notes: string[] = [];
  for (const w of ctx.playoffWeeks) {
    const opp = team.opponentByWeek[w];
    if (opp === undefined) {
      notes.push(`BYE wk${w}`);
      continue;
    }
    const r = pos.byOpponent.get(opp);
    if (r) factors.push(r.average / pos.average);
  }
  if (!factors.length) return { factor: null, label: notes.join(" ") };
  const factor = Math.round((factors.reduce((a, b) => a + b, 0) / factors.length) * 100) / 100;
  const tag = factor >= 1.08 ? "easy" : factor <= 0.92 ? "hard" : "avg";
  return { factor, label: [`PO x${factor.toFixed(2)} ${tag}`, ...notes].join(" ") };
}

/**
 * Buy-low / sell-high signal: actual pts/game so far vs ESPN's rest-of-season
 * projection. Running far above projection = likely to cool off (sell high);
 * far below = likely to bounce back (buy low). Injured players are skipped:
 * their gap is the injury, not luck.
 */
function trendFlag(seasonAvg: number | null, rosPerGame: number | null, injury: string): string {
  if (seasonAvg == null || rosPerGame == null || rosPerGame <= 0) return "";
  if (!["ACTIVE", "NORMAL", "QUESTIONABLE"].includes(injury)) return "";
  const diff = seasonAvg - rosPerGame;
  const bar = Math.max(3, rosPerGame * 0.2);
  if (diff >= bar) return "SELL-HIGH?";
  if (diff <= -bar) return "BUY-LOW?";
  return "";
}

interface PlayerRow {
  playerId: number;
  name: string;
  position: string;
  proTeam: string;
  byeWeek: number | null;
  slot: string | null;
  status: string | null; // FREEAGENT / WAIVERS for free agents
  injuryStatus: string;
  projected: number | null; // this week; null usually = bye / no game
  rosPerGame: number | null;
  seasonAvg: number | null;
  percentOwned: number | null;
  lineupLocked: boolean;
  droppable: boolean;
  lastNewsDate: string | null;
  playoffFactor: number | null;
  playoffLabel: string;
  trend: string;
}

/**
 * Works for roster entries (team.roster.entries) AND free-agent entries
 * (kona_player_info players) — both carry `player` + `stats` in the same shape
 * once unwrapped.
 */
function toRow(e: any, ctx: Ctx): PlayerRow {
  const pool = e.playerPoolEntry ?? e;
  const p = pool.player ?? playerOf(e);
  const pro = ctx.proTeams.get(p.proTeamId);
  const season = extractSeasonStats(pool, ctx.config.espn.seasonYear);
  const projected = extractEspnProjection(pool, ctx.week);
  return {
    playerId: p.id,
    name: p.fullName,
    position: PLAYER_POSITION_ID_TO_NAME[p.defaultPositionId] ?? "UNKNOWN",
    proTeam: pro?.abbrev ?? (p.proTeamId === 0 ? "FA" : String(p.proTeamId)),
    byeWeek: pro?.byeWeek ?? null,
    slot: e.lineupSlotId !== undefined ? SLOT_ID_TO_NAME[e.lineupSlotId] ?? String(e.lineupSlotId) : null,
    status: e.lineupSlotId === undefined ? e.status ?? null : null,
    injuryStatus: p.injuryStatus ?? e.injuryStatus ?? "ACTIVE",
    projected: projected == null ? null : Math.round(projected * 10) / 10,
    rosPerGame: season.rosPerGame,
    seasonAvg: season.seasonAvg,
    percentOwned: p.ownership?.percentOwned != null ? Math.round(p.ownership.percentOwned) : null,
    lineupLocked: pool.lineupLocked ?? false,
    droppable: p.droppable ?? true,
    lastNewsDate: p.lastNewsDate ? new Date(p.lastNewsDate).toISOString().slice(0, 10) : null,
    ...(() => {
      const po = playoffSchedule(p.defaultPositionId, p.proTeamId, ctx);
      return { playoffFactor: po.factor, playoffLabel: po.label };
    })(),
    trend: trendFlag(season.seasonAvg, season.rosPerGame, p.injuryStatus ?? e.injuryStatus ?? "ACTIVE"),
  };
}

/**
 * One line per player. The old JSON objects (eligibleSlots arrays etc.) made
 * `status` ~15KB and the agent burned turns grepping it down — keep this terse.
 */
function formatLine(r: PlayerRow, week: number, headline?: string): string {
  const bye = r.byeWeek == null ? "" : r.byeWeek === week ? " BYE-THIS-WEEK" : r.byeWeek > week ? ` bye${r.byeWeek}` : "";
  const parts = [
    String(r.playerId),
    r.name,
    `${r.position} ${r.proTeam}${bye}`,
    r.slot ? `slot ${r.slot}` : r.status ?? "",
    r.injuryStatus,
    `wk ${r.projected ?? "-"}`,
    `ROS ${r.rosPerGame ?? "-"}/g`,
    `szn ${r.seasonAvg ?? "-"}/g`,
    `${r.percentOwned ?? "-"}%`,
  ];
  if (r.playoffLabel) parts.push(r.playoffLabel);
  if (r.trend) parts.push(r.trend);
  if (r.lineupLocked) parts.push("locked");
  if (!r.droppable) parts.push("UNDROPPABLE");
  if (headline) parts.push(`news: ${headline}`);
  return parts.join(" | ");
}

const LINE_FORMAT = "playerId | name | pos team (bye) | slot or FA status | injury | this-week proj | rest-of-season pts/game | season actual pts/game | % owned | playoff schedule (PO xN = wk15-17 opponents allow N times the average; easy/avg/hard) | BUY-LOW?/SELL-HIGH? (actual vs ROS) | flags | latest news";

/** Latest headline for players whose ESPN news is newer than `days` days. */
async function recentHeadlines(rows: PlayerRow[], days: number): Promise<Map<number, string>> {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const fresh = rows.filter((r) => r.lastNewsDate && r.lastNewsDate >= cutoff);
  const results = await Promise.all(fresh.map(async (r) => [r.playerId, (await getPlayerNews(r.playerId, 1))[0]] as const));
  const map = new Map<number, string>();
  for (const [id, item] of results) if (item) map.set(id, `${item.published}: ${item.headline}`.slice(0, 260));
  return map;
}

function suggestLineup(ctx: Ctx) {
  const entries: any[] = ctx.team.roster?.entries ?? [];
  const currentSlotByPlayerId = new Map<number, number>(entries.map((e: any) => [e.playerId, e.lineupSlotId]));
  const roster: LineupCandidate[] = entries
    // Locked players (their game started) can't move — keep them out of the
    // optimizer so it never plans a move ESPN will reject.
    .filter((e: any) => !e.playerPoolEntry?.lineupLocked)
    .map((e: any) => {
      const p = playerOf(e);
      const projected = extractEspnProjection(e.playerPoolEntry ?? e, ctx.week);
      return {
        playerId: p.id,
        name: p.fullName,
        position: PLAYER_POSITION_ID_TO_NAME[p.defaultPositionId] ?? "UNKNOWN",
        injuryStatus: p.injuryStatus ?? "ACTIVE",
        // ESPN gives no projection for a player with no game this week.
        onByeWeek: projected == null,
        projectedPoints: projected ?? 0,
      };
    });
  const lockedStarters = entries.filter((e: any) => e.playerPoolEntry?.lineupLocked && e.lineupSlotId !== BENCH && e.lineupSlotId !== IR);
  // Remove slots already filled by locked starters.
  const slots = ctx.slots.map((s) => ({
    ...s,
    count: s.count - lockedStarters.filter((e: any) => e.lineupSlotId === s.slotId).length,
  })).filter((s) => s.count > 0);
  const lockedIds = new Set(lockedStarters.map((e: any) => e.playerId));
  const result = optimizeLineup(roster, slots);
  const movable = new Map([...currentSlotByPlayerId].filter(([id]) => !lockedIds.has(id)));
  const moves = diffLineupMoves(result.assignments, movable);
  return { result, moves };
}

// ---------- log hygiene ----------

/**
 * Keep only the useful bits of an ESPN write response for the action log.
 * Found 2026-11-10: ESPN echoes `memberId` (the owner's SWID, half of the
 * ESPN login cookie pair) in every add/drop response, and the full response
 * was being stored in action-log.json and pushed to the bot-state branch.
 * Never store the raw response.
 */
function summarizeEspnResponse(res: any): string {
  if (!res || typeof res !== "object") return String(res ?? "null").slice(0, 200);
  const items = Array.isArray(res.items) ? res.items.map((i: any) => `${i.type} ${i.playerId}`).join(", ") : "";
  return JSON.stringify({ id: res.id, type: res.type, status: res.status, isPending: res.isPending, items }).slice(0, 400);
}

/** Strip anything that looks like the owner's ESPN ids/cookies from free text. */
function redact(text: string, config: BotConfig): string {
  let out = text;
  for (const secret of [config.espn.swid, config.espn.swid?.replace(/[{}]/g, ""), config.espn.espnS2]) {
    if (secret && secret.length > 8) out = out.split(secret).join("<redacted>");
  }
  return out.replace(/"memberId"\s*:\s*"[^"]*"/g, '"memberId":"<redacted>"');
}

// ---------- the write guard ----------

async function guardedWrite(
  ctx: Ctx,
  command: string,
  args: unknown,
  reason: string | undefined,
  doWrite: () => Promise<unknown>,
  extraCheck?: (state: AutopilotState, log: ActionLogEntry[]) => string | null,
) {
  if (!reason) {
    out({ ok: false, error: `--reason "<why>" is required for ${command}. It goes in the action log and the report.` });
    process.exitCode = 1;
    return;
  }
  const state = await loadAutopilotState();
  const log = await loadActionLog();
  const entry: ActionLogEntry = {
    at: new Date().toISOString(),
    week: ctx.week,
    mode: state.mode,
    command,
    args,
    reason,
    result: "would_do",
  };

  const refusal = state.paused ? "Autopilot is paused (owner sent /pause). No writes until /resume." : extraCheck?.(state, log) ?? null;
  if (refusal) {
    entry.result = "refused";
    entry.detail = refusal;
  } else if (state.mode === "dry") {
    entry.result = "would_do";
    entry.detail = "DRY MODE: nothing sent to ESPN.";
  } else {
    try {
      const res = await doWrite();
      entry.result = "ok";
      entry.detail = summarizeEspnResponse(res);
    } catch (err) {
      if (err instanceof EspnAuthError) throw err;
      entry.result = "error";
      entry.detail = redact(String((err as Error)?.message ?? err), ctx.config).slice(0, 800);
    }
  }
  log.push(entry);
  await saveActionLog(log);
  out({ ok: entry.result === "ok" || entry.result === "would_do", ...entry });
}

// ---------- commands ----------

async function cmdStatus() {
  const ctx = await loadCtx();
  const state = await loadAutopilotState();
  const period = ctx.league.status?.currentMatchupPeriod ?? ctx.week;
  const matchup = (ctx.league.schedule ?? []).find(
    (m: any) => m.matchupPeriodId === period && (m.home?.teamId === ctx.team.id || m.away?.teamId === ctx.team.id),
  );
  const oppId = matchup ? (matchup.home?.teamId === ctx.team.id ? matchup.away?.teamId : matchup.home?.teamId) : null;
  const opp = ctx.league.teams?.find((t: any) => t.id === oppId);
  const acq = ctx.league.settings?.acquisitionSettings ?? {};
  const sched = ctx.league.settings?.scheduleSettings ?? {};

  const rows = (ctx.team.roster?.entries ?? []).map((e: any) => toRow(e, ctx));
  const headlines = await recentHeadlines(rows, 7);

  // Standings: ESPN's own playoffSeed when present, else wins then points.
  const standings = [...(ctx.league.teams ?? [])]
    .sort((a: any, b: any) =>
      (a.playoffSeed ?? 99) - (b.playoffSeed ?? 99) ||
      (b.record?.overall?.wins ?? 0) - (a.record?.overall?.wins ?? 0) ||
      (b.record?.overall?.pointsFor ?? 0) - (a.record?.overall?.pointsFor ?? 0))
    .map((t: any, i: number) => {
      const r = t.record?.overall ?? {};
      return `${i + 1}. ${teamName(t)}${t.id === ctx.team.id ? " (ME)" : ""} ${r.wins ?? 0}-${r.losses ?? 0}${r.ties ? `-${r.ties}` : ""} PF ${Math.round(r.pointsFor ?? 0)}`;
    });

  // Memory: what the autopilot itself did lately, so it doesn't flip-flop.
  const since = Date.now() - 7 * 86400000;
  const recentActions = (await loadActionLog())
    .filter((a) => new Date(a.at).getTime() >= since && a.result !== "would_do")
    .map((a) => `${a.at.slice(0, 16)} ${a.mode} ${a.command} ${JSON.stringify(a.args).slice(0, 160)} -> ${a.result} | why: ${a.reason.slice(0, 160)}`);

  const myByes = rows
    .filter((r: PlayerRow) => r.byeWeek != null && r.byeWeek >= ctx.week)
    .sort((a: PlayerRow, b: PlayerRow) => (a.byeWeek ?? 0) - (b.byeWeek ?? 0))
    .map((r: PlayerRow) => `wk${r.byeWeek} ${r.name} (${r.position})`);

  out({
    week: ctx.week,
    autopilot: state,
    team: { id: ctx.team.id, name: teamName(ctx.team), record: ctx.team.record?.overall && `${ctx.team.record.overall.wins}-${ctx.team.record.overall.losses}`, streak: ctx.team.record?.overall && `${ctx.team.record.overall.streakType} ${ctx.team.record.overall.streakLength}` },
    opponent: opp ? `${teamName(opp)} (id ${opp.id}) ${opp.record?.overall?.wins}-${opp.record?.overall?.losses}` : null,
    season: { regularSeasonWeeks: sched.matchupPeriodCount ?? null, playoffTeams: sched.playoffTeamCount ?? null },
    standings,
    rosterFormat: LINE_FORMAT,
    roster: rows.map((r: PlayerRow) => formatLine(r, ctx.week, headlines.get(r.playerId))),
    upcomingByes: myByes,
    recentActions: recentActions.length ? recentActions : ["(none in the last 7 days)"],
    waiverRules: { type: acq.acquisitionType, processDays: acq.waiverProcessDays, processHour: acq.waiverProcessHour, waiverHours: acq.waiverHours },
    tradeDeadline: ctx.league.settings?.tradeSettings?.deadlineDate ? new Date(ctx.league.settings.tradeSettings.deadlineDate).toISOString().slice(0, 10) : null,
    hint: "Run `news <playerId...>` for the full story on anyone you might start, sit, drop, add, or trade.",
  });
}

async function cmdNews(positional: string[]) {
  const ids = positional.map(Number).filter(Boolean);
  if (!ids.length) throw new Error("Usage: news <playerId> [playerId...]");
  const results = await Promise.all(ids.map(async (id) => ({ playerId: id, news: await getPlayerNews(id, 3) })));
  out({
    note: "Latest ESPN/Rotowire blurbs, newest first. Empty = no recent news OR the news host is unreachable; use WebSearch then.",
    players: results.map((r) => ({ playerId: r.playerId, news: r.news.map((n) => `${n.published}: ${n.headline}`) })),
  });
}

async function cmdSuggestLineup() {
  const ctx = await loadCtx();
  const { result, moves } = suggestLineup(ctx);
  out({
    week: ctx.week,
    totalProjected: result.totalProjected,
    assignments: result.assignments.map((a) => ({ slot: a.slotName, player: a.player?.name ?? null, projected: a.player?.projectedPoints ?? null })),
    warnings: result.warnings,
    moves: moves.map((m) => ({ ...m, name: ctx.nameById.get(m.playerId), to: SLOT_ID_TO_NAME[m.toLineupSlotId] })),
    hint: moves.length ? "Apply with: npm run tool -- set-lineup --suggested --reason \"...\"" : "Lineup already matches the optimizer.",
  });
}

async function cmdFreeAgents(pos?: string, limit = 25) {
  const ctx = await loadCtx();
  const resp: any = await getFreeAgents(ctx.config, 150);
  let trending = new Map<number, number>();
  try {
    trending = await getSleeperTrendingByEspnId();
  } catch {
    // Sleeper is optional signal; never fail the command over it.
  }
  const rows = (resp.players ?? []).map((entry: any) => {
    const row = toRow(entry, ctx);
    const adj = adjustProjection(row.projected, trending.get(row.playerId) ?? null, null, null);
    return { row, projectedWithBuzz: adj.points, trendingAdds: trending.get(row.playerId) ?? 0 };
  });
  // Rank by rest-of-season value (falls back to this week) — the weekly
  // number alone is what made the agent judge adds on one game.
  const filtered = rows
    .filter((r: any) => !pos || r.row.position === pos.toUpperCase())
    .sort((a: any, b: any) => (b.row.rosPerGame ?? b.row.projected ?? 0) - (a.row.rosPerGame ?? a.row.projected ?? 0));
  const shown = filtered.slice(0, limit);
  const headlines = await recentHeadlines(shown.slice(0, 12).map((r: any) => r.row), 7);

  const roster: RosterPlayer[] = (ctx.team.roster?.entries ?? []).map((e: any) => {
    const p = playerOf(e);
    return {
      playerId: p.id,
      name: p.fullName,
      position: PLAYER_POSITION_ID_TO_NAME[p.defaultPositionId] ?? "UNKNOWN",
      projectedPoints: extractEspnProjection(e.playerPoolEntry ?? e, ctx.week) ?? 0,
      isLockedStarter: e.lineupSlotId !== BENCH && e.lineupSlotId !== IR,
    };
  });
  const candidates: WaiverCandidate[] = filtered.map((r: any) => ({
    playerId: r.row.playerId, name: r.row.name, position: r.row.position, projectedPoints: r.projectedWithBuzz, confidenceLabel: "",
  }));
  const recs = pickWaiverCandidates(candidates, roster).slice(0, 6);

  out({
    week: ctx.week,
    note: "Sorted by rest-of-season pts/game. Status FREEAGENT = instant add, WAIVERS = claim (processed later). trendingAdds = Sleeper adds in 24h.",
    format: LINE_FORMAT + " | trendingAdds",
    freeAgents: shown.map((r: any) => `${formatLine(r.row, ctx.week, headlines.get(r.row.playerId))} | trend ${r.trendingAdds}`),
    optimizerSuggestions_thisWeekOnly: recs.map((r) => `add ${r.add.name} (${r.add.playerId}) drop ${r.drop?.name ?? "-"} (${r.drop?.playerId ?? "-"}) +${r.upgradeMargin} this week`),
  });
}

async function cmdTeams() {
  const ctx = await loadCtx();
  out({
    week: ctx.week,
    teams: (ctx.league.teams ?? []).map((t: any) => ({
      id: t.id,
      name: teamName(t),
      record: t.record?.overall,
      isMe: t.id === ctx.team.id,
      // One compact string per player: 12 full rosters as objects is ~47KB,
      // too much to load into Claude's context every run.
      roster: (t.roster?.entries ?? []).map((e: any) => {
        const r = toRow(e, ctx);
        return `${r.playerId} | ${r.name} | ${r.position} ${r.proTeam} | ${r.slot} | wk ${r.projected ?? "-"} | ROS ${r.rosPerGame ?? "-"}/g | ${r.injuryStatus}`;
      }),
    })),
    format: "playerId | name | pos team | slot | this-week proj | rest-of-season pts/game | injury",
  });
}

async function cmdTrades() {
  const ctx = await loadCtx();
  const tx: any = await getTransactions(ctx.config);
  const pending = (tx.transactions ?? []).filter((t: any) => String(t.type).startsWith("TRADE") && t.status === "PENDING");
  let values: any[] = [];
  try {
    values = await getFantasyCalcValues({ numTeams: 12 });
  } catch {
    // Fairness numbers are optional signal.
  }
  const me = ctx.team.id;
  out({
    week: ctx.week,
    note: "Trade payload fields are not fully verified for this league; raw items are included. Judge by names + fairness.",
    pending: pending.map((t: any) => {
      const items = (t.items ?? []).map((i: any) => ({ ...i, name: ctx.nameById.get(i.playerId) ?? null }));
      const give = items.filter((i: any) => i.fromTeamId === me).map((i: any) => i.name).filter(Boolean);
      const get = items.filter((i: any) => i.toTeamId === me).map((i: any) => i.name).filter(Boolean);
      return {
        transactionId: t.id,
        type: t.type,
        involvesMe: give.length > 0 || get.length > 0,
        proposingTeamId: t.teamId,
        youGive: give,
        youGet: get,
        fairness: values.length && (give.length || get.length) ? evaluateTrade(give, get, values, ctx.config.settings.tradeLopsidedGapPct) : null,
        items,
      };
    }),
  });
}

async function cmdTradeIdeas() {
  const ctx = await loadCtx();
  const teams: TeamRoster[] = (ctx.league.teams ?? []).map((t: any) => ({
    teamId: t.id,
    teamName: teamName(t),
    players: (t.roster?.entries ?? []).map((e: any) => {
      const r = toRow(e, ctx);
      return {
        playerId: r.playerId,
        name: r.name,
        position: r.position,
        projectedPoints: r.projected ?? 0,
        rosPerGame: r.rosPerGame,
        playoffFactor: r.playoffFactor,
        trend: r.trend,
        slot: e.lineupSlotId,
      };
    }),
  }));

  // Replacement level for VORP = the 2nd-best HEALTHY free agent's ROS
  // pts/game at each position. Not the single best: only one team can claim
  // him, and one outlier would set the bar for the whole position.
  const replacementByPosition: Record<string, number> = {};
  try {
    const fa: any = await getFreeAgents(ctx.config, 150);
    const byPos: Record<string, number[]> = {};
    for (const entry of fa.players ?? []) {
      const r = toRow(entry, ctx);
      if (!["ACTIVE", "NORMAL"].includes(r.injuryStatus) || r.rosPerGame == null) continue;
      (byPos[r.position] ??= []).push(r.rosPerGame);
    }
    for (const [pos, vals] of Object.entries(byPos)) {
      const sorted = vals.sort((a, b) => b - a);
      replacementByPosition[pos] = sorted[1] ?? sorted[0];
    }
  } catch {
    // No replacement data -> finder falls back to its median-share rule.
  }

  const values = await getFantasyCalcValues({ numTeams: 12 });
  const ideas = findTradeCandidates(teams, ctx.team.id, values, ctx.config.settings.tradeLopsidedGapPct, { replacementByPosition });
  out({
    week: ctx.week,
    tradeDeadline: ctx.league.settings?.tradeSettings?.deadlineDate ? new Date(ctx.league.settings.tradeSettings.deadlineDate).toISOString().slice(0, 10) : null,
    replacementLevel: replacementByPosition,
    note: "VORP = ROS pts/game minus replacement (2nd-best healthy free agent at that position). Ideas only: run `news` on every player first. Open with the offer as listed; add the sweetener only if they counter. propose-trade stays locked until verified.",
    ideas: ideas.map((s) => ({
      kind: s.kind,
      acceptance: s.acceptance,
      to: `${s.theirTeamName} (id ${s.theirTeamId})`,
      openingOffer: { give: s.offerPlayers.map((p) => `${p.name} (${p.playerId}, ${p.position})`), get: `${s.requestPlayer.name} (${s.requestPlayer.playerId}, ${s.requestPlayer.position})` },
      ifTheyCounter: s.fallbackSweetener ? `add ${s.fallbackSweetener.name} (${s.fallbackSweetener.playerId}, ${s.fallbackSweetener.position})` : "no sweetener on the bench; walk away or swap the chip",
      upgradePerGame: s.upgradePerGame,
      theirVorpChange: s.theirVorpChange,
      fairness: `${s.fairnessGapPct}% gap, favors ${s.favors}`,
      why: s.reason,
    })),
  });
}

async function cmdSetLineup(positional: string[], flags: Record<string, string | true>) {
  const ctx = await loadCtx();
  let moves: SlotMove[];
  if (flags.suggested) {
    moves = suggestLineup(ctx).moves;
  } else {
    // Each arg is playerId:SLOT, e.g. 4241389:RB 3916387:BE
    moves = positional.map((arg) => {
      const [id, slot] = arg.split(":");
      if (!id || !slot) throw new Error(`Bad move "${arg}". Use playerId:SLOT, e.g. 4241389:RB or 3916387:BE`);
      return { playerId: Number(id), fromLineupSlotId: -1, toLineupSlotId: slotIdFromName(slot) };
    });
  }
  // Resync fills in each player's real current slot and drops no-op moves.
  const live = await resyncLineupMoves(ctx.config, moves);
  if (live.length === 0) {
    out({ ok: true, result: "noop", detail: "Roster already matches; nothing to send." });
    return;
  }
  const described = live.map((m) => ({ ...m, name: ctx.nameById.get(m.playerId), from: SLOT_ID_TO_NAME[m.fromLineupSlotId], to: SLOT_ID_TO_NAME[m.toLineupSlotId] }));
  await guardedWrite(ctx, "set-lineup", described, flags.reason as string | undefined, () => setLineup(ctx.config, ctx.week, live));
}

async function cmdMoveIr(positional: string[], flags: Record<string, string | true>) {
  const ctx = await loadCtx();
  const [id, dir] = positional;
  if (!id || (dir !== "in" && dir !== "out")) throw new Error("Usage: move-ir <playerId> in|out --reason \"...\"");
  const move: SlotMove = { playerId: Number(id), fromLineupSlotId: -1, toLineupSlotId: dir === "in" ? IR : BENCH };
  const live = await resyncLineupMoves(ctx.config, [move]);
  if (live.length === 0) {
    out({ ok: true, result: "noop", detail: `Player already ${dir === "in" ? "on IR" : "off IR"} (or not on roster).` });
    return;
  }
  // NEEDS LIVE VERIFICATION: assumes IR moves are the same LINEUP txn as any
  // slot change (target slot 21). ESPN only allows IR for eligible injury
  // statuses; expect a 409 otherwise.
  await guardedWrite(ctx, "move-ir", { playerId: Number(id), name: ctx.nameById.get(Number(id)), direction: dir }, flags.reason as string | undefined, () =>
    setLineup(ctx.config, ctx.week, live),
  );
}

async function cmdAdd(positional: string[], flags: Record<string, string | true>) {
  const ctx = await loadCtx();
  const addId = Number(positional[0]);
  const dropId = positional[1] ? Number(positional[1]) : undefined;
  if (!addId) throw new Error("Usage: add <addPlayerId> [dropPlayerId] --reason \"...\"");
  if (dropId && !(ctx.team.roster?.entries ?? []).some((e: any) => e.playerId === dropId)) {
    out({ ok: false, error: `Drop player ${dropId} is not on your roster.` });
    process.exitCode = 1;
    return;
  }
  const lookup: any = await getPlayersById(ctx.config, [addId]);
  const entry = (lookup.players ?? []).find((p: any) => p.id === addId || p.player?.id === addId);
  const status: string = entry?.status ?? "UNKNOWN";
  if (status !== "FREEAGENT" && status !== "WAIVERS") {
    out({ ok: false, error: `Player ${addId} has status ${status}; only FREEAGENT or WAIVERS players can be added.` });
    process.exitCode = 1;
    return;
  }
  const args = { add: entry?.player?.fullName ?? addId, addId, drop: dropId ? ctx.nameById.get(dropId) ?? dropId : null, dropId: dropId ?? null, via: status === "WAIVERS" ? "waiver claim" : "instant free-agent add" };
  await guardedWrite(ctx, status === "WAIVERS" ? "claim" : "add", args, flags.reason as string | undefined, () =>
    status === "WAIVERS" ? submitWaiverClaim(ctx.config, ctx.week, addId, dropId) : addFreeAgent(ctx.config, ctx.week, addId, dropId),
  );
}

async function cmdRespondTrade(positional: string[], flags: Record<string, string | true>) {
  const ctx = await loadCtx();
  const [txId, decision] = positional;
  if (!txId || (decision !== "accept" && decision !== "decline")) throw new Error("Usage: respond-trade <transactionId> accept|decline --reason \"...\"");
  await guardedWrite(ctx, "respond-trade", { transactionId: txId, decision }, flags.reason as string | undefined, () =>
    respondToTrade(ctx.config, txId, decision === "accept"),
  );
}

async function cmdProposeTrade(positional: string[], flags: Record<string, string | true>) {
  const ctx = await loadCtx();
  const [toTeam, give, get] = positional;
  if (!toTeam || !give || !get) throw new Error("Usage: propose-trade <teamId> <giveIds,comma> <getIds,comma> --reason \"...\"");
  const giveIds = give.split(",").map(Number);
  const getIds = get.split(",").map(Number);
  const args = {
    toTeamId: Number(toTeam),
    give: giveIds.map((id) => ctx.nameById.get(id) ?? id),
    get: getIds.map((id) => ctx.nameById.get(id) ?? id),
  };
  await guardedWrite(ctx, "propose-trade", args, flags.reason as string | undefined, () =>
    proposeTrade(ctx.config, Number(toTeam), giveIds, getIds),
    (state, log) => {
      if (!state.verified.proposeTrade) {
        return "propose-trade is LOCKED: ESPN's create-trade format is unverified and a wrong-but-accepted guess sends a real offer. Unlocks after the supervised live test. Suggest the trade in the report instead.";
      }
      const sentThisWeek = log.filter((e) => e.command === "propose-trade" && e.week === ctx.week && e.result === "ok").length;
      if (sentThisWeek >= state.outgoingTradeOffersPerWeek) {
        return `Weekly cap reached (${state.outgoingTradeOffersPerWeek} trade offers this week).`;
      }
      return null;
    },
  );
}

async function cmdReport(positional: string[]) {
  const config = await loadConfig();
  const state = await loadAutopilotState();
  const text = positional.join(" ").trim();
  if (!text) throw new Error("Usage: report \"<text>\"");
  const prefix = state.mode === "dry" ? "🧪 DRY RUN — nothing was changed on ESPN.\n\n" : "";
  await sendPlain(config, prefix + text);
  out({ ok: true, sent: true });
}

/**
 * Owner commands handled IN CODE (not by Claude's judgment), so they always
 * work: /pause, /resume, /live, /dry, /status. Anything else is returned
 * for Claude to read as instructions from the owner.
 */
async function cmdInbox() {
  const config = await loadConfig();
  const messages = await readInbox(config);
  const state = await loadAutopilotState();
  const handled: string[] = [];
  const forClaude: typeof messages = [];
  for (const m of messages) {
    const cmd = m.text.trim().toLowerCase().split(/\s+/)[0];
    if (cmd === "/pause") { state.paused = true; handled.push("paused"); }
    else if (cmd === "/resume") { state.paused = false; handled.push("resumed"); }
    else if (cmd === "/live") { state.mode = "live"; handled.push("mode=live"); }
    else if (cmd === "/dry") { state.mode = "dry"; handled.push("mode=dry"); }
    else if (cmd === "/status") { handled.push("status-requested"); }
    else forClaude.push(m);
  }
  if (handled.length) {
    await saveAutopilotState(state);
    await sendPlain(config, `🤖 Got it: ${handled.join(", ")}. Now: mode=${state.mode}, paused=${state.paused}.`);
  }
  out({ autopilot: state, handledCommands: handled, messagesFromOwner: forClaude });
}

const HELP = `Commands (all print JSON):
  READ
    status                         roster (ROS, byes, fresh news), standings, my recent moves, opponent, mode
    news <playerId...>             latest ESPN/Rotowire news per player (read before any move)
    suggest-lineup                 optimizer's best lineup + the moves to get there
    free-agents [POS] [--limit N]  free agents (FREEAGENT=instant, WAIVERS=claim) + suggestions
    teams                          every team's roster (for trade targets)
    trades                         pending trades + FantasyCalc fairness
    trade-ideas                    trade ideas from the trade finder
    inbox                          owner's new Telegram messages (/pause /resume /live /dry handled automatically)
  WRITE (need --reason; obey dry/paused)
    set-lineup --suggested | set-lineup <playerId:SLOT> ...   SLOT = QB RB WR TE FLEX D/ST K BE IR
    move-ir <playerId> in|out
    add <addPlayerId> [dropPlayerId]          instant add or waiver claim, picked automatically
    respond-trade <transactionId> accept|decline
    propose-trade <teamId> <giveIds,> <getIds,>   (locked until verified)
  OTHER
    report "<text>"                Telegram message to the owner (plain text)`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  switch (command) {
    case "status": return cmdStatus();
    case "suggest-lineup": return cmdSuggestLineup();
    case "free-agents": return cmdFreeAgents(positional[0], flags.limit ? Number(flags.limit) : undefined);
    case "teams": return cmdTeams();
    case "news": return cmdNews(positional);
    case "trades": return cmdTrades();
    case "trade-ideas": return cmdTradeIdeas();
    case "inbox": return cmdInbox();
    case "set-lineup": return cmdSetLineup(positional, flags);
    case "move-ir": return cmdMoveIr(positional, flags);
    case "add": return cmdAdd(positional, flags);
    case "respond-trade": return cmdRespondTrade(positional, flags);
    case "propose-trade": return cmdProposeTrade(positional, flags);
    case "report": return cmdReport(positional);
    default:
      console.log(HELP);
  }
}

main().catch(async (err) => {
  process.exitCode = 1;
  out({ ok: false, error: String((err as Error)?.message ?? err), authExpired: err instanceof EspnAuthError });
  if (err instanceof EspnAuthError) {
    try {
      const config = await loadConfig();
      await sendPlain(config, `🔒 ${err.message}\n\nGrab fresh espn_s2/SWID cookies and update the routine's environment variables. The autopilot can't do anything until then.`);
    } catch {
      // Nothing more we can do; the JSON error above still tells Claude.
    }
  }
});
