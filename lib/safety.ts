/**
 * Safety Module — Trade Limits, Audit Logging, Confirmation
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { TradeLimits } from "./config.js";

const SKILL_DATA_DIR = join(process.env.HOME ?? "/tmp", ".mostro-skill");
const AUDIT_LOG = join(SKILL_DATA_DIR, "audit.log");
const STATE_FILE = join(SKILL_DATA_DIR, "trade-state.json");

function ensureDataDir(): void {
  if (!existsSync(SKILL_DATA_DIR)) {
    mkdirSync(SKILL_DATA_DIR, { recursive: true, mode: 0o700 });
  }
}

// ─── Audit Logging ──────────────────────────────────────────────────────────

export interface AuditEntry {
  timestamp: string;
  action: string;
  order_id?: string;
  fiat_amount?: number;
  fiat_code?: string;
  result: "success" | "failed" | "pending" | "rejected";
  details?: string;
}

/**
 * Log an action to the audit trail
 */
export function auditLog(entry: AuditEntry): void {
  ensureDataDir();
  const line = JSON.stringify({ ...entry, timestamp: entry.timestamp || new Date().toISOString() });
  appendFileSync(AUDIT_LOG, line + "\n", { mode: 0o600 });
}

/**
 * Read recent audit entries
 */
export function getRecentAudit(count = 20): AuditEntry[] {
  if (!existsSync(AUDIT_LOG)) return [];
  const lines = readFileSync(AUDIT_LOG, "utf-8").trim().split("\n").filter(Boolean);
  return lines.slice(-count).map((l) => JSON.parse(l));
}

// ─── Trade State Tracking ───────────────────────────────────────────────────

interface TradeState {
  daily_volume: { [date: string]: number };
  daily_trades: { [date: string]: number };
  last_trade_at?: string;
}

function loadState(): TradeState {
  if (!existsSync(STATE_FILE)) return { daily_volume: {}, daily_trades: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { daily_volume: {}, daily_trades: {} };
  }
}

function saveState(state: TradeState): void {
  ensureDataDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function todayKey(): string {
  return new Date().toISOString().split("T")[0];
}

// ─── Limit Checks ───────────────────────────────────────────────────────────

export interface LimitCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check if a trade is within configured limits
 * @param limits - Trade limits configuration
 * @param satsAmount - Amount of the trade in satoshis
 */
export function checkLimits(
  limits: TradeLimits,
  satsAmount: number
): LimitCheckResult {
  const state = loadState();
  const today = todayKey();

  // Check single trade amount (in sats)
  if (satsAmount > limits.max_trade_amount_sats) {
    return {
      allowed: false,
      reason: `Trade amount ${satsAmount} sats exceeds max ${limits.max_trade_amount_sats} sats`,
    };
  }

  // Check daily volume (in sats)
  const todayVolume = state.daily_volume[today] ?? 0;
  if (todayVolume + satsAmount > limits.max_daily_volume_sats) {
    return {
      allowed: false,
      reason: `Would exceed daily volume limit: ${todayVolume + satsAmount} > ${limits.max_daily_volume_sats} sats`,
    };
  }

  // Check daily trade count
  const todayTrades = state.daily_trades[today] ?? 0;
  if (todayTrades >= limits.max_trades_per_day) {
    return {
      allowed: false,
      reason: `Daily trade limit reached: ${todayTrades}/${limits.max_trades_per_day}`,
    };
  }

  // Check cooldown
  if (state.last_trade_at && limits.cooldown_seconds > 0) {
    const lastTradeTime = new Date(state.last_trade_at).getTime();
    const elapsed = (Date.now() - lastTradeTime) / 1000;
    if (elapsed < limits.cooldown_seconds) {
      const remaining = Math.ceil(limits.cooldown_seconds - elapsed);
      return {
        allowed: false,
        reason: `Cooldown active: ${remaining}s remaining`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Record a trade execution for limit tracking
 * @param satsAmount - Amount of the trade in satoshis
 */
export function recordTrade(satsAmount: number): void {
  const state = loadState();
  const today = todayKey();

  state.daily_volume[today] = (state.daily_volume[today] ?? 0) + satsAmount;
  state.daily_trades[today] = (state.daily_trades[today] ?? 0) + 1;
  state.last_trade_at = new Date().toISOString();

  // Clean up old dates (keep last 7 days)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const cutoff = sevenDaysAgo.toISOString().split("T")[0];
  for (const key of Object.keys(state.daily_volume)) {
    if (key < cutoff) {
      delete state.daily_volume[key];
      delete state.daily_trades[key];
    }
  }

  saveState(state);
}

// ─── Price Validation ───────────────────────────────────────────────────────

/**
 * Fetch current BTC price for a fiat currency
 */
export async function fetchBtcPrice(
  fiatCode: string,
  apiUrl = "https://api.yadio.io/exrates/BTC"
): Promise<number | null> {
  try {
    const res = await fetch(apiUrl);
    const data = await res.json() as any;
    return data?.BTC?.[fiatCode.toUpperCase()] ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if an order's premium is within acceptable deviation
 */
export function isPremiumAcceptable(
  orderPremium: number,
  maxDeviation: number
): boolean {
  return Math.abs(orderPremium) <= maxDeviation;
}

/**
 * Validate an order's price against market data
 *
 * Returns { valid, marketPrice, orderPrice, deviationPercent, reason? }
 */
export async function validateOrderPrice(
  order: { fiat_amount: number; amount: number; fiat_code: string; premium?: number },
  maxPremiumDeviation: number,
  apiUrl = "https://api.yadio.io/exrates/BTC"
): Promise<{
  valid: boolean;
  marketPrice: number | null;
  orderPrice: number | null;
  deviationPercent: number | null;
  reason?: string;
}> {
  const marketPrice = await fetchBtcPrice(order.fiat_code, apiUrl);

  if (marketPrice === null) {
    return {
      valid: true, // Allow if we can't check — don't block trades
      marketPrice: null,
      orderPrice: null,
      deviationPercent: null,
      reason: "Could not fetch market price — skipping validation",
    };
  }

  // If premium is provided, check it directly
  if (order.premium !== undefined) {
    const deviation = order.premium;
    const valid = Math.abs(deviation) <= maxPremiumDeviation;
    return {
      valid,
      marketPrice,
      orderPrice: null,
      deviationPercent: deviation,
      reason: valid
        ? undefined
        : `Premium ${deviation}% exceeds max deviation ±${maxPremiumDeviation}%`,
    };
  }

  // If we have both fiat and sats amounts, calculate effective price
  if (order.amount > 0 && order.fiat_amount > 0) {
    const orderPrice = order.fiat_amount / (order.amount / 1e8);
    const deviationPercent = ((orderPrice - marketPrice) / marketPrice) * 100;
    const valid = Math.abs(deviationPercent) <= maxPremiumDeviation;
    return {
      valid,
      marketPrice,
      orderPrice,
      deviationPercent: Math.round(deviationPercent * 100) / 100,
      reason: valid
        ? undefined
        : `Price deviation ${deviationPercent.toFixed(1)}% exceeds max ±${maxPremiumDeviation}%`,
    };
  }

  return {
    valid: true,
    marketPrice,
    orderPrice: null,
    deviationPercent: null,
  };
}
