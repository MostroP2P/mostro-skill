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
 */
export function checkLimits(
  limits: TradeLimits,
  fiatAmount: number
): LimitCheckResult {
  const state = loadState();
  const today = todayKey();

  // Check single trade amount
  if (fiatAmount > limits.max_trade_amount_fiat) {
    return {
      allowed: false,
      reason: `Trade amount ${fiatAmount} exceeds max ${limits.max_trade_amount_fiat}`,
    };
  }

  // Check daily volume
  const todayVolume = state.daily_volume[today] ?? 0;
  if (todayVolume + fiatAmount > limits.max_daily_volume_fiat) {
    return {
      allowed: false,
      reason: `Would exceed daily volume limit: ${todayVolume + fiatAmount} > ${limits.max_daily_volume_fiat}`,
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
 */
export function recordTrade(fiatAmount: number): void {
  const state = loadState();
  const today = todayKey();

  state.daily_volume[today] = (state.daily_volume[today] ?? 0) + fiatAmount;
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
