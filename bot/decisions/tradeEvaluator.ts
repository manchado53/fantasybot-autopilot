// Trade fairness = compare FantasyCalc consensus values on both sides.
// Verified free endpoint, no auth: https://api.fantasycalc.com/values/current
// This NEVER auto-acts (per your call) — it just computes the gap % so the
// Telegram card can show you a fast, honest "who wins this deal" read.

export interface FantasyCalcPlayerValue {
  player: { name: string; espnId?: number };
  value: number;
}

let valuesCache: FantasyCalcPlayerValue[] | null = null;

export async function getFantasyCalcValues(opts: { isDynasty?: boolean; numTeams?: number; ppr?: number } = {}): Promise<FantasyCalcPlayerValue[]> {
  if (valuesCache) return valuesCache;
  const params = new URLSearchParams({
    isDynasty: String(opts.isDynasty ?? false),
    numQbs: "1",
    numTeams: String(opts.numTeams ?? 12),
    ppr: String(opts.ppr ?? 1),
  });
  const res = await fetch(`https://api.fantasycalc.com/values/current?${params}`);
  if (!res.ok) throw new Error(`FantasyCalc fetch failed: ${res.status}`);
  valuesCache = (await res.json()) as FantasyCalcPlayerValue[];
  return valuesCache!;
}

export interface TradeEvaluation {
  valueOut: number;
  valueIn: number;
  gapPct: number;
  favors: "you" | "them" | "even";
  lopsided: boolean;
  missingValues: string[];
}

export function evaluateTrade(
  playersOut: string[],
  playersIn: string[],
  values: FantasyCalcPlayerValue[],
  lopsidedThresholdPct: number
): TradeEvaluation {
  const findValue = (name: string): number | null => {
    const hit = values.find((v) => v.player.name.toLowerCase() === name.toLowerCase());
    return hit?.value ?? null;
  };

  const missingValues: string[] = [];
  const sum = (names: string[]) =>
    names.reduce((total, name) => {
      const v = findValue(name);
      if (v == null) missingValues.push(name);
      return total + (v ?? 0);
    }, 0);

  const valueOut = sum(playersOut);
  const valueIn = sum(playersIn);
  const larger = Math.max(valueOut, valueIn, 1);
  const gapPct = Math.round((Math.abs(valueOut - valueIn) / larger) * 1000) / 10;

  return {
    valueOut,
    valueIn,
    gapPct,
    favors: valueIn === valueOut ? "even" : valueIn > valueOut ? "you" : "them",
    lopsided: gapPct > lopsidedThresholdPct,
    missingValues,
  };
}

export function formatTradeCard(
  playersOut: string[],
  playersIn: string[],
  evalResult: TradeEvaluation
): string {
  const lines = [
    `*Trade review*`,
    `You give: ${playersOut.join(", ")}`,
    `You get: ${playersIn.join(", ")}`,
    `Value: you-give ${evalResult.valueOut} vs you-get ${evalResult.valueIn} (gap ${evalResult.gapPct}%, favors ${evalResult.favors})`,
    evalResult.lopsided ? "⚠️ This looks lopsided by the numbers." : "Looks roughly fair by the numbers.",
  ];
  if (evalResult.missingValues.length) {
    lines.push(`_No FantasyCalc value found for: ${evalResult.missingValues.join(", ")} — judge those manually._`);
  }
  lines.push("", "This never auto-executes — reply below to decide.");
  return lines.join("\n");
}
