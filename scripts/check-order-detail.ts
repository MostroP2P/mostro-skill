#!/usr/bin/env tsx
import { loadConfig } from "../lib/config.js";
import { createClient, closeClient, fetchGiftWraps } from "../lib/nostr.js";
import { getOrCreateKeys } from "../lib/keys.js";
import { getInnerMessageKind } from "../lib/protocol.js";

async function main() {
  const orderId = process.argv[2];
  if (!orderId) {
    console.error("Usage: check-order-detail.ts <order-id>");
    process.exit(1);
  }

  const config = loadConfig();
  const { keys } = getOrCreateKeys();
  const client = createClient(config, keys);
  const tradeKeys = keys.getTradeKeys(1);

  const responses = await fetchGiftWraps(client, tradeKeys.privateKey);

  // Compute kind once per response, filter, and sort
  const orderMsgs = responses
    .map(r => ({ msg: r, kind: getInnerMessageKind(r.message) }))
    .filter(({ kind }) => kind.id === orderId || (kind.payload as Record<string, any>)?.order?.id === orderId)
    .sort((a, b) => a.msg.timestamp - b.msg.timestamp);

  for (const { msg, kind } of orderMsgs) {
    const date = new Date(msg.timestamp * 1000).toISOString();
    console.log(`\n[${date}] ACTION: ${kind.action}`);
    if (kind.payload) {
      console.log(JSON.stringify(kind.payload, null, 2));
    }
  }
  closeClient(client);
}
main().catch(e => { console.error(e); process.exit(1); });
