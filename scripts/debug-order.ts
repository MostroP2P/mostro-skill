#!/usr/bin/env tsx
/**
 * Debug: Create order and inspect full gift wrap flow
 */

import { loadConfig } from "../lib/config.js";
import { createClient, closeClient, sendGiftWrap, fetchGiftWraps } from "../lib/nostr.js";
import { buildOrderMessage, buildNewOrderPayload } from "../lib/protocol.js";
import { getOrCreateKeys } from "../lib/keys.js";
import { getPublicKey } from "nostr-tools";
import { hexToBytes } from "@noble/hashes/utils";

async function main() {
  const config = loadConfig();
  const { keys } = getOrCreateKeys();
  const tradeKeys = keys.getTradeKeys(1);
  const tradeBytes = hexToBytes(tradeKeys.privateKey);
  const tradePub = getPublicKey(tradeBytes);

  console.log("🔑 Identity pubkey:", keys.identityPublicKey);
  console.log("🔑 Trade pubkey:", tradePub);
  console.log("📡 Relays:", config.relays.join(", "));

  const client = createClient(config, keys);

  const payload = buildNewOrderPayload({
    kind: "sell",
    fiat_code: "ARS",
    fiat_amount: 5555,
    payment_method: "Mostro",
    premium: 0,
  });

  const requestId = Math.floor(Math.random() * 2 ** 48);
  const message = buildOrderMessage("new-order", undefined, requestId, 1, payload);

  console.log("\n📤 Message:", JSON.stringify(message, null, 2));
  console.log("\n📤 Sending gift wrap to Mostro...");

  try {
    await sendGiftWrap(client, message, null, tradeKeys.privateKey);
    console.log("✅ Gift wrap published to relays");
  } catch (e: any) {
    console.error("❌ Failed to publish:", e.message);
    closeClient(client);
    return;
  }

  // Wait and poll multiple times
  for (const waitSec of [5, 10, 15]) {
    console.log(`\n⏳ Waiting ${waitSec}s total...`);
    await new Promise(r => setTimeout(r, waitSec * 1000));

    console.log("🔍 Checking trade key responses...");
    const wraps = await fetchGiftWraps(client, tradeKeys.privateKey, 5);
    console.log(`   Found: ${wraps.length} messages`);
    for (const w of wraps) {
      console.log("   📨", JSON.stringify(w.message));
    }

    console.log("🔍 Checking identity key responses...");
    const wraps2 = await fetchGiftWraps(client, keys.identityPrivateKey, 5);
    console.log(`   Found: ${wraps2.length} messages`);
    for (const w of wraps2) {
      console.log("   📨", JSON.stringify(w.message));
    }

    if (wraps.length > 0 || wraps2.length > 0) break;
  }

  closeClient(client);
}

main().catch(e => console.error("❌ Error:", e));
