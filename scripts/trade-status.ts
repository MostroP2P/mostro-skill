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
  type RestoreData,
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
      const message = buildRestoreMessage("restore-session", undefined, requestId);
      await sendGiftWrap(client, message, null, tradeKeys.privateKey);

      // Wait for response
      await new Promise((r) => setTimeout(r, 5000));

      const responses = await fetchGiftWraps(client, tradeKeys.privateKey);
      // Try filtering by request_id first; fall back to most recent restore response
      let filtered = filterResponsesByRequestId(responses, requestId);
      if (filtered.length === 0) {
        // Mostro may not echo request_id — take only the most recent restore response
        // to avoid showing stale data from previous sessions
        const restoreResponses = responses
          .filter((r) => {
            const k = getInnerMessageKind(r.message);
            return k.action === "restore-session";
          })
          .sort((a, b) => b.timestamp - a.timestamp);
        if (restoreResponses.length > 0) {
          const age = Math.floor(Date.now() / 1000) - restoreResponses[0].timestamp;
          if (age > 30) {
            console.warn(`⚠️  No request_id match — showing most recent restore response (${age}s old, may be from a previous session)\n`);
          }
          filtered = [restoreResponses[0]];
        }
      }

      if (filtered.length === 0) {
        console.log("📭 No active orders found.");
        return;
      }

      let foundOrders = false;
      for (const resp of filtered) {
        const kind = getInnerMessageKind(resp.message);
        if (kind.action === "restore-session" && kind.payload) {
          const payload = kind.payload as { restore_data?: RestoreData };
          if (payload.restore_data) {
            const data = payload.restore_data;
            if (data.orders?.length > 0) {
              foundOrders = true;
              console.log(`📋 Active orders (${data.orders.length}):`);
              for (const o of data.orders) {
                const id = o.id ?? o.order_id ?? "unknown";
                console.log(`  • ${id} — status: ${o.status} (trade index: ${o.trade_index})`);
              }
            }
            if (data.disputes?.length > 0) {
              foundOrders = true;
              console.log(`\n⚠️  Active disputes (${data.disputes.length}):`);
              for (const d of data.disputes) {
                console.log(`  • Dispute ${d.dispute_id} — order: ${d.order_id}, status: ${d.status}`);
              }
            }
          }
        }
      }
      if (!foundOrders) {
        console.log("📭 No active orders found.");
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
      // Try filtering by request_id; fall back to most recent order-related response
      let filtered = filterResponsesByRequestId(responses, requestId);
      if (filtered.length === 0) {
        const orderResponses = responses
          .filter((r) => {
            const k = getInnerMessageKind(r.message);
            return k.action === "orders" || k.id === opts.orderId;
          })
          .sort((a, b) => b.timestamp - a.timestamp);
        if (orderResponses.length > 0) {
          filtered = [orderResponses[0]];
        }
      }

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
