#!/usr/bin/env tsx
/**
 * Fiat Sent — Buyer confirms fiat payment was sent
 *
 * Usage:
 *   tsx scripts/fiat-sent.ts --order-id <uuid>
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
  if (!opts.order_id) {
    console.error("Usage: fiat-sent.ts --order-id <uuid>");
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

  console.log(`💸 Confirming fiat sent for order: ${opts.orderId}\n`);

  const message = buildOrderMessage("fiat-sent", opts.orderId, requestId);
  const client = createClient(config, keys);

  try {
    await sendGiftWrap(client, message, null, tradeKeys.privateKey);

    console.log("⏳ Waiting for confirmation...\n");
    await new Promise((r) => setTimeout(r, 5000));

    const responses = await fetchGiftWraps(client, tradeKeys.privateKey, 5);

    const filtered = filterResponsesByRequestId(responses, requestId);
    for (const resp of filtered) {
      const kind = getInnerMessageKind(resp.message);
      switch (kind.action) {
        case "fiat-sent-ok":
          console.log("✅ Fiat sent confirmed. Waiting for seller to release sats.");
          const payload = kind.payload as any;
          if (payload?.peer?.pubkey) {
            console.log(`   Counterparty pubkey: ${payload.peer.pubkey.slice(0, 16)}...`);
          }
          break;
        case "cant-do":
          console.error(`❌ Cannot confirm: ${JSON.stringify(kind.payload)}`);
          break;
        default:
          console.log(`📨 Response: ${kind.action}`);
      }

      auditLog({
        timestamp: new Date().toISOString(),
        action: "fiat-sent",
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
