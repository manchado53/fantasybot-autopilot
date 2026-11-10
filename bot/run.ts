// Entrypoint the routine calls every hour. Orchestrates: check for taps on
// pending recommendations -> apply timeouts -> pull fresh ESPN data -> compute
// new recommendations -> send anything new to Telegram -> persist state.
//
// DRY_RUN=1 logs every intended action/message to the console instead of
// calling ESPN write endpoints or sending Telegram messages — use this while
// verifying each module against the real league (build steps 5-7) before
// trusting it live.

import { randomUUID } from "node:crypto";
import { loadConfig, loadDecisionLog, saveDecisionLog, loadProjectionAccuracy, loadTradeFinderState, saveTradeFinderState } from "./state/store.js";
import { getLeague, getFreeAgents, getTransactions, setLineup, submitWaiverClaim, respondToTrade, resyncLineupMoves, EspnAuthError } from "./espn/client.js";
import { extractEspnProjection, getSleeperTrendingByEspnId, getFantasyProsSanityCheck } from "./projections/sources.js";
import { adjustProjection } from "./projections/blend.js";
import { optimizeLineup, formatLineupCard, diffLineupMoves, type LineupCandidate, type SlotRequirement } from "./decisions/lineupOptimizer.js";
import { pickWaiverCandidates, formatWaiverShortlistCard, WAIVER_SHORTLIST_CAP, type WaiverCandidate, type RosterPlayer } from "./decisions/waiverPicker.js";
import { getFantasyCalcValues, evaluateTrade, formatTradeCard } from "./decisions/tradeEvaluator.js";
import { findTradeCandidates, formatTradeFinderCard, type TeamRoster, type TeamRosterPlayer } from "./decisions/tradeFinder.js";
import { sendMessage, pollButtonTaps, acknowledgeTap } from "./telegram/client.js";
import { SLOT_ID_TO_ELIGIBLE_POSITIONS, SLOT_ID_TO_NAME, PLAYER_POSITION_ID_TO_NAME, STARTING_SLOT_IDS } from "./espn/constants.js";
import type { DecisionLogEntry } from "./types.js";

const DRY_RUN = process.env.DRY_RUN === "1";

async function main() {
  const config = await loadConfig();
  const log = await loadDecisionLog();

  await resolveTappedButtons(config, log);
  await applyTimeouts(config, log);

  const league: any = await getLeague(config);
  const team = league.teams?.find((t: any) => t.id === config.espn.teamId);
  const week: number = league.scoringPeriodId ?? league.status?.currentMatchupPeriod ?? 1;

  // Real starting-lineup requirement, pulled live from the league (verified
  // 2026-09-14 against a real league: 1 QB, 2 RB, 2 WR, 1 TE, 1 FLEX, 1 D/ST,
  // 1 K — no superflex). Bench (20) and IR (21) are excluded on purpose;
  // they're not "starting" requirements the optimizer needs to fill.
  const slotCounts: Record<string, number> = league.settings?.rosterSettings?.lineupSlotCounts ?? {};
  const slots: SlotRequirement[] = Object.entries(slotCounts)
    .filter(([id, count]) => STARTING_SLOT_IDS.has(Number(id)) && count > 0)
    .map(([id, count]) => ({
      slotId: Number(id),
      slotName: SLOT_ID_TO_NAME[Number(id)] ?? `slot ${id}`,
      count,
      eligiblePositions: SLOT_ID_TO_ELIGIBLE_POSITIONS[Number(id)] ?? [],
    }));

  await runLineupCheck(config, log, team, week, slots);
  await runWaiverCheck(config, log, team, week);
  await runTradeScan(config, log, week);
  await runTradeFinder(config, log, league, week);

  await saveDecisionLog(log);
  console.log(`[run] week ${week} complete. ${log.filter((e) => e.status === "pending").length} pending approvals.`);
}

