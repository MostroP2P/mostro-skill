#!/usr/bin/env tsx
/**
 * Trade Status — Check the status of own orders/trades
 *
 * Usage:
 *   tsx scripts/trade-status.ts --order-id <uuid>
 *   tsx scripts/trade-status.ts --all          # List all own active orders
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
  buildRestoreMessage,
  getInnerMessageKind,
  filterResponsesByRequestId,
  type Message,
} from "../lib/protocol.js";
import { getOrCreateKeys } from "../lib/keys.js";

function parseArgs(): { orderId?: string; all?: boolean } {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--all") {
      return { all: true };
    }
    if (args[i].startsWith("--") && i + 1 < args.length) {
      opts[args[i].slice(2).replace(/-/g, "_")] = args[++i];
    }
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

  if (!opts.orderId && !opts.all) {
    console.error("Usage: trade-status.ts --order-id <uuid> | --all");
    process.exit(1);
  }

  const { keys, isNew } = getOrCreateKeys();
  if (isNew) {
    console.log("🔑 New keypair generated. Mnemonic saved to ~/.mostro-skill/seed");
    console.log("   ⚠️  Back up your mnemonic phrase!\n");
  }

  const client = createClient(config, keys);
  const tradeKeys = keys.getTradeKeys(1);

  try {
    if (opts.all) {
      // Restore session to get all active orders
      console.log("🔍 Fetching all active orders...\n");
      const requestId = Math.floor(Math.random() * 2 ** 48);
      const message = buildRestoreMessage("restore-session");
      await sendGiftWrap(client, message, null, tradeKeys.privateKey);

      // Wait for response
      await new Promise((r) => setTimeout(r, 5000));

      const responses = await fetchGiftWraps(client, tradeKeys.privateKey);
      const filtered = filterResponsesByRequestId(responses, requestId);

      if (filtered.length === 0) {
        console.log("📭 No active orders found.");
        return;
      }

      for (const resp of filtered) {
        const kind = getInnerMessageKind(resp.message);
        if (kind.action === "restore-session" && kind.payload) {
          const payload = kind.payload as any;
          if (payload.restore_data) {
            const data = payload.restore_data;
            if (data.orders?.length > 0) {
              console.log(`📋 Active orders (${data.orders.length}):`);
              for (const o of data.orders) {
                console.log(`  • ${o.id} — status: ${o.status} (trade index: ${o.trade_index})`);
              }
            }
            if (data.disputes?.length > 0) {
              console.log(`\n⚠️  Active disputes (${data.disputes.length}):`);
              for (const d of data.disputes) {
                console.log(`  • Dispute ${d.dispute_id} — order: ${d.order_id}, status: ${d.status}`);
              }
            }
          }
        }
      }
    } else if (opts.orderId) {
      // Query specific order by ID
      console.log(`🔍 Fetching order ${opts.orderId}...\n`);
      const requestId = Math.floor(Math.random() * 2 ** 48);
      const message = buildOrderMessage("orders", undefined, requestId, undefined, {
        ids: [opts.orderId],
      });
      await sendGiftWrap(client, message, null, tradeKeys.privateKey);

      // Wait for response
      await new Promise((r) => setTimeout(r, 5000));

      const responses = await fetchGiftWraps(client, tradeKeys.privateKey);
      const filtered = filterResponsesByRequestId(responses, requestId);

      if (filtered.length === 0) {
        console.log("📭 No response received. Order may not exist or not belong to you.");
        return;
      }

      for (const resp of filtered) {
        const kind = getInnerMessageKind(resp.message);
        console.log(`Action: ${kind.action}`);
        if (kind.payload) {
          console.log(JSON.stringify(kind.payload, null, 2));
        }
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
