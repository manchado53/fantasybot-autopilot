// ESPN uses TWO SEPARATE numbering systems that look alike but aren't:
//   - lineup SLOT ids (where a player is placed: bench, QB slot, FLEX slot...)
//   - player POSITION ids (what a player actually plays: RB, WR, TE...)
// Confirmed live against a real league (2026-09-14) by dumping real roster
// entries — e.g. Sam LaPorta (a TE) has defaultPositionId 4, while the TE
// *slot* id is 6. Treating these as the same table was the original bug.

/** Player position ids (`player.defaultPositionId`). */
export const PLAYER_POSITION_ID_TO_NAME: Record<number, string> = {
  1: "QB",
  2: "RB",
  3: "WR",
  4: "TE",
  5: "K",
  16: "D/ST",
};

/** Lineup slot ids (`lineupSlotId`, and league `rosterSettings.lineupSlotCounts` keys). */
export const SLOT_ID_TO_NAME: Record<number, string> = {
  0: "QB",
  2: "RB",
  3: "RB/WR",
  4: "WR",
  5: "WR/TE",
  6: "TE",
  7: "OP",
  16: "D/ST",
  17: "K",
  20: "BE",
  21: "IR",
  23: "FLEX",
};

export const SLOT_ID_TO_ELIGIBLE_POSITIONS: Record<number, string[]> = {
  0: ["QB"],
  2: ["RB"],
  3: ["RB", "WR"],
  4: ["WR"],
  5: ["WR", "TE"],
  6: ["TE"],
  7: ["QB", "RB", "WR", "TE"], // Superflex / OP
  16: ["D/ST"],
  17: ["K"],
  23: ["RB", "WR", "TE"], // FLEX
};

/** Slot ids that are starting lineup spots, not bench/IR — used to build optimizer requirements. */
export const STARTING_SLOT_IDS = new Set([0, 2, 3, 4, 5, 6, 7, 16, 17, 23]);

export const INJURY_STATUS_MAP: Record<string, string> = {
  ACTIVE: "ACTIVE",
  QUESTIONABLE: "QUESTIONABLE",
  DOUBTFUL: "DOUBTFUL",
  OUT: "OUT",
  INJURY_RESERVE: "IR",
  BYE: "BYE",
};