async function resolveTappedButtons(config: Awaited<ReturnType<typeof loadConfig>>, log: DecisionLogEntry[]) {
  // Real bug found live: DRY_RUN would still poll+consume real taps, mark
  // the decision "approved," but executeDecision below no-ops the actual
  // write — leaving it permanently stuck "approved but never really
  // executed," with no code path left to retry it (only fresh taps or
  // pending-timeout logic act, and this is neither anymore). A later real
  // run then saw the entry as no longer pending and generated + sent a
  // duplicate card. DRY_RUN must not touch Telegram's tap queue at all —
  // leaving taps unpolled means a real run sees them fresh and handles them
  // correctly the first time.
  if (DRY_RUN) return;
  const taps = await pollButtonTaps(config);
  for (const tap of taps) {
    // Match by the decision's own id (embedded in callbackData as
    // `type:id:approve|reject`), not by telegramMessageId — a shortlist
    // card can carry many pending decisions on one message, each with its
    // own button, so messageId alone can't tell them apart.
    const [, id] = tap.callbackData.split(":");
    const entry = log.find((e) => e.id === id && e.status === "pending");
    if (!entry) continue;

    const approved = tap.callbackData.endsWith(":approve");
    entry.status = approved ? "approved" : "rejected";
    entry.resolvedAt = new Date().toISOString();
    await acknowledgeTap(config, tap.callbackQueryId, approved ? "Approved" : "Rejected");

    if (approved) await executeOrFail(config, entry);
    console.log(`[tap] ${entry.type} #${entry.id} -> ${entry.status}`);
  }
}

async function executeDecision(config: Awaited<ReturnType<typeof loadConfig>>, entry: DecisionLogEntry) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] would execute ${entry.type}:`, entry.payload);
    return;
  }
  const payload: any = entry.payload;
  if (entry.type === "lineup") {
    // Real crash found live (2026-09-15, run 34919473138): a lineup with
    // zero moves (already-optimal roster) still reached here via the
    // timeout safety net, and setLineup sent ESPN an empty `items` array —
    // which it rejects with 409 TRAN_ITEMS_MISSING. Zero moves means
    // nothing to change; skip the API call entirely rather than send a
    // request ESPN can only reject.
    //
    // Real crash found live (2026-10-18, run 39282103135 onward): a pending
    // lineup's moves went stale before the timeout fired — Judkins was
    // already benched — and ESPN rejected the whole transaction with 409
    // TRAN_ROSTER_SAME_SLOT. Re-sync against the live roster first: drop
    // moves that are already done (or whose player is gone) and use each
    // player's real current slot as the origin.
    const moves = await resyncLineupMoves(config, payload.moves ?? []);
    if (moves.length > 0) {
      await setLineup(config, payload.scoringPeriodId, moves);
    } else {
      console.log(`[lineup] #${entry.id}: roster already matches, no ESPN write needed.`);
    }
  } else if (entry.type === "waiver") {
    await submitWaiverClaim(config, entry.week, payload.addPlayerId, payload.dropPlayerId);
  } else if (entry.type === "trade") {
    await respondToTrade(config, payload.transactionId, true);
  }
  // No "trade_finder" branch — those are info-only suggestions now, never
  // reach here as a pending/approved decision. See runTradeFinder.
}

