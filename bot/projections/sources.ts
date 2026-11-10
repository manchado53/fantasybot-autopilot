// Three projection inputs, in order of how much we lean on them:
//
// 1. ESPN's own projections — pulled straight out of the same authenticated
//    league payload we already fetch for rosters/free-agents. Full player pool,
//    zero extra requests, zero extra risk. This is the primary source.
// 2. Sleeper trending adds — a free, no-login, cross-platform "buzz" signal.
//    Sleeper's player dump maps its own ids to ESPN ids via `espn_id`, so we
//    can cross-reference even though the league itself lives on ESPN.
// 3. FantasyPros free/anonymous tier — capped at roughly the top ~10 players
//    per position with no API key. Used only as a "do the experts agree"
//    gut-check on notable names, not as a full-pool source. Best-effort:
//    if the page shape changes, this fails soft (returns []) rather than
//    breaking the pipeline.

import type { ProjectionSource } from "../types.js";

/** Extract ESPN's projected points for a player from a kona_player_info entry. */
export function extractEspnProjection(playerEntry: any, scoringPeriodId: number): number | null {
  const stats: any[] = playerEntry?.player?.stats ?? [];
  const projected = stats.find(
    (s) => s.statSourceId === 1 && s.scoringPeriodId === scoringPeriodId
  );
  return typeof projected?.appliedTotal === "number" ? projected.appliedTotal : null;
}

/**
 * Season-level numbers from the same `player.stats` array:
 * - ROS (rest of season) = ESPN projection, statSourceId 1, statSplitTypeId 0,
 *   scoringPeriodId 0, current season. appliedTotal is the remaining-weeks
 *   total, appliedAverage per game. (Verified live 2026-11-10: Mahomes week 9
 *   → 156.9 total / 17.4 per game over the 9 remaining games.)
 * - seasonAvg = actual points per game so far, statSourceId 0, split 0, period 0.
 * The weekly projection alone made the autopilot judge adds on one week;
 * these let it value players for the rest of the season.
 */
export function extractSeasonStats(
  playerEntry: any,
  seasonYear: number,
): { rosTotal: number | null; rosPerGame: number | null; seasonAvg: number | null } {
  const stats: any[] = playerEntry?.player?.stats ?? [];
  const find = (src: number) =>
    stats.find((s) => s.statSourceId === src && s.statSplitTypeId === 0 && s.scoringPeriodId === 0 && s.seasonId === seasonYear);
  const ros = find(1);
  const actual = find(0);
  const r1 = (n: unknown) => (typeof n === "number" ? Math.round(n * 10) / 10 : null);
  return { rosTotal: r1(ros?.appliedTotal), rosPerGame: r1(ros?.appliedAverage), seasonAvg: r1(actual?.appliedAverage) };
}

let sleeperPlayerDumpCache: Record<string, any> | null = null;

/** Sleeper's full player dump, cached in-memory for the life of one run. */
async function getSleeperPlayerDump(): Promise<Record<string, any>> {
  if (sleeperPlayerDumpCache) return sleeperPlayerDumpCache;
  const res = await fetch("https://api.sleeper.app/players/nfl");
  if (!res.ok) throw new Error(`Sleeper player dump failed: ${res.status}`);
  sleeperPlayerDumpCache = (await res.json()) as Record<string, any>;
  return sleeperPlayerDumpCache!;
}

/**
 * Trending add counts (last 24h) keyed by ESPN player id, where a crosswalk
 * exists. Players Sleeper hasn't mapped to an espn_id are skipped rather than
 * guessed at.
 */
export async function getSleeperTrendingByEspnId(lookbackHours = 24, limit = 50): Promise<Map<number, number>> {
  const [trendingRes, dump] = await Promise.all([
    fetch(`https://api.sleeper.app/players/nfl/trending/add?lookback_hours=${lookbackHours}&limit=${limit}`),
    getSleeperPlayerDump(),
  ]);
  if (!trendingRes.ok) throw new Error(`Sleeper trending failed: ${trendingRes.status}`);
  const trending = (await trendingRes.json()) as { player_id: string; count: number }[];

  const byEspnId = new Map<number, number>();
  for (const { player_id, count } of trending) {
    const espnId = dump[player_id]?.espn_id;
    if (espnId) byEspnId.set(Number(espnId), count);
  }
  return byEspnId;
}

/**
 * Best-effort FantasyPros consensus rank lookup by player name, anonymous tier
 * (no API key). Returns null on any failure or if the player isn't in the
 * small free-tier list — callers must treat this as optional signal only.
 */
export async function getFantasyProsSanityCheck(playerName: string, position: string): Promise<{ rank: number } | null> {
  try {
    const posSlug = position.toLowerCase();
    const res = await fetch(`https://www.fantasypros.com/nfl/rankings/${posSlug}.php`);
    if (!res.ok) return null;
    const html = await res.text();
    // Fragile by design: FantasyPros' anonymous HTML isn't a stable API contract.
    // We only look for an exact name match near a rank number; any parse miss
    // just means "no sanity-check signal for this player," which is fine.
    const escaped = playerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = html.match(new RegExp(`"rank_no":(\\d+)[^}]*"player_name":"${escaped}"`));
    return match ? { rank: Number(match[1]) } : null;
  } catch {
    return null;
  }
}

export function toProjectionSources(
  espnPoints: number | null,
  sleeperTrendCount: number | undefined,
  fantasyProsRank: number | null | undefined
): ProjectionSource[] {
  return [
    { name: "espn", points: espnPoints },
    // Trending count isn't points — the blend engine treats "sleeper" as a
    // buzz modifier rather than a raw point projection (see blend.ts).
    { name: "sleeper", points: sleeperTrendCount ?? null },
    { name: "fantasypros", points: fantasyProsRank ?? null },
  ];
}
