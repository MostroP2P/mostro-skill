#!/usr/bin/env tsx
/**
 * Auto-Trade — Automated trading strategies for Mostro
 *
 * Supports:
 * - DCA (Dollar-Cost Averaging): Buy/sell at regular intervals
 * - Limit orders: Take orders that match specific criteria
 * - Market making: Maintain buy and sell orders with a spread
 *
 * Usage:
 *   tsx scripts/auto-trade.ts --strategy strategies/dca-weekly.json
 *   tsx scripts/auto-trade.ts --strategy strategies/dca-weekly.json --dry-run
 *   tsx scripts/auto-trade.ts --strategy strategies/limit-buy.json --once
 */

import { readFileSync, existsSync } from "fs";
import { loadConfig, validateConfig, type MostroConfig } from "../lib/config.js";
import {
  createClient,
  closeClient,
  sendGiftWrap,
  fetchGiftWraps,
  fetchOrderEvents,
} from "../lib/nostr.js";
import {
  buildOrderMessage,
  buildNewOrderPayload,
  getInnerMessageKind,
  parseOrderEvent,
  type ParsedOrderEvent,
  type Action,
  type Payload,
} from "../lib/protocol.js";
import { getOrCreateKeys, getNextTradeKeys } from "../lib/keys.js";
import { checkLimits, auditLog, recordTrade, validateOrderPrice } from "../lib/safety.js";

// ─── Strategy Types ─────────────────────────────────────────────────────────

interface BaseStrategy {
  type: "dca" | "limit" | "market-maker";
  name: string;
  currency: string;
  payment_method: string;
  enabled: boolean;
}

interface DCAStrategy extends BaseStrategy {
  type: "dca";
  kind: "buy" | "sell";
  fiat_amount: number;
  interval_hours: number;
  max_premium: number;
  invoice?: string; // LN address for buy orders
}

interface LimitStrategy extends BaseStrategy {
  type: "limit";
  kind: "buy" | "sell";
  action: "take-sell" | "take-buy";
  max_premium: number;
  min_amount?: number;
  max_amount?: number;
  min_rating?: number;
  invoice?: string;
}

interface MarketMakerStrategy extends BaseStrategy {
  type: "market-maker";
  buy_premium: number;
  sell_premium: number;
  fiat_amount: number;
  min_amount?: number;
  max_amount?: number;
}

type Strategy = DCAStrategy | LimitStrategy | MarketMakerStrategy;

// ─── Args ───────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  let dryRun = false;
  let once = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--once") once = true;
    else if (args[i].startsWith("--") && i + 1 < args.length) {
      opts[args[i].slice(2).replace(/-/g, "_")] = args[++i];
    }
  }
  if (!opts.strategy) {
    console.error("Usage: auto-trade.ts --strategy <path-to-strategy.json> [--dry-run] [--once]");
    process.exit(1);
  }
  return { strategyPath: opts.strategy, dryRun, once };
}