// Real bug found live (2026-10-18): executeDecision throwing inside the
// timeout loop crashed main() before saveDecisionLog, so the entry stayed
// "pending" on disk and every later run retried it and crashed again —
// blocking lineup/waiver/trade checks entirely. Contain the failure to the
// one entry: mark it "failed", tell Telegram, keep the run going. Auth
// errors still propagate so main's "send fresh cookies" ping fires.
async function executeOrFail(config: Awaited<ReturnType<typeof loadConfig>>, entry: DecisionLogEntry) {
  try {
    await executeDecision(config, entry);
  } catch (err) {
    if (err instanceof EspnAuthError) throw err;
    console.error(`[execute] ${entry.type} #${entry.id} failed:`, err);
    entry.status = "failed";
    entry.resolvedAt = new Date().toISOString();
    // sendMessage uses Markdown, and ESPN errors carry codes like
    // TRAN_ROSTER_SAME_SLOT — strip markup chars so Telegram can't 400 on it.
    const reason = String((err as Error)?.message ?? err).replace(/[_*`[\]]/g, " ").slice(0, 500);
    try {
      await sendMessage(config, `⚠️ Couldn't apply the ${entry.type} decision — ESPN rejected it:\n${reason}\n\nCheck it in the ESPN app.`);
    } catch (notifyErr) {
      console.error(`[execute] also failed to notify Telegram:`, notifyErr);
    }
  }
}

async function applyTimeouts(config: Awaited<ReturnType<typeof loadConfig>>, log: DecisionLogEntry[]) {
  const now = Date.now();
  for (const entry of log) {
    if (entry.status !== "pending") continue;
    const ageMinutes = (now - new Date(entry.createdAt).getTime()) / 60000;

    if (entry.type === "lineup" && ageMinutes >= config.settings.lineupApplyTimeoutMinutesBeforeLock) {
      // DRY_RUN must never mutate persisted state or send a real message —
      // same rule as everywhere else in this file. Just log what would
      // happen and leave the entry untouched for a real run to handle.
      if (DRY_RUN) {
        console.log(`[DRY RUN] would auto-apply lineup #${entry.id} (timeout elapsed).`);
        continue;
      }
      entry.status = "auto_applied";
      entry.resolvedAt = new Date().toISOString();
      await executeOrFail(config, entry);
      if (entry.status === "auto_applied") {
        await sendMessage(config, `⏱️ No response in time — auto-applied the recommended lineup (safety net).`);
      }
    }
    // Waivers: no auto-submit on timeout (your call) — just leave pending until
    // ESPN's own processing window passes, then mark skipped so it doesn't
    // resurface as if it were still actionable.
    if (entry.type === "waiver" && ageMinutes >= 7 * 24 * 60) {
      if (DRY_RUN) {
        console.log(`[DRY RUN] would mark waiver #${entry.id} auto_skipped (timeout elapsed).`);
        continue;
      }
      entry.status = "auto_skipped";
      entry.resolvedAt = new Date().toISOString();
    }
    // Trades never time out — intentionally no branch here.
  }
}

async function runLineupCheck(config: any, log: DecisionLogEntry[], team: any, week: number, slots: SlotRequirement[]) {
  const hasPending = log.some((e) => e.type === "lineup" && e.status === "pending" && e.week === week);
  if (hasPending) return;

  const entries: any[] = team.roster?.entries ?? [];
  const currentSlotByPlayerId = new Map<number, number>(entries.map((e: any) => [e.playerId, e.lineupSlotId]));
  const roster: LineupCandidate[] = entries.map((e: any) => {
    const p = e.playerPoolEntry?.player ?? e.player;
    return {
      playerId: p.id,
      name: p.fullName,
      position: PLAYER_POSITION_ID_TO_NAME[p.defaultPositionId] ?? "UNKNOWN",
      injuryStatus: p.injuryStatus ?? "ACTIVE",
      onByeWeek: p.byeWeek === week,
      projectedPoints: extractEspnProjection(e.playerPoolEntry ?? e, week) ?? 0,
    };
  });

  const result = optimizeLineup(roster, slots);

  const moves = diffLineupMoves(result.assignments, currentSlotByPlayerId);

  // Nothing to change — your lineup already matches the optimizer's pick.
  // Don't send a card or create a decision for this: there's nothing to
  // confirm, and an empty-moves decision left pending would eventually hit
  // the timeout safety net and try an ESPN write with nothing in it (a real
  // crash found live — see the moves.length check in executeDecision).
  if (moves.length === 0) {
    console.log(`[lineup] week ${week}: already optimal, no card needed.`);
    return;
  }

  const card = formatLineupCard(result, week);

  // DRY_RUN is a pure preview — it must never write a "pending" decision,
  // since a later LIVE run's timeout logic could then auto-apply an action
  // for a recommendation you were never actually shown.
  if (DRY_RUN) {
    console.log(`[DRY RUN] lineup card:\n${card}`);
    return;
  }

  const id = randomUUID();
  const messageId = await sendMessage(config, card + "\n\nTap to confirm:", [
    [
      { text: "✅ Approve", callbackData: `lineup:${id}:approve` },
      { text: "❌ Reject", callbackData: `lineup:${id}:reject` },
    ],
  ]);

  log.push({
    id,
    type: "lineup",
    week,
    createdAt: new Date().toISOString(),
    summary: card,
    payload: { scoringPeriodId: week, moves },
    status: "pending",
    telegramMessageId: messageId,
  });
}

async function runWaiverCheck(config: any, log: DecisionLogEntry[], team: any, week: number) {
  const hasPending = log.some((e) => e.type === "waiver" && e.status === "pending" && e.week === week);
  if (hasPending) return;

  const freeAgentsResp: any = await getFreeAgents(config);
  const trending = await getSleeperTrendingByEspnId();

  const candidates: WaiverCandidate[] = [];
  for (const entry of freeAgentsResp.players ?? []) {
    const p = entry.player;
    const espnPoints = extractEspnProjection(entry, week);
    const position = PLAYER_POSITION_ID_TO_NAME[p.defaultPositionId] ?? "UNKNOWN";
    const fpNote = await getFantasyProsSanityCheck(p.fullName, position);
    const adjusted = adjustProjection(espnPoints, trending.get(p.id) ?? null, fpNote?.rank ?? null, null);
    candidates.push({
      playerId: p.id,
      name: p.fullName,
      position,
      projectedPoints: adjusted.points,
      confidenceLabel: adjusted.confidenceLabel,
      matchupNote: adjusted.fantasyProsNote,
    });
  }

  const rosterEntries: any[] = team.roster?.entries ?? [];
  const roster: RosterPlayer[] = rosterEntries.map((e: any) => {
    const p = e.playerPoolEntry?.player ?? e.player;
    return {
      playerId: p.id,
      name: p.fullName,
      position: PLAYER_POSITION_ID_TO_NAME[p.defaultPositionId] ?? "UNKNOWN",
      projectedPoints: extractEspnProjection(e.playerPoolEntry ?? e, week) ?? 0,
      // NEEDS LIVE VERIFICATION: derive from the optimizer's current-week
      // assignment once step 5 is live, rather than assuming starters==locked.
      isLockedStarter: e.lineupSlotId !== 20 && e.lineupSlotId !== 21,
    };
  });

  const ranked = pickWaiverCandidates(candidates, roster);
  if (ranked.length === 0) {
    console.log(`[waiver] no candidate clears the upgrade bar for week ${week}.`);
    return;
  }

  const shown = ranked.slice(0, WAIVER_SHORTLIST_CAP);
  const card = formatWaiverShortlistCard(ranked, week);

  if (DRY_RUN) {
    console.log(`[DRY RUN] waiver shortlist:\n${card}`);
    return;
  }

  // Each shown candidate is its own independent decision, its own button, on
  // one shared message — you can tap zero, one, or several.
  const ids = shown.map(() => randomUUID());
  const buttonRows = shown.map((rec, i) => [
    { text: `✅ #${i + 1}: ${rec.add.name}`, callbackData: `waiver:${ids[i]}:approve` },
  ]);
  const messageId = await sendMessage(config, card, buttonRows);

  shown.forEach((rec, i) => {
    log.push({
      id: ids[i],
      type: "waiver",
      week,
      createdAt: new Date().toISOString(),
      summary: `Add ${rec.add.name}, drop ${rec.drop?.name ?? "(open spot)"}`,
      payload: { addPlayerId: rec.add.playerId, dropPlayerId: rec.drop?.playerId },
      status: "pending",
      telegramMessageId: messageId,
    });
  });
}

async function runTradeScan(config: any, log: DecisionLogEntry[], week: number) {
  const transactions: any = await getTransactions(config);
  const pendingTrades: any[] = (transactions.transactions ?? []).filter(
    (t: any) => t.type === "TRADE" && t.status === "PENDING"
  );

  for (const trade of pendingTrades) {
    const alreadyLogged = log.some((e) => e.type === "trade" && (e.payload as any)?.transactionId === trade.id);
    if (alreadyLogged) continue;

    // NEEDS LIVE VERIFICATION: confirm trade.items shape against a real
    // pending proposal — field names for give/get sides vary across ESPN API
    // versions in community reports.
    const playersOut: string[] = trade.items?.filter((i: any) => i.fromTeamId === config.espn.teamId).map((i: any) => i.playerName) ?? [];
    const playersIn: string[] = trade.items?.filter((i: any) => i.toTeamId === config.espn.teamId).map((i: any) => i.playerName) ?? [];

    const values = await getFantasyCalcValues({ numTeams: 12 });
    const evalResult = evaluateTrade(playersOut, playersIn, values, config.settings.tradeLopsidedGapPct);
    const card = formatTradeCard(playersOut, playersIn, evalResult);

    if (DRY_RUN) {
      console.log(`[DRY RUN] trade card:\n${card}`);
      continue;
    }

    const id = randomUUID();
    const messageId = await sendMessage(config, card, [
      [
        { text: "✅ Approve", callbackData: `trade:${id}:approve` },
        { text: "❌ Reject", callbackData: `trade:${id}:reject` },
      ],
    ]);

    log.push({
      id,
      type: "trade",
      week,
      createdAt: new Date().toISOString(),
      summary: card,
      payload: { transactionId: trade.id },
      status: "pending",
      telegramMessageId: messageId,
    });
  }
}

/** Proactively scans every team for trade ideas worth proposing. Runs at
 * most once per UTC day — no urgency here, unlike lineup/waiver checks. */
/**
 * Proactive trade suggestions — informational only. There's no safe way to
 * verify ESPN's create-a-trade payload shape without it immediately becoming
 * a real, visible offer to another manager (unlike lineup/waiver writes,
 * there's no server-side "draft" state — confirmed via ESPN's own support
 * docs: the in-app "Review" screen is a client-side step before the one-shot
 * submit call, not a separate API-visible draft). So this sends analysis
 * only — who to offer, what, and why — and you send it yourself in the ESPN
 * app. `proposeTrade` in espn/client.ts stays unverified and unwired.
 */
async function runTradeFinder(config: any, log: DecisionLogEntry[], league: any, week: number) {
  const state = await loadTradeFinderState();
  const today = new Date().toISOString().slice(0, 10);
  if (state.lastRunDate === today) return;

  const teams: TeamRoster[] = (league.teams ?? []).map((t: any) => {
    const entries: any[] = t.roster?.entries ?? [];
    const players: TeamRosterPlayer[] = entries.map((e: any) => {
      const p = e.playerPoolEntry?.player ?? e.player;
      return {
        playerId: p.id,
        name: p.fullName,
        position: PLAYER_POSITION_ID_TO_NAME[p.defaultPositionId] ?? "UNKNOWN",
        projectedPoints: extractEspnProjection(e.playerPoolEntry ?? e, week) ?? 0,
        slot: e.lineupSlotId,
      };
    });
    return { teamId: t.id, teamName: `${t.location ?? ""} ${t.nickname ?? t.name ?? ""}`.trim(), players };
  });

  const values = await getFantasyCalcValues({ numTeams: 12 });
  const suggestions = findTradeCandidates(teams, config.espn.teamId, values, config.settings.tradeLopsidedGapPct);
  const card = formatTradeFinderCard(suggestions, week);

  if (DRY_RUN) {
    console.log(`[DRY RUN] trade finder:\n${card}`);
    return; // don't advance lastRunDate in dry-run — pure preview, no state change
  }

  await saveTradeFinderState({ lastRunDate: today });

  if (suggestions.length === 0) return; // nothing worth sending a message for

  // Info only — no buttons, nothing to "approve." Sending any of these is a
  // real, visible offer to another manager, so that step stays manual, done
  // by you in the ESPN app once you've read the reasoning.
  await sendMessage(config, card + "\n\n_Send any of these yourself in the ESPN app — not automated._");
}

main().catch(async (err) => {
  console.error("[run] failed:", err);
  process.exitCode = 1;

  if (err instanceof EspnAuthError) {
    try {
      const config = await loadConfig();
      await sendMessage(config, `🔒 ${err.message}\n\nGrab fresh espn_s2/SWID cookies and update bot/config.json in the repo — the bot can't do anything until then.`);
    } catch (notifyErr) {
      console.error("[run] also failed to notify Telegram about the auth error:", notifyErr);
    }
  }
});
