#!/usr/bin/env tsx
/**
 * Take Order — Take an existing buy or sell order on Mostro
 *
 * Usage:
 *   tsx scripts/take-order.ts --order-id <uuid> --action take-sell [--invoice lnbc...] [--amount 15]
 *   tsx scripts/take-order.ts --order-id <uuid> --action take-buy [--amount 15]
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
  getInnerMessageKind,
  filterResponsesByRequestId,
  type Action,
  type Payload,
} from "../lib/protocol.js";
import { getOrCreateKeys } from "../lib/keys.js";
import { checkLimits, auditLog, recordTrade } from "../lib/safety.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      opts[args[i].slice(2).replace(/-/g, "_")] = args[++i];
    }
  }

  if (!opts.order_id || !opts.action) {
    console.error(
      "Usage: take-order.ts --order-id <uuid> --action take-sell|take-buy [--invoice lnbc...] [--amount 15]"
    );
    process.exit(1);
  }

  return {
    orderId: opts.order_id,
    action: opts.action as "take-sell" | "take-buy",
    invoice: opts.invoice,
    amount: opts.amount ? parseInt(opts.amount, 10) : undefined,
  };
}

function buildTakePayload(
  action: "take-sell" | "take-buy",
  invoice?: string,
  amount?: number
): Payload | null {
  if (action === "take-buy") {
    // Seller takes a buy order — may specify fiat amount for range orders
    return amount ? { amount } : null;
  }

  // Buyer takes a sell order
  if (invoice) {
    // With invoice or LN address
    return {
      payment_request: [null, invoice, amount ?? null],
    };
  }

  // Without invoice — Mostro will ask for one
  return amount ? { amount } : null;
}

async function main() {
  const opts = parseArgs();
  const config = loadConfig();
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error("❌ Configuration errors:\n" + errors.map((e) => `  - ${e}`).join("\n"));
    process.exit(1);
  }

  const { keys, isNew } = getOrCreateKeys();
  if (isNew) {
    console.log("🔑 New keypair generated. Mnemonic saved to ~/.mostro-skill/seed\n");
  }

  const tradeKeys = keys.getTradeKeys(1); // TODO: proper trade index tracking
  const requestId = Math.floor(Math.random() * 2 ** 48);
  const payload = buildTakePayload(opts.action, opts.invoice, opts.amount);

  console.log(`🛒 Taking order: ${opts.orderId}`);
  console.log(`   Action: ${opts.action}`);
  if (opts.invoice) console.log(`   Invoice/Address: ${opts.invoice}`);
  if (opts.amount) console.log(`   Fiat amount: ${opts.amount}`);
  console.log("");

  if (config.limits.require_confirmation) {
    console.log("⚠️  Confirmation mode is ON. In production, the agent would ask for approval here.");
  }

  const message = buildOrderMessage(
    opts.action as Action,
    opts.orderId,
    requestId,
    1,
    payload
  );

  const client = createClient(config, keys);

  try {
    console.log("📤 Sending take order to Mostro...");
    await sendGiftWrap(
      client,
      message,
      null, // TODO: sign for reputation
      tradeKeys.privateKey
    );

    console.log("⏳ Waiting for response...\n");
    await new Promise((r) => setTimeout(r, 8000));

    const responses = await fetchGiftWraps(client, tradeKeys.privateKey, 5);

    if (responses.length === 0) {
      console.log("📭 No response yet. The order may still be processing.");
      return;
    }

    const filtered = filterResponsesByRequestId(responses, requestId);
    for (const resp of filtered) {
      const kind = getInnerMessageKind(resp.message);

      switch (kind.action) {
        case "pay-invoice": {
          const payload = kind.payload as any;
          const pr = payload?.payment_request;
          if (pr) {
            const order = pr[0];
            const invoice = pr[1];
            console.log("⚡ Mostro asks you to pay a hold invoice:");
            console.log(`   Order: ${order?.id}`);
            console.log(`   Amount: ${order?.amount} sats`);
            console.log(`   Fiat: ${order?.fiat_amount} ${order?.fiat_code}`);
            console.log(`\n   Invoice: ${invoice}\n`);
            console.log("   Pay this invoice to proceed with the trade.");
          }
          break;
        }
        case "add-invoice": {
          const payload = kind.payload as any;
          const order = payload?.order;
          console.log("📥 Mostro needs a Lightning invoice:");
          console.log(`   Amount: ${order?.amount} sats`);
          console.log(`   For: ${order?.fiat_amount} ${order?.fiat_code}`);
          console.log("\n   Send an add-invoice message to continue.");
          break;
        }
        case "waiting-seller-to-pay":
          console.log("⏳ Waiting for seller to pay the hold invoice...");
          break;
        case "cant-do":
          console.error(`❌ Mostro rejected: ${JSON.stringify(kind.payload)}`);
          break;
        default:
          console.log(`📨 Response: ${kind.action}`);
          if (kind.payload) console.log(JSON.stringify(kind.payload, null, 2));
      }

      auditLog({
        timestamp: new Date().toISOString(),
        action: opts.action,
        order_id: opts.orderId,
        result: kind.action === "cant-do" ? "failed" : "success",
        details: kind.action,
      });
    }
  } finally {
    closeClient(client);
  }
}

main().catch((e) => {
  console.error("❌ Error:", e.message);
  process.exit(1);
});
