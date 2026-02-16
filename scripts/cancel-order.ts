#!/usr/bin/env tsx
/**
 * Cancel Order — Cancel a pending order or initiate cooperative cancellation
 *
 * Usage:
 *   tsx scripts/cancel-order.ts --order-id <uuid>
 */

import { loadConfig, validateConfig } from "../lib/config.js";
import { createClient, closeClient, sendGiftWrap, fetchGiftWraps } from "../lib/nostr.js";
import { buildOrderMessage, getInnerMessageKind } from "../lib/protocol.js";
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
  if (!opts.order_id) {
    console.error("Usage: cancel-order.ts --order-id <uuid>");
    process.exit(1);
  }
  return { orderId: opts.order_id };
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
  const tradeKeys = keys.getTradeKeys(1); // TODO: proper trade index
  const requestId = Math.floor(Math.random() * 2 ** 48);

  console.log(`🚫 Canceling order: ${opts.orderId}\n`);

  const message = buildOrderMessage("cancel", opts.orderId, requestId);
  const client = createClient(config, keys);

  try {
    await sendGiftWrap(client, message, null, tradeKeys.privateKey, keys.identityPrivateKey);

    console.log("⏳ Waiting for confirmation...\n");
    await new Promise((r) => setTimeout(r, 5000));

    const responses = await fetchGiftWraps(client, tradeKeys.privateKey, 5);

    for (const resp of responses) {
      const kind = getInnerMessageKind(resp.message);
      switch (kind.action) {
        case "canceled":
          console.log("✅ Order canceled successfully.");
          break;
        case "cooperative-cancel-initiated-by-you":
          console.log("🤝 Cooperative cancellation initiated. Waiting for counterparty to agree.");
          break;
        case "cant-do":
          console.error(`❌ Cannot cancel: ${JSON.stringify(kind.payload)}`);
          break;
        default:
          console.log(`📨 Response: ${kind.action}`);
      }

      auditLog({
        timestamp: new Date().toISOString(),
        action: "cancel",
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
