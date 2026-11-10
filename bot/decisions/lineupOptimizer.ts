// Lineup = "assign players to starting slots to maximize total projected points."
// The only real ambiguity is FLEX-type slots (RB/WR/TE all eligible). This uses
// a weight-descending greedy: take the highest-projected player left, drop them
// into the narrowest open slot they're eligible for (dedicated position before
// FLEX, FLEX before superflex/OP) so flexible slots stay open for players who
// need them. This is correct for essentially every real-world roster shape;
// it is not a full matroid-intersection solver, which isn't worth the
// complexity here for a handful of slots and ~15 roster spots.

export interface SlotRequirement {
  slotId: number;
  slotName: string;
  count: number;
  /** Positions eligible for this slot, narrowest (dedicated) slots have fewer entries. */
  eligiblePositions: string[];
}

export interface LineupCandidate {
  playerId: number;
  name: string;
  position: string;
  injuryStatus: string;
  onByeWeek: boolean;
  projectedPoints: number;
}

export interface LineupAssignment {
  slotName: string;
  slotId: number;
  player: LineupCandidate | null;
  benchedHigherOption?: LineupCandidate;
}

export function optimizeLineup(
  roster: LineupCandidate[],
  slots: SlotRequirement[]
): { assignments: LineupAssignment[]; totalProjected: number; warnings: string[] } {
  const warnings: string[] = [];
  const eligible = roster.filter((p) => {
    if (p.onByeWeek) {
      warnings.push(`${p.name} is on bye — excluded from consideration.`);
      return false;
    }
    if (p.injuryStatus === "OUT" || p.injuryStatus === "IR") {
      warnings.push(`${p.name} is ${p.injuryStatus} — excluded from consideration.`);
      return false;
    }
    return true;
  });

  // Expand slot requirements into individual slot instances, narrowest first
  // (fewest eligible positions), so dedicated slots claim their best player
  // before FLEX-type slots start competing for the same pool.
  const slotInstances = slots
    .flatMap((s) => Array(s.count).fill(s))
    .sort((a, b) => a.eligiblePositions.length - b.eligiblePositions.length);

  const remaining = [...eligible].sort((a, b) => b.projectedPoints - a.projectedPoints);
  const assignments: LineupAssignment[] = [];

  for (const slot of slotInstances) {
    const idx = remaining.findIndex((p) => slot.eligiblePositions.includes(p.position));
    if (idx === -1) {
      assignments.push({ slotName: slot.slotName, slotId: slot.slotId, player: null });
      warnings.push(`No eligible player left for ${slot.slotName} — slot will be empty.`);
      continue;
    }
    const [player] = remaining.splice(idx, 1);
    assignments.push({ slotName: slot.slotName, slotId: slot.slotId, player });
  }

  const totalProjected = assignments.reduce((sum, a) => sum + (a.player?.projectedPoints ?? 0), 0);
  return { assignments, totalProjected: Math.round(totalProjected * 10) / 10, warnings };
}

/**
 * Turn optimizer assignments into ESPN slot moves. Anyone moving into a
 * starting slot needs a move, and anyone who WAS starting but isn't in the
 * new plan goes back to bench (20). IR (21) players are left alone. ESPN
 * wants each move's real origin slot, not a wildcard.
 */
export function diffLineupMoves(
  assignments: LineupAssignment[],
  currentSlotByPlayerId: Map<number, number>
): { playerId: number; fromLineupSlotId: number; toLineupSlotId: number }[] {
  const newStartingPlayerIds = new Set(assignments.filter((a) => a.player).map((a) => a.player!.playerId));
  const moves: { playerId: number; fromLineupSlotId: number; toLineupSlotId: number }[] = [];
  for (const a of assignments) {
    if (!a.player) continue;
    const from = currentSlotByPlayerId.get(a.player.playerId);
    if (from !== undefined && from !== a.slotId) {
      moves.push({ playerId: a.player.playerId, fromLineupSlotId: from, toLineupSlotId: a.slotId });
    }
  }
  for (const [playerId, currentSlot] of currentSlotByPlayerId) {
    const wasStarting = currentSlot !== 20 && currentSlot !== 21;
    if (wasStarting && !newStartingPlayerIds.has(playerId)) {
      moves.push({ playerId, fromLineupSlotId: currentSlot, toLineupSlotId: 20 });
    }
  }
  return moves;
}

export function formatLineupCard(
  result: ReturnType<typeof optimizeLineup>,
  week: number
): string {
  const lines = [`*Week ${week} lineup recommendation* (${result.totalProjected} pts projected)`, ""];
  for (const a of result.assignments) {
    lines.push(a.player ? `${a.slotName}: ${a.player.name} (${Math.round(a.player.projectedPoints * 10) / 10} pts)` : `${a.slotName}: — empty —`);
  }
  if (result.warnings.length) {
    lines.push("", "_Notes:_");
    for (const w of result.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}
