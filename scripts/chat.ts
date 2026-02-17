#!/usr/bin/env tsx
/**
 * P2P Chat — Send and receive direct messages with trade counterparty
 *
 * Usage:
 *   tsx scripts/chat.ts --order-id <uuid> --message "Hello!"
 *   tsx scripts/chat.ts --order-id <uuid> --read
 *   tsx scripts/chat.ts --order-id <uuid> --read --message "Hello!"  (read + send)
 */

import { SimplePool } from "nostr-tools";
import { loadConfig, validateConfig } from "../lib/config.js";
import { createClient, closeClient, fetchGiftWraps, sendGiftWrap } from "../lib/nostr.js";
import { getOrCreateKeys } from "../lib/keys.js";
import { getInnerMessageKind, filterResponsesByRequestId, buildOrderMessage } from "../lib/protocol.js";
import {
  computeSharedKey,
  sendP2PMessage,
  fetchP2PMessages,
  type ChatMessage,
} from "../lib/p2p-chat.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  let read = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--read") {
      read = true;
    } else if (args[i].startsWith("--") && i + 1 < args.length) {
      opts[args[i].slice(2).replace(/-/g, "_")] = args[++i];
    }
  }

  if (!opts.order_id) {
    console.error(
      "Usage:\n" +
      "  chat.ts --order-id <uuid> --message \"Hello!\"\n" +
      "  chat.ts --order-id <uuid> --read\n" +
      "  chat.ts --order-id <uuid> --read --message \"Hello!\""
    );
    process.exit(1);
  }

  return {
    orderId: opts.order_id,
    message: opts.message,
    read,
  };
}

/**
 * Fetch the order details to get the peer's trade pubkey.
 */
/**
 * Poll interval and timeout for order queries (in ms).
 */
const ORDER_POLL_INTERVAL_MS = 2000;
const ORDER_POLL_TIMEOUT_MS = 15000;

async function getPeerTradePubkey(
  config: ReturnType<typeof loadConfig>,
  keys: ReturnType<typeof getOrCreateKeys>["keys"],
  orderId: string
): Promise<{ peerPubkey: string; ourRole: "buyer" | "seller" }> {
  const client = createClient(config, keys);
  const tradeKeys = keys.getTradeKeys(1);
  const requestId = Math.floor(Math.random() * 2 ** 48);

  const message = buildOrderMessage("orders", undefined, requestId, undefined, {
    ids: [orderId],
  });

  await sendGiftWrap(client, message, null, tradeKeys.privateKey);

  // Poll for response instead of arbitrary fixed delay
  const deadline = Date.now() + ORDER_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, ORDER_POLL_INTERVAL_MS));

    const responses = await fetchGiftWraps(client, tradeKeys.privateKey);
    const filtered = filterResponsesByRequestId(responses, requestId);

    for (const resp of filtered) {
      const kind = getInnerMessageKind(resp.message);
      if (kind.action === "orders" && kind.payload) {
        const payload = kind.payload as Record<string, unknown>;
        const orders = (payload.orders as Array<Record<string, string>>) ?? [];
        const order = orders.find((o) => o.id === orderId);
        if (order) {
          const ourPubkey = tradeKeys.publicKey;
          if (order.seller_trade_pubkey === ourPubkey) {
            if (!order.buyer_trade_pubkey) {
              throw new Error("Buyer trade pubkey not yet available — is the trade fully matched?");
            }
            closeClient(client);
            return { peerPubkey: order.buyer_trade_pubkey, ourRole: "seller" };
          } else {
            if (!order.seller_trade_pubkey) {
              throw new Error("Seller trade pubkey not yet available — is the trade fully matched?");
            }
            closeClient(client);
            return { peerPubkey: order.seller_trade_pubkey, ourRole: "buyer" };
          }
        }
      }
    }
  }

  closeClient(client);
  throw new Error("Could not find order or peer trade pubkey. Is the order active?");
}

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function displayMessages(messages: ChatMessage[], ourTradePubkey: string): void {
  if (messages.length === 0) {
    console.log("📭 No messages yet.");
    return;
  }

  console.log(`💬 Chat (${messages.length} messages):\n`);
  for (const msg of messages) {
    const isOurs = msg.senderPubkey === ourTradePubkey;
    const label = isOurs ? "You" : "Peer";
    const prefix = isOurs ? "→" : "←";
    console.log(`  ${prefix} [${formatTimestamp(msg.timestamp)}] ${label}: ${msg.content}`);
  }
}

async function main() {
  const opts = parseArgs();
  const config = loadConfig();
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error("❌ Configuration errors:\n" + errors.map((e) => `  - ${e}`).join("\n"));
    process.exit(1);
  }

  if (!opts.message && !opts.read) {
    console.error("❌ Specify --message, --read, or both.");
    process.exit(1);
  }

  const { keys } = getOrCreateKeys();
  const tradeKeys = keys.getTradeKeys(1);

  // Fetch order to get peer's trade pubkey
  console.log(`🔍 Fetching order ${opts.orderId}...`);
  const { peerPubkey, ourRole } = await getPeerTradePubkey(config, keys, opts.orderId);
  console.log(`   Role: ${ourRole}`);
  console.log(`   Peer: ${peerPubkey.slice(0, 16)}...`);

  // Compute shared ECDH key
  const sharedKey = computeSharedKey(tradeKeys.privateKey, peerPubkey);
  console.log(`   Shared key: ${sharedKey.publicKey.slice(0, 16)}...\n`);

  const pool = new SimplePool();

  try {
    // Read messages
    if (opts.read) {
      const messages = await fetchP2PMessages(pool, config.relays, sharedKey);
      displayMessages(messages, tradeKeys.publicKey);
      console.log("");
    }

    // Send message
    if (opts.message) {
      console.log(`📤 Sending: "${opts.message}"`);
      await sendP2PMessage(
        pool,
        config.relays,
        tradeKeys.privateKey,
        sharedKey,
        opts.message
      );
      console.log("✅ Message sent!");
    }
  } finally {
    pool.close(config.relays);
  }
}

main().catch((e) => {
  console.error("❌ Error:", e.message);
  process.exit(1);
});
