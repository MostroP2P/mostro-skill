#!/usr/bin/env tsx
/**
 * Add Invoice — Send a Lightning invoice to Mostro after taking a sell order
 *
 * When you take a sell order without providing an invoice, Mostro will ask
 * for one. Use this script to send the invoice.
 *
 * Usage:
 *   tsx scripts/add-invoice.ts --order-id <uuid> --invoice <lnbc...>
 */

import { loadConfig, validateConfig } from "../lib/config.js";
import { createClient, closeClient, sendGiftWrap, fetchGiftWraps } from "../lib/nostr.js";
import { buildOrderMessage, getInnerMessageKind, type Payload } from "../lib/protocol.js";
import { getOrCreateKeys } from "../lib/keys.js";
import { auditLog } from "../lib/safety.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      opts[args[i].slice(2).replace(/-/g, "_")] = args[++i];
    }
  }
  if (!opts.order_id || !opts.invoice) {
    console.error("Usage: add-invoice.ts --order-id <uuid> --invoice <lnbc...>");
    process.exit(1);
  }
  return { orderId: opts.order_id, invoice: opts.invoice };
}

async function main() {
  const opts = parseArgs();
  const config = loadConfig();
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error("❌ Configuration errors:\n" + errors.map((e) => `  - ${e}`).join("\n"));
    process.exit(1);
  }

  const { keys } = getOrCreateKeys();
  const tradeKeys = keys.getTradeKeys(1); // TODO: use tracked trade index for this order
  const requestId = Math.floor(Math.random() * 2 ** 48);

  console.log(`📥 Sending invoice for order: ${opts.orderId}`);
  console.log(`   Invoice: ${opts.invoice.slice(0, 40)}...`);
  console.log("");

  const payload: Payload = {
    payment_request: [null, opts.invoice, null],
  };

  const message = buildOrderMessage("add-invoice", opts.orderId, requestId, 1, payload);
  const client = createClient(config, keys);

  try {
    await sendGiftWrap(client, message, null, tradeKeys.privateKey);

    console.log("⏳ Waiting for confirmation...\n");
    await new Promise((r) => setTimeout(r, 5000));

    const responses = await fetchGiftWraps(client, tradeKeys.privateKey, 5);

    for (const resp of responses) {
      const kind = getInnerMessageKind(resp.message);
      switch (kind.action) {
        case "buyer-invoice-accepted":
          console.log("✅ Invoice accepted! Waiting for seller to pay hold invoice.");
          break;
        case "hold-invoice-payment-accepted":
          console.log("✅ Hold invoice paid! Trade is active.");
          break;
        case "cant-do":
          console.error(`❌ Rejected: ${JSON.stringify(kind.payload)}`);
          break;
        default:
          console.log(`📨 Response: ${kind.action}`);
          if (kind.payload) console.log(JSON.stringify(kind.payload, null, 2));
      }

      auditLog({
        timestamp: new Date().toISOString(),
        action: "add-invoice",
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
