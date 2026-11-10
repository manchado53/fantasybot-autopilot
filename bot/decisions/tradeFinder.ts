// Proactive trade finding: scan every roster for trades worth PROPOSING.
// Read-only: never sends anything.
//
// History (why it looks like this):
// - v1 compared THIS WEEK's projection only (empty once games were played)
//   and missed a 3rd QB as a trade chip. Opus spotted "trade Bo Nix" by hand
//   while this returned [].
// - v2 (2026-11-10): rest-of-season (ROS) pts/game, depth-based chips,
//   1-for-1 and 2-for-1, FLEX-aware need level.
// - v3 (2026-11-10), from fantasy trade-strategy research (PFF, FantasyPros,
//   Footballguys, Fantasy Footballers):
//   * VORP: value = ROS/g minus the best free agent at that position, so a
//     player you could replace off waivers isn't treated as an asset. Raw
//     points overrate QBs.
//   * 2-for-1: the side that receives the best player pays a 5-10% premium
//     (we use 7.5%). The freed roster spot is worth a replacement player,
//     i.e. 0 VORP; we call it out instead of scoring it.
//   * "Would they accept?": the other team's VORP change. Ideas they'd
//     clearly reject are dropped (a good offer fills THEIR need too).
//   * Opening offer + fallback sweetener: don't open at full price.
//   * Tiebreaks: sell-high chips, buy-low targets, easy playoff schedule.

import { evaluateTrade, type FantasyCalcPlayerValue } from "./tradeEvaluator.js";

export interface TeamRosterPlayer {
  playerId: number;
  name: string;
  position: string;
  /** This week's projection (kept for callers that only have this). */
  projectedPoints: number;
  /** Rest-of-season points per game; preferred when present. */
  rosPerGame?: number | null;
  /** Fantasy-playoff schedule factor (1.10 = opponents allow 10% more than average). */
  playoffFactor?: number | null;
  /** "SELL-HIGH?" / "BUY-LOW?" / "" — actual pts/game vs ROS projection. */
  trend?: string;
  slot: number;
}

export interface TeamRoster {
  teamId: number;
  teamName: string;
  players: TeamRosterPlayer[];
}

export interface TradeSuggestion {
  theirTeamId: number;
  theirTeamName: string;
  offerPlayers: TeamRosterPlayer[];
  requestPlayer: TeamRosterPlayer;
  kind: "two-way 1-for-1" | "1-for-1" | "2-for-1 consolidation";
  /** ROS pts/game gained in MY starting lineup at the need position. */
  upgradePerGame: number;
  /** Their change in VORP (incl. 2-for-1 premium). >= 0 means it helps them on paper. */
  theirVorpChange: number;
  acceptance: "likely" | "maybe";
  /** Sweetener to add if they counter: low-VORP bench depth of mine. */
  fallbackSweetener: TeamRosterPlayer | null;
  fairnessGapPct: number;
  favors: "you" | "them" | "even";
  reason: string;
}

export interface TradeFinderOptions {
  /** Best free-agent ROS pts/game per position = replacement level for VORP. */
  replacementByPosition?: Record<string, number>;
}

const BENCH_SLOT = 20;
const IR_SLOT = 21;
const MAX_SUGGESTIONS = 6;
/** Starters per position in this league (1 QB, 2 RB, 2 WR, 1 TE + 1 FLEX). FLEX is spread over RB/WR. */
const STARTERS: Record<string, number> = { QB: 1, RB: 2.5, WR: 2.5, TE: 1, K: 1, "D/ST": 1 };
/** Backups worth keeping per position before extra depth counts as a trade chip. */
const DEPTH_KEEP: Record<string, number> = { QB: 1, RB: 1, WR: 1, TE: 0, K: 0, "D/ST": 0 };
/** A chip must beat replacement (best free agent) by at least this many pts/game. */
const CHIP_MIN_VORP = 1;
/** Fallback when no replacement data: chip must be worth this share of the league-median starter. */
const CHIP_MIN_SHARE = 0.6;
/** Only suggest upgrades of at least this many ROS pts/game. */
const MIN_UPGRADE = 1.5;
/** Premium paid by the side receiving the best player in a 2-for-1 (research: 5-10%). */
const CONSOLIDATION_PREMIUM = 0.075;
/** Their VORP change below this = they'd almost surely say no; drop the idea. */
const MIN_THEIR_VORP_CHANGE = -1.5;

