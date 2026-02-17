#!/usr/bin/env tsx
import { loadConfig } from "../lib/config.js";
import { createClient, closeClient, fetchGiftWraps } from "../lib/nostr.js";
import { getOrCreateKeys } from "../lib/keys.js";
import { getInnerMessageKind } from "../lib/protocol.js";

async function main() {
  const config = loadConfig();
  const { keys } = getOrCreateKeys();
  const client = createClient(config, keys);
  const tradeKeys = keys.getTradeKeys(1);
  const orderId = "0c8d56ac-799c-4504-bdfb-661585532e11";

  const responses = await fetchGiftWraps(client, tradeKeys.privateKey);
  
  // Show only messages for our order, sorted by time
  const orderMsgs = responses
    .filter(r => {
      const k = getInnerMessageKind(r.message);
      return k.id === orderId || (k.payload as any)?.order?.id === orderId;
    })
    .sort((a, b) => a.timestamp - b.timestamp);

  for (const r of orderMsgs) {
    const kind = getInnerMessageKind(r.message);
    const date = new Date(r.timestamp * 1000).toISOString();
    console.log(`\n[${date}] ACTION: ${kind.action}`);
    if (kind.payload) {
      console.log(JSON.stringify(kind.payload, null, 2));
    }
  }
  closeClient(client);
}
main().catch(e => { console.error(e); process.exit(1); });
