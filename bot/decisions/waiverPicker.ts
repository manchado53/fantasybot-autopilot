// Waiver value = "does this free agent beat the weakest bench player at a
// position they can slot into?" Ranked by that upgrade margin, with the
// Sleeper buzz bonus already baked into projectedPoints (see blend.ts) so an
// early breakout can outrank a bigger name with a stale projection.
//
// Every candidate clearing the bar is kept (not just the best) — the user
// decides which, if any, to actually claim.

export interface WaiverCandidate {
  playerId: number;
  name: string;
  position: string;
  projectedPoints: number;
  confidenceLabel: string;
  matchupNote?: string;
}

export interface RosterPlayer {
  playerId: number;
  name: string;
  position: string;
  projectedPoints: number;
  isLockedStarter: boolean;
}

export interface WaiverRecommendation {
  add: WaiverCandidate;
  drop: RosterPlayer | null;
  upgradeMargin: number;
  reason: string;
}

const MIN_UPGRADE_MARGIN = 2; // points — below this, not worth the roster churn
const SHORTLIST_CAP = 8; // shown in the Telegram card; rest are counted, not listed

// K and D/ST are single-purpose positions — nobody wants a bench kicker, so
// never suggest dropping a skill player to add one, or vice versa. Everything
// else can fall back to the weakest bench skill player if no same-position
// match exists.
const SINGLE_PURPOSE_POSITIONS = new Set(["K", "D/ST"]);

/** Every free agent clearing the upgrade bar, ranked best first. */
export function pickWaiverCandidates(
  freeAgents: WaiverCandidate[],
  roster: RosterPlayer[]
): WaiverRecommendation[] {
  const droppable = roster
    .filter((p) => !p.isLockedStarter)
    .sort((a, b) => a.projectedPoints - b.projectedPoints);

  const results: WaiverRecommendation[] = [];

  for (const fa of freeAgents) {
    const sameDroppable = droppable.filter((p) => p.position === fa.position);
    const fallbackPool = SINGLE_PURPOSE_POSITIONS.has(fa.position)
      ? []
      : droppable.filter((p) => !SINGLE_PURPOSE_POSITIONS.has(p.position));

    const candidateDrop: RosterPlayer | null = sameDroppable[0] ?? fallbackPool[0] ?? null;
    // "No candidate" only means a genuinely open roster spot when there's no
    // droppable bench at all — otherwise it means "nothing sensible to drop
    // for this position," so skip this free agent rather than force a
    // mismatched swap.
    if (!candidateDrop && droppable.length > 0) continue;

    const dropPoints = candidateDrop?.projectedPoints ?? 0;
    const margin = Math.round((fa.projectedPoints - dropPoints) * 10) / 10;
    if (margin < MIN_UPGRADE_MARGIN) continue;

    results.push({
      add: fa,
      drop: candidateDrop,
      upgradeMargin: margin,
      reason: candidateDrop
        ? `Projects ${margin} pts above ${candidateDrop.name} (${candidateDrop.position}), your weakest droppable ${candidateDrop.position === fa.position ? fa.position : "bench spot"}.`
        : `Projects ${fa.projectedPoints} pts with an open roster spot — no drop needed.`,
    });
  }

  results.sort((a, b) => b.upgradeMargin - a.upgradeMargin);

  // Flag (don't resolve) same-drop conflicts against every higher-ranked
  // pick — recomputing drop targets to avoid overlap gets fragile fast with
  // this many interacting candidates; better to surface it and let the user
  // decide, same as every other decision this bot makes.
  // Only note it on the FIRST clash (rank 2 vs rank 1) — when many
  // candidates share one drop target (e.g. only one weak bench spot at that
  // position), repeating the full note on every single one just drowns the
  // list. One heads-up is enough; the pattern is obvious after that.
  let firstClashNoted = false;
  for (let i = 1; i < results.length; i++) {
    const dropId = results[i].drop?.playerId;
    if (dropId == null) continue;
    const clashRank = results.findIndex((r, j) => j < i && r.drop?.playerId === dropId);
    if (clashRank !== -1 && !firstClashNoted) {
      results[i].reason += ` (Several of these share the same drop target — approving more than one isn't additive.)`;
      firstClashNoted = true;
    }
  }

  return results;
}

export function formatWaiverShortlistCard(recs: WaiverRecommendation[], week: number): string {
  if (recs.length === 0) {
    return `*Week ${week} waivers*: no free agent clears the ${MIN_UPGRADE_MARGIN}pt upgrade bar this week — no claims recommended.`;
  }

  const shown = recs.slice(0, SHORTLIST_CAP);
  const lines = [`*Week ${week} waiver shortlist* (${recs.length} option${recs.length === 1 ? "" : "s"} clear the bar)`, ""];
  shown.forEach((rec, i) => {
    lines.push(
      `*#${i + 1}: ${rec.add.name}* (${rec.add.position}, ${rec.add.projectedPoints} pts, ${rec.add.confidenceLabel}) — +${rec.upgradeMargin} pts`,
      rec.drop ? `Drop: ${rec.drop.name}` : `Drop: none — open spot`,
      rec.reason
    );
    if (rec.add.matchupNote) lines.push(rec.add.matchupNote);
    lines.push("");
  });
  if (recs.length > SHORTLIST_CAP) {
    lines.push(`_+${recs.length - SHORTLIST_CAP} more clear the bar but aren't shown here._`);
  }
  return lines.join("\n").trim();
}

export const WAIVER_SHORTLIST_CAP = SHORTLIST_CAP;