const value = (p: TeamRosterPlayer): number => p.rosPerGame ?? p.projectedPoints ?? 0;
const active = (p: TeamRosterPlayer) => p.slot !== IR_SLOT;
const r1 = (n: number) => Math.round(n * 10) / 10;

function byPosition(team: TeamRoster): Record<string, TeamRosterPlayer[]> {
  const out: Record<string, TeamRosterPlayer[]> = {};
  for (const p of team.players.filter(active)) (out[p.position] ??= []).push(p);
  for (const list of Object.values(out)) list.sort((a, b) => value(b) - value(a));
  return out;
}

/** Value of the team's last "starter-level" player at a position (e.g. RB2/RB3 blend for 2.5). */
function starterLevel(list: TeamRosterPlayer[], position: string): number {
  const n = Math.max(1, Math.ceil(STARTERS[position] ?? 1));
  return list[n - 1] ? value(list[n - 1]) : 0;
}

export function computeLeagueMedianStarterByPosition(teams: TeamRoster[]): Record<string, number> {
  const levels: Record<string, number[]> = {};
  for (const t of teams) {
    for (const [pos, list] of Object.entries(byPosition(t))) (levels[pos] ??= []).push(starterLevel(list, pos));
  }
  const medians: Record<string, number> = {};
  for (const [pos, vals] of Object.entries(levels)) {
    const s = [...vals].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    medians[pos] = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  return medians;
}

/** Players beyond usable depth that still beat replacement: trade chips. */
export function computeSurplus(
  team: TeamRoster,
  medians: Record<string, number>,
  vorp: (p: TeamRosterPlayer) => number,
  hasReplacement: boolean,
): TeamRosterPlayer[] {
  const chips: TeamRosterPlayer[] = [];
  for (const [pos, list] of Object.entries(byPosition(team))) {
    const keep = Math.ceil(STARTERS[pos] ?? 1) + (DEPTH_KEEP[pos] ?? 0);
    const ok = (p: TeamRosterPlayer) =>
      value(p) > 0 && (hasReplacement ? vorp(p) >= CHIP_MIN_VORP : value(p) >= (medians[pos] ?? 0) * CHIP_MIN_SHARE);
    chips.push(...list.slice(keep).filter(ok));
  }
  return chips.sort((a, b) => vorp(b) - vorp(a));
}

/**
 * Best RB/WR/TE left after the dedicated slots (RB×2, WR×2, TE×1) — whoever
 * would actually fill FLEX. Found live: without this, a team with only two
 * healthy RBs showed RB level 0, so every RB target looked like "+17/g" even
 * though a 9/g TE was already playing FLEX.
 */
function flexOption(team: TeamRoster): number {
  const pos = byPosition(team);
  const leftovers = [...(pos.RB ?? []).slice(2), ...(pos.WR ?? []).slice(2), ...(pos.TE ?? []).slice(1)];
  return leftovers.reduce((m, p) => Math.max(m, value(p)), 0);
}

/** Positions where the team's starter level is below the league median, biggest gap first. */
export function computeNeed(team: TeamRoster, medians: Record<string, number>): { position: string; gap: number; level: number }[] {
  const out: { position: string; gap: number; level: number }[] = [];
  const flex = flexOption(team);
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const raw = starterLevel(byPosition(team)[pos] ?? [], pos);
    // RB/WR "3rd starter" is really the FLEX — use whoever would play there.
    const level = pos === "RB" || pos === "WR" ? Math.max(raw, flex) : raw;
    const gap = (medians[pos] ?? 0) - level;
    if (gap > 0.5) out.push({ position: pos, gap: r1(gap), level });
  }
  return out.sort((a, b) => b.gap - a.gap);
}