function loadStrategy(path: string): Strategy {
  if (!existsSync(path)) {
    console.error(`❌ Strategy file not found: ${path}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

// ─── DCA Strategy ───────────────────────────────────────────────────────────

async function executeDCA(
  strategy: DCAStrategy,
  config: MostroConfig,
  dryRun: boolean
): Promise<void> {
  console.log(`📅 DCA Strategy: "${strategy.name}"`);
  console.log(`   ${strategy.kind.toUpperCase()} ${strategy.fiat_amount} ${strategy.currency} every ${strategy.interval_hours}h`);
  console.log(`   Max premium: ${strategy.max_premium}%`);
  console.log("");

  // Check limits
  const limitCheck = checkLimits(config.limits, strategy.fiat_amount);
  if (!limitCheck.allowed) {
    console.log(`🚫 Blocked by limits: ${limitCheck.reason}`);
    return;
  }

  if (dryRun) {
    console.log("🧪 DRY RUN — would create order:");
    console.log(`   ${strategy.kind} ${strategy.fiat_amount} ${strategy.currency}`);
    console.log(`   payment: ${strategy.payment_method}, premium: ${strategy.max_premium}%`);
    auditLog({
      timestamp: new Date().toISOString(),
      action: "auto-trade-dca",
      fiat_amount: strategy.fiat_amount,
      fiat_code: strategy.currency,
      result: "success",
      details: "dry-run",
    });
    return;
  }

  const { keys } = getOrCreateKeys();
  const tradeKeys = getNextTradeKeys(keys);
  const requestId = Math.floor(Math.random() * 2 ** 48);

  const payload = buildNewOrderPayload({
    kind: strategy.kind,
    fiat_code: strategy.currency,
    fiat_amount: strategy.fiat_amount,
    payment_method: strategy.payment_method,
    premium: strategy.max_premium,
    buyer_invoice: strategy.invoice,
  });

  const message = buildOrderMessage("new-order", undefined, requestId, tradeKeys.index, payload);
  const client = createClient(config, keys);

  try {
    console.log("📤 Creating DCA order...");
    await sendGiftWrap(client, message, null, tradeKeys.privateKey, keys.identityPrivateKey);

    await new Promise((r) => setTimeout(r, 8000));
    const responses = await fetchGiftWraps(client, tradeKeys.privateKey, 5);

    for (const resp of responses) {
      const kind = getInnerMessageKind(resp.message);
      if (kind.action === "new-order") {
        const p = kind.payload as any;
        console.log(`✅ DCA order created: ${p?.order?.id ?? kind.id}`);
        recordTrade(strategy.fiat_amount);
      } else if (kind.action === "cant-do") {
        console.error(`❌ Rejected: ${JSON.stringify(kind.payload)}`);
      }
    }

    auditLog({
      timestamp: new Date().toISOString(),
      action: "auto-trade-dca",
      fiat_amount: strategy.fiat_amount,
      fiat_code: strategy.currency,
      result: "success",
    });
  } finally {
    closeClient(client);
  }
}

// ─── Limit Strategy ─────────────────────────────────────────────────────────

async function executeLimit(
  strategy: LimitStrategy,
  config: MostroConfig,
  dryRun: boolean
): Promise<void> {
  console.log(`🎯 Limit Strategy: "${strategy.name}"`);
  console.log(`   Looking for ${strategy.kind} orders in ${strategy.currency}`);
  console.log(`   Max premium: ${strategy.max_premium}%`);
  if (strategy.min_rating) console.log(`   Min rating: ${strategy.min_rating}`);
  console.log("");

  const client = createClient(config);

  try {
    // Fetch matching orders
    const orderKindFilter = strategy.action === "take-sell" ? "sell" : "buy";
    const events = await fetchOrderEvents(client, {
      status: "pending",
      kind: orderKindFilter,
      currency: strategy.currency,
      limit: 50,
    });

    const orders = events.map((e) => parseOrderEvent(e.tags));

    // Filter by criteria
    const matching = orders.filter((o) => {
      if (o.premium > strategy.max_premium) return false;
      if (strategy.min_amount && parseFloat(o.fiat_amount) < strategy.min_amount) return false;
      if (strategy.max_amount && parseFloat(o.fiat_amount) > strategy.max_amount) return false;
      if (strategy.min_rating && o.rating) {
        try {
          const ratingData = JSON.parse(o.rating);
          if (ratingData.total_reviews > 0) {
            const avgRating = ratingData.total_rating / ratingData.total_reviews;
            if (avgRating < strategy.min_rating) return false;
          }
        } catch {}
      }
      return true;
    });

    if (matching.length === 0) {
      console.log("📭 No matching orders found.");
      return;
    }

    // Sort by premium (best first)
    matching.sort((a, b) => a.premium - b.premium);
    const best = matching[0];

    console.log(`🏆 Best match: ${best.fiat_amount} ${best.currency} @ ${best.premium}% [${best.id.slice(0, 8)}...]`);

    const fiatAmount = parseFloat(best.fiat_amount);
    const limitCheck = checkLimits(config.limits, fiatAmount);
    if (!limitCheck.allowed) {
      console.log(`🚫 Blocked by limits: ${limitCheck.reason}`);
      return;
    }

    // Validate price
    const priceCheck = await validateOrderPrice(
      { fiat_amount: fiatAmount, amount: best.amount, fiat_code: best.currency, premium: best.premium },
      config.max_premium_deviation
    );
    if (!priceCheck.valid) {
      console.log(`🚫 Price check failed: ${priceCheck.reason}`);
      return;
    }

    if (dryRun) {
      console.log("🧪 DRY RUN — would take this order.");
      return;
    }

    // Take the order
    const { keys } = getOrCreateKeys();
    const tradeKeys = getNextTradeKeys(keys);
    const requestId = Math.floor(Math.random() * 2 ** 48);

    let payload: Payload | null = null;
    if (strategy.invoice && strategy.action === "take-sell") {
      payload = { payment_request: [null, strategy.invoice, null] };
    }

    const message = buildOrderMessage(strategy.action as Action, best.id, requestId, tradeKeys.index, payload);

    const tradeClient = createClient(config, keys);
    try {
      console.log("📤 Taking order...");
      await sendGiftWrap(tradeClient, message, null, tradeKeys.privateKey, keys.identityPrivateKey);
      console.log("✅ Order taken!");

      recordTrade(fiatAmount);
      auditLog({
        timestamp: new Date().toISOString(),
        action: "auto-trade-limit",
        order_id: best.id,
        fiat_amount: fiatAmount,
        fiat_code: best.currency,
        result: "success",
      });
    } finally {
      closeClient(tradeClient);
    }
  } finally {
    closeClient(client);
  }
}

// ─── Market Maker Strategy ──────────────────────────────────────────────────

async function executeMarketMaker(
  strategy: MarketMakerStrategy,
  config: MostroConfig,
  dryRun: boolean
): Promise<void> {
  console.log(`📊 Market Maker Strategy: "${strategy.name}"`);
  console.log(`   Currency: ${strategy.currency}`);
  console.log(`   Buy premium: ${strategy.buy_premium}% | Sell premium: ${strategy.sell_premium}%`);
  console.log(`   Spread: ${strategy.sell_premium - strategy.buy_premium}%`);
  console.log(`   Amount: ${strategy.fiat_amount} ${strategy.currency}`);
  console.log("");

  // Check limits (need room for both buy and sell)
  const limitCheck = checkLimits(config.limits, strategy.fiat_amount * 2);
  if (!limitCheck.allowed) {
    console.log(`🚫 Blocked by limits: ${limitCheck.reason}`);
    return;
  }

  if (dryRun) {
    console.log("🧪 DRY RUN — would create:");
    console.log(`   BUY  ${strategy.fiat_amount} ${strategy.currency} @ ${strategy.buy_premium}%`);
    console.log(`   SELL ${strategy.fiat_amount} ${strategy.currency} @ ${strategy.sell_premium}%`);
    return;
  }

  const { keys } = getOrCreateKeys();
  const client = createClient(config, keys);

  try {
    // Create buy order
    const buyTradeKeys = getNextTradeKeys(keys);
    const buyPayload = buildNewOrderPayload({
      kind: "buy",
      fiat_code: strategy.currency,
      fiat_amount: strategy.fiat_amount,
      payment_method: strategy.payment_method,
      premium: strategy.buy_premium,
      min_amount: strategy.min_amount,
      max_amount: strategy.max_amount,
    });
    const buyMsg = buildOrderMessage("new-order", undefined, Math.floor(Math.random() * 2 ** 48), buyTradeKeys.index, buyPayload);

    console.log("📤 Creating buy order...");
    await sendGiftWrap(client, buyMsg, null, buyTradeKeys.privateKey, keys.identityPrivateKey);

    // Create sell order
    const sellTradeKeys = getNextTradeKeys(keys);
    const sellPayload = buildNewOrderPayload({
      kind: "sell",
      fiat_code: strategy.currency,
      fiat_amount: strategy.fiat_amount,
      payment_method: strategy.payment_method,
      premium: strategy.sell_premium,
      min_amount: strategy.min_amount,
      max_amount: strategy.max_amount,
    });
    const sellMsg = buildOrderMessage("new-order", undefined, Math.floor(Math.random() * 2 ** 48), sellTradeKeys.index, sellPayload);

    console.log("📤 Creating sell order...");
    await sendGiftWrap(client, sellMsg, null, sellTradeKeys.privateKey, keys.identityPrivateKey);

    console.log("✅ Market maker orders created.");
    recordTrade(strategy.fiat_amount);
    recordTrade(strategy.fiat_amount);

    auditLog({
      timestamp: new Date().toISOString(),
      action: "auto-trade-market-maker",
      fiat_amount: strategy.fiat_amount,
      fiat_code: strategy.currency,
      result: "success",
      details: `buy@${strategy.buy_premium}% sell@${strategy.sell_premium}%`,
    });
  } finally {
    closeClient(client);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const strategy = loadStrategy(opts.strategyPath);
  const config = loadConfig();
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error("❌ Configuration errors:\n" + errors.map((e) => `  - ${e}`).join("\n"));
    process.exit(1);
  }

  if (!strategy.enabled) {
    console.log(`⏸️  Strategy "${strategy.name}" is disabled. Set "enabled": true to activate.`);
    return;
  }

  if (opts.dryRun) {
    console.log("🧪 DRY RUN MODE — no actual trades will be executed.\n");
  }

  switch (strategy.type) {
    case "dca":
      await executeDCA(strategy as DCAStrategy, config, opts.dryRun);
      break;
    case "limit":
      await executeLimit(strategy as LimitStrategy, config, opts.dryRun);
      break;
    case "market-maker":
      await executeMarketMaker(strategy as MarketMakerStrategy, config, opts.dryRun);
      break;
    default:
      console.error(`❌ Unknown strategy type: ${(strategy as any).type}`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("❌ Error:", e.message);
  process.exit(1);
});
