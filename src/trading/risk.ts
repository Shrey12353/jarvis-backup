/**
 * SURVIVE/DIE risk governor for ₹10,000 capital.
 *
 * The one condition: SURVIVE. These rules exist so the system cannot lose the
 * account in one bad day, one bad week, or one bad idea. Every rule is a hard
 * wall — the engine checks them before and after every action.
 */
export interface RiskConfig {
  initialCapital: number;      // ₹10,000
  maxPositionPct: number;      // max % of initial capital per position
  maxPositions: number;        // max concurrent positions
  stopLossPct: number;         // per-position stop loss
  dailyLossHaltPct: number;    // day loss above this -> no new trades that day
  drawdownReviewPct: number;   // equity below this % of initial -> halt + review
  drawdownLockPct: number;     // equity below this % of initial -> locked, human reset required
}

export const DEFAULT_RISK: RiskConfig = {
  initialCapital: 10_000,
  maxPositionPct: 20,       // ₹2,000 per stock max
  maxPositions: 4,          // never more than 4 stocks at once
  stopLossPct: 5,           // auto-exit if a position falls 5%
  dailyLossHaltPct: 2,      // lose 2% in a day -> stop for the day
  drawdownReviewPct: 80,    // equity ₹8,000 -> full stop, human review
  drawdownLockPct: 70,      // equity ₹7,000 -> system locked
};

export type HaltLevel = "none" | "daily" | "review" | "locked";

export interface RiskDecision {
  allowed: boolean;
  halt: HaltLevel;
  reasons: string[];
  maxQty: number;
  positionBudget: number;
}

export function positionBudget(risk: RiskConfig, equity: number): number {
  // Budget per position: min(% of initial, % of current equity) — never rebuild size with losses
  return Math.floor(Math.min(risk.initialCapital * (risk.maxPositionPct / 100), equity * 0.25));
}

export function checkEquityCircuitBreakers(risk: RiskConfig, equity: number): HaltLevel {
  if (equity <= risk.initialCapital * (risk.drawdownLockPct / 100)) return "locked";
  if (equity <= risk.initialCapital * (risk.drawdownReviewPct / 100)) return "review";
  return "none";
}

export function checkDailyLoss(risk: RiskConfig, equityStartOfDay: number, equityNow: number): boolean {
  const lossPct = ((equityStartOfDay - equityNow) / equityStartOfDay) * 100;
  return lossPct >= risk.dailyLossHaltPct;
}

/** Can we open a NEW position of `qty` at `price` right now? */
export function canOpen(
  risk: RiskConfig,
  state: { equity: number; cash: number; positions: number; halt: HaltLevel; dayHalted: boolean },
  price: number
): RiskDecision {
  const reasons: string[] = [];
  const budget = positionBudget(risk, state.equity);
  const qty = Math.floor(budget / price);

  if (state.halt === "locked") reasons.push(`SYSTEM LOCKED: equity ₹${Math.round(state.equity)} hit the ${risk.drawdownLockPct}% floor. Human reset required.`);
  else if (state.halt === "review") reasons.push(`TRADING HALTED: equity ₹${Math.round(state.equity)} below the ${risk.drawdownReviewPct}% review line.`);
  if (state.dayHalted) reasons.push(`Daily loss limit (${risk.dailyLossHaltPct}%) hit — no new trades today.`);
  if (state.positions >= risk.maxPositions) reasons.push(`Max concurrent positions (${risk.maxPositions}) reached.`);
  if (qty < 1) reasons.push(`Position budget ₹${budget} too small for price ₹${price}.`);
  if (budget > state.cash) reasons.push(`Not enough cash: need ₹${budget}, have ₹${Math.round(state.cash)}.`);

  return { allowed: reasons.length === 0, halt: state.halt, reasons, maxQty: Math.max(0, qty), positionBudget: budget };
}

/** Stop-loss check for an open position. */
export function hitStopLoss(risk: RiskConfig, entryPx: number, lastPx: number): boolean {
  return ((entryPx - lastPx) / entryPx) * 100 >= risk.stopLossPct;
}