/** Bench depth worth adding if they counter: lowest positive VORP, not a chip already offered. */
function pickSweetener(me: TeamRoster, exclude: Set<number>, vorp: (p: TeamRosterPlayer) => number): TeamRosterPlayer | null {
  return (
    me.players
      .filter((p) => p.slot === BENCH_SLOT && !exclude.has(p.playerId) && ["RB", "WR", "TE"].includes(p.position) && vorp(p) > 0)
      .sort((a, b) => vorp(a) - vorp(b))[0] ?? null
  );
}

export function findTradeCandidates(
  teams: TeamRoster[],
  myTeamId: number,
  fantasyCalcValues: FantasyCalcPlayerValue[],
  lopsidedThresholdPct: number,
  opts: TradeFinderOptions = {},
): TradeSuggestion[] {
  const me = teams.find((t) => t.teamId === myTeamId);
  if (!me) return [];
  const repl = opts.replacementByPosition ?? {};
  const hasReplacement = Object.keys(repl).length > 0;
  const vorp = (p: TeamRosterPlayer) => value(p) - (repl[p.position] ?? 0);

  const medians = computeLeagueMedianStarterByPosition(teams);
  const myChips = computeSurplus(me, medians, vorp, hasReplacement);
  const myNeeds = computeNeed(me, medians);
  if (!myChips.length || !myNeeds.length) return [];

  const out: TradeSuggestion[] = [];
  const fair = (give: TeamRosterPlayer[], get: TeamRosterPlayer[]) =>
    evaluateTrade(give.map((p) => p.name), get.map((p) => p.name), fantasyCalcValues, lopsidedThresholdPct);

  for (const them of teams) {
    if (them.teamId === myTeamId) continue;
    const theirNeedPos = new Set(computeNeed(them, medians).map((n) => n.position));
    const theirChipIds = new Set(computeSurplus(them, medians, vorp, hasReplacement).map((p) => p.playerId));
    const theirByPos = byPosition(them);

    const consider = (offer: TeamRosterPlayer[], target: TeamRosterPlayer, needLevel: number, needPos: string) => {
      const f = fair(offer, [target]);
      if (f.lopsided) return;
      const premium = offer.length > 1 ? 1 + CONSOLIDATION_PREMIUM : 1;
      const theirVorpChange = r1(offer.reduce((s, p) => s + vorp(p), 0) - vorp(target) * premium);
      if (theirVorpChange < MIN_THEIR_VORP_CHANGE) return;
      const isTheirChip = theirChipIds.has(target.playerId);
      const fillsTheirNeed = offer.some((p) => theirNeedPos.has(p.position));
      const kind: TradeSuggestion["kind"] =
        offer.length > 1 ? "2-for-1 consolidation" : isTheirChip && fillsTheirNeed ? "two-way 1-for-1" : "1-for-1";
      const upgrade = r1(value(target) - needLevel);
      const tags = [
        ...offer.filter((p) => p.trend === "SELL-HIGH?").map((p) => `${p.name} is a sell-high`),
        target.trend === "BUY-LOW?" ? `${target.name} is a buy-low` : "",
        target.playoffFactor ? `${target.name} playoff schedule x${target.playoffFactor.toFixed(2)}` : "",
      ].filter(Boolean);
      out.push({
        theirTeamId: them.teamId,
        theirTeamName: them.teamName,
        offerPlayers: offer,
        requestPlayer: target,
        kind,
        upgradePerGame: upgrade,
        theirVorpChange,
        acceptance: theirVorpChange >= 0 ? "likely" : "maybe",
        fallbackSweetener: pickSweetener(me, new Set(offer.map((p) => p.playerId)), vorp),
        fairnessGapPct: f.gapPct,
        favors: f.favors,
        reason:
          `Give ${offer.map((p) => `${p.name} (${p.position} ${r1(value(p))}/g, VORP ${r1(vorp(p))})`).join(" + ")}` +
          ` for ${target.name} (${r1(value(target))}/g, VORP ${r1(vorp(target))}): +${upgrade}/g at your ${needPos}` +
          `${offer.length > 1 ? ", frees a roster spot" : ""}.` +
          `${fillsTheirNeed ? ` ${them.teamName} is thin at ${offer.find((p) => theirNeedPos.has(p.position))?.position}.` : ""}` +
          `${isTheirChip ? ` ${target.name} is spare depth for them.` : ""}` +
          `${tags.length ? ` ${tags.join("; ")}.` : ""}`,
      });
    };

    for (const need of myNeeds) {
      // Never pull from a position THEY are thin at.
      if (theirNeedPos.has(need.position)) continue;
      const targets = (theirByPos[need.position] ?? []).filter((p) => value(p) - need.level >= MIN_UPGRADE).slice(0, 2);

      for (const target of targets) {
        const isTheirChip = theirChipIds.has(target.playerId);
        // 1-for-1: a chip that fills their need (or the target is spare for them), close in value.
        for (const chip of myChips) {
          if (!theirNeedPos.has(chip.position) && !isTheirChip) continue;
          if (Math.abs(value(chip) - value(target)) > Math.max(4, value(target) * 0.35)) continue;
          consider([chip], target, need.level, need.position);
        }
        // 2-for-1: two chips for one clear upgrade.
        for (let i = 0; i < myChips.length; i++) {
          for (let j = i + 1; j < myChips.length; j++) {
            const pair = [myChips[i], myChips[j]];
            if (!pair.some((p) => theirNeedPos.has(p.position))) continue;
            if (value(target) <= Math.max(...pair.map(value))) continue; // must consolidate UP
            consider(pair, target, need.level, need.position);
          }
        }
      }
    }
  }

  // Ranking: two-way first, then "likely", then a score for my gain plus the
  // research tiebreaks (sell-high chips, buy-low targets, easy playoff weeks).
  const kindRank = { "two-way 1-for-1": 0, "2-for-1 consolidation": 1, "1-for-1": 2 } as const;
  const score = (s: TradeSuggestion) =>
    s.upgradePerGame +
    (s.requestPlayer.trend === "BUY-LOW?" ? 1 : 0) +
    s.offerPlayers.filter((p) => p.trend === "SELL-HIGH?").length +
    ((s.requestPlayer.playoffFactor ?? 1) - 1) * 10;
  const seen = new Set<string>();
  return out
    .sort(
      (a, b) =>
        kindRank[a.kind] - kindRank[b.kind] ||
        (a.acceptance === b.acceptance ? 0 : a.acceptance === "likely" ? -1 : 1) ||
        score(b) - score(a) ||
        a.fairnessGapPct - b.fairnessGapPct,
    )
    .filter((s) => {
      const key = `${s.offerPlayers.map((p) => p.playerId).sort().join(",")}>${s.requestPlayer.playerId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_SUGGESTIONS);
}

export function formatTradeFinderCard(suggestions: TradeSuggestion[], week: number): string {
  if (suggestions.length === 0) {
    return `*Week ${week} trade scan*: no trade idea cleared the fairness bar this week.`;
  }
  const lines = [`*Week ${week} trade ideas* (${suggestions.length} worth considering)`, ""];
  suggestions.forEach((s, i) => {
    lines.push(
      `*#${i + 1}* (${s.kind}, ${s.acceptance}): Offer *${s.offerPlayers.map((p) => p.name).join(" + ")}* to *${s.theirTeamName}* for *${s.requestPlayer.name}*`,
      `Upgrade: +${s.upgradePerGame} pts/game · their VORP change ${s.theirVorpChange} · fairness gap ${s.fairnessGapPct}% (favors ${s.favors})`,
      s.fallbackSweetener ? `If they counter: add ${s.fallbackSweetener.name}` : "",
      s.reason,
      "",
    );
  });
  return lines.filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n").trim();
}
