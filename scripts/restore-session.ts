#!/usr/bin/env tsx
/**
 * Restore Session — Import a mnemonic and restore active orders/disputes from Mostro
 *
 * Usage:
 *   tsx scripts/restore-session.ts --mnemonic "word1 word2 ... word12"
 *   tsx scripts/restore-session.ts                  # restore using existing seed
 */

import { loadConfig, validateConfig } from "../lib/config.js";
import { createClient, closeClient, sendGiftWrap, fetchGiftWraps } from "../lib/nostr.js";
import { buildRestoreMessage, getInnerMessageKind, type RestoreData } from "../lib/protocol.js";
import { getOrCreateKeys, importMnemonic, keysFromMnemonic, loadMnemonic, setTradeIndex } from "../lib/keys.js";
import { auditLog } from "../lib/safety.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      opts[args[i].slice(2).replace(/-/g, "_")] = args[++i];
    }
  }
  return { mnemonic: opts.mnemonic };
}

async function main() {
  const opts = parseArgs();
  const config = loadConfig();
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error("❌ Configuration errors:\n" + errors.map((e) => `  - ${e}`).join("\n"));
    process.exit(1);
  }

  // Import mnemonic if provided, otherwise use existing
  let keys;
  if (opts.mnemonic) {
    console.log("🔑 Importing mnemonic...");
    keys = importMnemonic(opts.mnemonic);
    console.log("✅ Mnemonic imported and saved.\n");
  } else {
    const result = getOrCreateKeys();
    keys = result.keys;
    if (result.isNew) {
      console.log("🔑 New keypair generated. Mnemonic saved to ~/.mostro-skill/seed\n");
    }
  }

  console.log(`🆔 Identity pubkey: ${keys.identityPublicKey}`);
  console.log("");

  const client = createClient(config, keys);
  const tradeKeys = keys.getTradeKeys(1);

  try {
    // Step 1: Get last trade index
    console.log("📡 Requesting last trade index from Mostro...");
    const indexMsg = buildRestoreMessage("last-trade-index");
    const requestId = Math.floor(Math.random() * 2 ** 48);
    await sendGiftWrap(client, indexMsg, null, tradeKeys.privateKey);

    await new Promise((r) => setTimeout(r, 5000));
    let responses = await fetchGiftWraps(client, tradeKeys.privateKey, 5);

    let lastIndex = 0;
    for (const resp of responses) {
      const kind = getInnerMessageKind(resp.message);
      if (kind.action === "last-trade-index" && kind.trade_index !== undefined) {
        lastIndex = kind.trade_index;
        console.log(`   Last trade index: ${lastIndex}`);
      }
    }

    // Update local trade index to be one beyond the last
    if (lastIndex > 0) {
      setTradeIndex(lastIndex + 1);
      console.log(`   Local trade index set to: ${lastIndex + 1}\n`);
    }

    // Step 2: Restore session (get active orders and disputes)
    console.log("📡 Requesting session restore from Mostro...");
    const restoreMsg = buildRestoreMessage("restore-session");
    await sendGiftWrap(client, restoreMsg, null, tradeKeys.privateKey);

    await new Promise((r) => setTimeout(r, 8000));
    responses = await fetchGiftWraps(client, tradeKeys.privateKey, 10);

    let restored = false;
    for (const resp of responses) {
      const kind = getInnerMessageKind(resp.message);
      if (kind.action === "restore-session" && kind.payload) {
        restored = true;
        const data = (kind.payload as any)?.restore_data as RestoreData | undefined;
        if (data) {
          console.log("\n📋 Restored session data:");
          if (data.orders.length > 0) {
            console.log(`\n   Active orders (${data.orders.length}):`);
            for (const order of data.orders) {
              console.log(`     - ${order.id} [${order.status}] (trade index: ${order.trade_index})`);
            }
          } else {
            console.log("   No active orders.");
          }

          if (data.disputes.length > 0) {
            console.log(`\n   Active disputes (${data.disputes.length}):`);
            for (const dispute of data.disputes) {
              console.log(`     - Dispute ${dispute.dispute_id} → Order ${dispute.order_id} [${dispute.status}]`);
            }
          } else {
            console.log("   No active disputes.");
          }
        }
      } else if (kind.action === "cant-do") {
        console.error(`❌ Restore failed: ${JSON.stringify(kind.payload)}`);
      }
    }

    if (!restored && responses.length === 0) {
      console.log("📭 No response from Mostro. Session may be clean (no active trades).");
    }

    auditLog({
      timestamp: new Date().toISOString(),
      action: "restore-session",
      result: "success",
      details: `last_index=${lastIndex}`,
    });

    console.log("\n✅ Session restore complete.");
  } finally {
    closeClient(client);
  }
}

main().catch((e) => {
  console.error("❌ Error:", e.message);
  process.exit(1);
});
