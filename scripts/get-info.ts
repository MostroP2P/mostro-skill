#!/usr/bin/env tsx
/**
 * Get Mostro Info — Query Mostro instance status and configuration
 *
 * Usage:
 *   tsx scripts/get-info.ts
 */

import { loadConfig, validateConfig } from "../lib/config.js";
import { createClient, closeClient, fetchMostroInfo } from "../lib/nostr.js";
import { parseMostroInfoEvent } from "../lib/protocol.js";

async function main() {
  const config = loadConfig();
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error("❌ Configuration errors:\n" + errors.map((e) => `  - ${e}`).join("\n"));
    process.exit(1);
  }

  console.log("🔍 Fetching Mostro instance info...");
  console.log(`   Pubkey: ${config.mostro_pubkey}`);
  console.log(`   Relays: ${config.relays.join(", ")}\n`);

  const client = createClient(config);

  try {
    const event = await fetchMostroInfo(client);
    if (!event) {
      console.log("📭 No Mostro info event found. The instance may be offline or the pubkey may be wrong.");
      return;
    }

    const info = parseMostroInfoEvent(event.pubkey, event.tags);

    console.log("🧌 Mostro Instance Info");
    console.log("═══════════════════════════════════════");
    console.log(`  Version:          ${info.version}`);
    console.log(`  Commit:           ${info.commit_hash.slice(0, 8)}`);
    console.log(`  Fee:              ${(info.fee * 100).toFixed(2)}%`);
    console.log(`  Min order:        ${info.min_order_amount} sats`);
    console.log(`  Max order:        ${info.max_order_amount} sats`);
    console.log(`  Expiration:       ${info.expiration_hours}h (${info.expiration_seconds}s active)`);
    console.log(`  PoW required:     ${info.pow}`);
    console.log(`  Currencies:       ${info.fiat_currencies.join(", ")}`);
    if (info.max_orders_per_response) {
      console.log(`  Max orders/resp:  ${info.max_orders_per_response}`);
    }
    console.log(`  Network:          ${config.network}`);
  } finally {
    closeClient(client);
  }
}

main().catch((e) => {
  console.error("❌ Error:", e.message);
  process.exit(1);
});
