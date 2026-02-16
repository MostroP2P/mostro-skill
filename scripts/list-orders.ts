#!/usr/bin/env tsx
/**
 * List Orders — Query the Mostro order book
 *
 * Usage:
 *   tsx scripts/list-orders.ts [--currency USD] [--kind buy|sell] [--status pending] [--limit 50]
 */

import { loadConfig, validateConfig } from "../lib/config.js";
import { createClient, closeClient, fetchOrderEvents } from "../lib/nostr.js";
import { parseOrderEvent, type ParsedOrderEvent } from "../lib/protocol.js";

function parseArgs(): {
  currency?: string;
  kind?: string;
  status?: string;
  limit?: number;
} {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      opts[args[i].slice(2)] = args[++i];
    }
  }
  return {
    currency: opts.currency,
    kind: opts.kind,
    status: opts.status ?? "pending",
    limit: opts.limit ? parseInt(opts.limit, 10) : 50,
  };
}

function formatOrder(order: ParsedOrderEvent): string {
  const amount =
    order.amount > 0 ? `${order.amount} sats` : "market price";
  const fiat =
    order.fiat_amount.includes("-") || order.fiat_amount.includes(",")
      ? `${order.fiat_amount} ${order.currency}`
      : `${order.fiat_amount} ${order.currency}`;
  const premium = order.premium !== 0 ? ` (${order.premium}% premium)` : "";
  const methods = order.payment_methods.join(", ");
  const rating = order.rating
    ? (() => {
        try {
          const r = JSON.parse(order.rating);
          return ` ⭐ ${r.total_rating ?? r.last_rating ?? "?"}`;
        } catch {
          return "";
        }
      })()
    : "";

  return [
    `📋 ${order.id}`,
    `   ${order.kind.toUpperCase()} ${fiat}${premium} — ${amount}`,
    `   💳 ${methods}${rating}`,
    `   📊 Status: ${order.status} | ${order.network}/${order.layer}`,
  ].join("\n");
}

async function main() {
  const opts = parseArgs();
  const config = loadConfig();
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error("❌ Configuration errors:\n" + errors.map((e) => `  - ${e}`).join("\n"));
    process.exit(1);
  }

  console.log(
    `🔍 Fetching ${opts.status ?? "pending"} orders from Mostro...`
  );
  console.log(`   Relays: ${config.relays.join(", ")}`);
  if (opts.currency) console.log(`   Currency: ${opts.currency}`);
  if (opts.kind) console.log(`   Type: ${opts.kind}`);
  console.log("");

  const client = createClient(config);

  try {
    const events = await fetchOrderEvents(client, {
      status: opts.status,
      kind: opts.kind,
      currency: opts.currency,
      limit: opts.limit,
    });

    if (events.length === 0) {
      console.log("📭 No orders found matching your criteria.");
      return;
    }

    const orders = events
      .map((e) => parseOrderEvent(e.tags))
      .sort((a, b) => {
        // Sort by fiat amount descending
        const aAmt = parseFloat(a.fiat_amount) || 0;
        const bAmt = parseFloat(b.fiat_amount) || 0;
        return bAmt - aAmt;
      });

    console.log(`📊 Found ${orders.length} orders:\n`);
    for (const order of orders) {
      console.log(formatOrder(order));
      console.log("");
    }

    // Summary
    const currencies = [...new Set(orders.map((o) => o.currency))];
    const buyCount = orders.filter((o) => o.kind === "buy").length;
    const sellCount = orders.filter((o) => o.kind === "sell").length;
    console.log(
      `📈 Summary: ${buyCount} buy, ${sellCount} sell | Currencies: ${currencies.join(", ")}`
    );
  } finally {
    closeClient(client);
  }
}

main().catch((e) => {
  console.error("❌ Error:", e.message);
  process.exit(1);
});
