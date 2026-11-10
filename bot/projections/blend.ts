// Honest note on "blending": ESPN is the only source here that gives an actual
// points projection — Sleeper gives a trending-add count and FantasyPros (free
// tier) gives a rank, not points. You can't average incompatible units, so the
// real algorithm is:
//   1. Take ESPN's points projection as the base number.
//   2. Nudge it with a small buzz bonus when Sleeper shows heavy trending-add
//      activity (catches breakouts before ESPN's own projection catches up).
//   3. Track ESPN's own trailing accuracy (projected vs. actual) per position,
//      updated weekly, so recommendations can carry a confidence label
//      ("ESPN's WR projections have been off by ~4.2 pts/week lately").
// This is the self-correcting weighted piece — the weight applies to how much
// we trust the projection's error bar, not to averaging multiple point sources.

import type { ProjectionAccuracyRecord } from "../state/store.js";

const TRAILING_WEEKS = 4;

export interface AdjustedProjection {
  points: number;
  buzzBonusApplied: number;
  fantasyProsNote?: string;
  confidenceLabel: string;
}

export function adjustProjection(
  espnPoints: number | null,
  sleeperTrendCount: number | null,
  fantasyProsRank: number | null,
  trailingMaeForPosition: number | null
): AdjustedProjection {
  const base = espnPoints ?? 0;

  // Cap the buzz bonus at 15% of base — this is a nudge for early breakout
  // signal, not a replacement for the actual projection.
  const buzzBonusApplied = sleeperTrendCount
    ? base * Math.min(sleeperTrendCount / 1000, 0.15)
    : 0;

  const confidenceLabel =
    trailingMaeForPosition == null
      ? "no accuracy history yet"
      : trailingMaeForPosition < 3
      ? "high confidence"
      : trailingMaeForPosition < 6
      ? "medium confidence"
      : "low confidence — this position's projections have been noisy";

  return {
    points: Math.round((base + buzzBonusApplied) * 10) / 10,
    buzzBonusApplied: Math.round(buzzBonusApplied * 10) / 10,
    fantasyProsNote: fantasyProsRank != null ? `FantasyPros has them ranked #${fantasyProsRank} at position` : undefined,
    confidenceLabel,
  };
}

/**
 * Update ESPN's trailing accuracy for one position after a scoring period
 * completes. Call this once per week per position with the week's
 * (projected, actual) pairs for every rostered/relevant player.
 */
export function computeTrailingMae(
  existing: ProjectionAccuracyRecord[],
  position: string,
  weekResults: { projected: number; actual: number }[]
): ProjectionAccuracyRecord {
  const errors = weekResults
    .filter((r) => r.projected != null && r.actual != null)
    .map((r) => Math.abs(r.projected - r.actual));
  const thisWeekMae = errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null;

  const prior = existing.find((r) => r.source === "espn" && r.position === position);
  const priorMae = prior?.trailingMae ?? thisWeekMae ?? 0;

  // Simple rolling average over the trailing window rather than a full history
  // — cheap, self-correcting, and good enough at this data volume.
  const blendedMae =
    thisWeekMae == null ? priorMae : (priorMae * (TRAILING_WEEKS - 1) + thisWeekMae) / TRAILING_WEEKS;

  return {
    source: "espn",
    position,
    trailingMae: Math.round(blendedMae * 100) / 100,
    weight: Math.round((1 / (blendedMae + 0.5)) * 100) / 100,
    updatedAt: new Date().toISOString(),
  };
}
