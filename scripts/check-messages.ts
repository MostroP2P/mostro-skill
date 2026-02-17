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

  const responses = await fetchGiftWraps(client, tradeKeys.privateKey);
  console.log(`Total messages: ${responses.length}\n`);

  for (const r of responses.sort((a, b) => a.timestamp - b.timestamp)) {
    const kind = getInnerMessageKind(r.message);
    const date = new Date(r.timestamp * 1000).toISOString();
    console.log(`[${date}] ${kind.action} | id: ${kind.id ?? "-"}`);
    if (kind.payload) {
      const p = kind.payload as any;
      if (p.order) console.log(`  status: ${p.order.status}, amount: ${p.order.fiat_amount} ${p.order.fiat_code}, sats: ${p.order.amount}`);
      if (p.peer) console.log(`  peer: ${p.peer.pubkey?.slice(0, 16)}...`);
      if (p.payment_request) console.log(`  payment_request: ${JSON.stringify(p.payment_request).slice(0, 200)}`);
      if (p.text_message) console.log(`  message: ${p.text_message}`);
    }
  }
  closeClient(client);
}
main().catch(e => { console.error(e); process.exit(1); });
