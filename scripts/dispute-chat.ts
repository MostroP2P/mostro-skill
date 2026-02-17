#!/usr/bin/env tsx
/**
 * Dispute Chat — Send messages in a dispute context via Mostro
 *
 * Uses the send-dm action through Mostro's relay to communicate
 * with the admin or counterparty during an active dispute.
 *
 * Usage:
 *   tsx scripts/dispute-chat.ts --order-id <uuid> --message "I sent the fiat, here is proof: ..."
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
  if (!opts.order_id || !opts.message) {
    console.error("Usage: dispute-chat.ts --order-id <uuid> --message <text>");
    process.exit(1);
  }
  return { orderId: opts.order_id, message: opts.message };
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

  console.log(`💬 Sending dispute message for order: ${opts.orderId}`);
  console.log(`   Message: ${opts.message}`);
  console.log("");

  const payload: Payload = { text_message: opts.message };
  const message = buildOrderMessage("send-dm", opts.orderId, requestId, 1, payload);
  const client = createClient(config, keys);

  try {
    await sendGiftWrap(client, message, null, tradeKeys.privateKey);

    console.log("⏳ Waiting for confirmation...\n");
    await new Promise((r) => setTimeout(r, 5000));

    const responses = await fetchGiftWraps(client, tradeKeys.privateKey, 5);

    if (responses.length === 0) {
      console.log("📤 Message sent. (No immediate response from Mostro)");
    }

    for (const resp of responses) {
      const kind = getInnerMessageKind(resp.message);
      switch (kind.action) {
        case "cant-do":
          console.error(`❌ Rejected: ${JSON.stringify(kind.payload)}`);
          break;
        default:
          console.log(`📨 Response: ${kind.action}`);
          if (kind.payload) console.log(JSON.stringify(kind.payload, null, 2));
      }

      auditLog({
        timestamp: new Date().toISOString(),
        action: "dispute-chat",
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
