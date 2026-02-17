#!/usr/bin/env tsx
/**
 * Rate User — Rate counterparty after a successful trade
 *
 * Usage:
 *   tsx scripts/rate-user.ts --order-id <uuid> --rating 5
 */

import { loadConfig, validateConfig } from "../lib/config.js";
import { createClient, closeClient, sendGiftWrap, fetchGiftWraps } from "../lib/nostr.js";
import { buildOrderMessage, getInnerMessageKind, filterResponsesByRequestId } from "../lib/protocol.js";
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
  if (!opts.order_id || !opts.rating) {
    console.error("Usage: rate-user.ts --order-id <uuid> --rating 1-5");
    process.exit(1);
  }
  const rating = parseInt(opts.rating, 10);
  if (rating < 1 || rating > 5) {
    console.error("❌ Rating must be between 1 and 5");
    process.exit(1);
  }
  return { orderId: opts.order_id, rating };
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

  console.log(`⭐ Rating counterparty ${opts.rating}/5 for order: ${opts.orderId}\n`);

  const message = buildOrderMessage("rate-user", opts.orderId, requestId, undefined, {
    rating_user: opts.rating,
  });
  const client = createClient(config, keys);

  try {
    await sendGiftWrap(client, message, null, tradeKeys.privateKey);

    console.log("⏳ Waiting for confirmation...\n");
    await new Promise((r) => setTimeout(r, 5000));

    const responses = await fetchGiftWraps(client, tradeKeys.privateKey, 5);

    const filtered = filterResponsesByRequestId(responses, requestId);
    for (const resp of filtered) {
      const kind = getInnerMessageKind(resp.message);
      if (kind.action === "rate-received") {
        console.log("✅ Rating submitted successfully!");
      } else if (kind.action === "cant-do") {
        console.error(`❌ Cannot rate: ${JSON.stringify(kind.payload)}`);
      } else {
        console.log(`📨 Response: ${kind.action}`);
      }

      auditLog({
        timestamp: new Date().toISOString(),
        action: "rate-user",
        order_id: opts.orderId,
        result: kind.action === "cant-do" ? "failed" : "success",
        details: `Rating: ${opts.rating}/5`,
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
