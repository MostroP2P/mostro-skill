#!/usr/bin/env tsx
/**
 * Create Order — Create a new buy or sell order on Mostro
 *
 * Usage:
 *   tsx scripts/create-order.ts --kind buy --currency USD --fiat-amount 50 --payment-method "bank transfer" [--premium 2] [--amount 0] [--min-amount 10] [--max-amount 100] [--invoice user@ln.tips]
 */

import { loadConfig, validateConfig } from "../lib/config.js";
import {
  createClient,
  closeClient,
  sendGiftWrap,
  fetchGiftWraps,
} from "../lib/nostr.js";
import {
  buildOrderMessage,
  buildNewOrderPayload,
  getInnerMessageKind,
  filterResponsesByRequestId,
  type OrderKind,
} from "../lib/protocol.js";
import { getOrCreateKeys } from "../lib/keys.js";
import { checkLimits, auditLog, recordTrade, fetchBtcPrice } from "../lib/safety.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      opts[args[i].slice(2).replace(/-/g, "_")] = args[++i];
    }
  }

  if (!opts.kind || !opts.currency || !opts.fiat_amount || !opts.payment_method) {
    console.error(
      "Usage: create-order.ts --kind buy|sell --currency USD --fiat-amount 50 --payment-method 'bank transfer' [--premium 2] [--amount 0] [--min-amount 10] [--max-amount 100] [--invoice user@ln.tips]"
    );
    process.exit(1);
  }

  return {
    kind: opts.kind as OrderKind,
    currency: opts.currency,
    fiat_amount: parseInt(opts.fiat_amount, 10),
    payment_method: opts.payment_method,
    premium: parseInt(opts.premium ?? "0", 10),
    amount: parseInt(opts.amount ?? "0", 10),
    min_amount: opts.min_amount ? parseInt(opts.min_amount, 10) : undefined,
    max_amount: opts.max_amount ? parseInt(opts.max_amount, 10) : undefined,
    invoice: opts.invoice,
  };
}

async function main() {
  const opts = parseArgs();
  const config = loadConfig();
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error("❌ Configuration errors:\n" + errors.map((e) => `  - ${e}`).join("\n"));
    process.exit(1);
  }

  // Estimate sats from fiat for limit checking
  const btcPrice = await fetchBtcPrice(opts.currency, config.price_api);
  let estimatedSats = 0;
  if (btcPrice && btcPrice > 0) {
    // Convert fiat to BTC, then to sats
    estimatedSats = Math.round((opts.fiat_amount / btcPrice) * 1e8);
  } else {
    // If we can't get price, use a conservative estimate (assume $100k BTC)
    console.warn("⚠️  Could not fetch BTC price, using conservative estimate for limit check");
    estimatedSats = opts.fiat_amount * 1000; // ~1000 sats per dollar at $100k
  }

  // Safety checks (using sats)
  const limitCheck = checkLimits(config.limits, estimatedSats);
  if (!limitCheck.allowed) {
    console.error(`🚫 Trade blocked: ${limitCheck.reason}`);
    auditLog({
      timestamp: new Date().toISOString(),
      action: "create-order",
      fiat_amount: opts.fiat_amount,
      fiat_code: opts.currency,
      result: "rejected",
      details: limitCheck.reason,
    });
    process.exit(1);
  }

  const { keys, isNew } = getOrCreateKeys();
  if (isNew) {
    console.log("🔑 New keypair generated. Mnemonic saved to ~/.mostro-skill/seed");
    console.log("   ⚠️  Back up your mnemonic phrase!\n");
  }

  // Build order
  const isRange = opts.min_amount !== undefined && opts.max_amount !== undefined;
  const payload = buildNewOrderPayload({
    kind: opts.kind,
    fiat_code: opts.currency,
    fiat_amount: isRange ? 0 : opts.fiat_amount,
    amount: opts.amount,
    min_amount: opts.min_amount,
    max_amount: opts.max_amount,
    payment_method: opts.payment_method,
    premium: opts.premium,
    buyer_invoice: opts.invoice,
  });

  console.log(`📝 Creating ${opts.kind.toUpperCase()} order:`);
  console.log(`   ${isRange ? `${opts.min_amount}-${opts.max_amount}` : opts.fiat_amount} ${opts.currency}`);
  console.log(`   Payment: ${opts.payment_method}`);
  if (opts.premium !== 0) console.log(`   Premium: ${opts.premium}%`);
  if (opts.amount > 0) console.log(`   Amount: ${opts.amount} sats`);
  if (opts.invoice) console.log(`   Invoice: ${opts.invoice}`);
  console.log("");

  // TODO: In confirmation mode, ask user for approval here
  if (config.limits.require_confirmation) {
    console.log("⚠️  Confirmation mode is ON. In production, the agent would ask for approval here.");
  }

  const tradeKeys = keys.getTradeKeys(1); // TODO: track trade index properly
  const requestId = Math.floor(Math.random() * 2 ** 48);

  const message = buildOrderMessage(
    "new-order",
    undefined,
    requestId,
    1,
    payload
  );

  const client = createClient(config, keys);

  try {
    console.log("📤 Sending order to Mostro...");
    await sendGiftWrap(
      client,
      message,
      null, // TODO: sign with trade key for reputation mode
      tradeKeys.privateKey
    );

    console.log("⏳ Waiting for confirmation...\n");
    await new Promise((r) => setTimeout(r, 8000));

    const responses = await fetchGiftWraps(client, tradeKeys.privateKey, 5);

    if (responses.length === 0) {
      console.log("📭 No response yet. The order may still be processing.");
      auditLog({
        timestamp: new Date().toISOString(),
        action: "create-order",
        fiat_amount: opts.fiat_amount,
        fiat_code: opts.currency,
        result: "pending",
      });
      return;
    }

    const filtered = filterResponsesByRequestId(responses, requestId);

    for (const resp of filtered) {
      const kind = getInnerMessageKind(resp.message);
      if (kind.action === "new-order") {
        const payload = kind.payload as any;
        const order = payload?.order;
        console.log("✅ Order created!");
        console.log(`   ID: ${order?.id ?? kind.id}`);
        console.log(`   Kind: ${order?.kind}`);
        console.log(`   Status: ${order?.status}`);
        console.log(`   Amount: ${order?.fiat_amount} ${order?.fiat_code}`);

        // Use actual sats from order response, or estimate (market-price orders have amount=0)
        const actualSats = order?.amount || estimatedSats;
        recordTrade(actualSats);
        auditLog({
          timestamp: new Date().toISOString(),
          action: "create-order",
          order_id: order?.id ?? kind.id,
          fiat_amount: opts.fiat_amount,
          fiat_code: opts.currency,
          result: "success",
          details: `${actualSats} sats`,
        });
      } else if (kind.action === "cant-do") {
        console.error(`❌ Mostro rejected the order: ${JSON.stringify(kind.payload)}`);
        auditLog({
          timestamp: new Date().toISOString(),
          action: "create-order",
          fiat_amount: opts.fiat_amount,
          fiat_code: opts.currency,
          result: "failed",
          details: JSON.stringify(kind.payload),
        });
      } else {
        console.log(`📨 Response: ${kind.action}`);
        if (kind.payload) console.log(JSON.stringify(kind.payload, null, 2));
      }
    }
  } finally {
    closeClient(client);
  }
}

main().catch((e) => {
  console.error("❌ Error:", e.message);
  process.exit(1);
});
