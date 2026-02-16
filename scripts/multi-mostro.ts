#!/usr/bin/env tsx
/**
 * Multi-Mostro — Query multiple Mostro instances and compare orders
 *
 * Usage:
 *   tsx scripts/multi-mostro.ts --currency USD --kind sell           # Find best sell across all instances
 *   tsx scripts/multi-mostro.ts --currency USD --kind sell --best    # Show only the single best order
 *   tsx scripts/multi-mostro.ts --list-instances                     # List configured instances
 */

import { loadConfig } from "../lib/config.js";
import { createClient, closeClient, fetchOrderEvents } from "../lib/nostr.js";
import { parseOrderEvent, type ParsedOrderEvent } from "../lib/protocol.js";
import type { MostroConfig } from "../lib/config.js";

interface MostroInstance {
  name: string;
  pubkey: string;
  relays: string[];
}

interface RankedOrder extends ParsedOrderEvent {
  instance: string;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  let listInstances = false;
  let best = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--list-instances") {
      listInstances = true;
    } else if (args[i] === "--best") {
      best = true;
    } else if (args[i].startsWith("--") && i + 1 < args.length) {
      opts[args[i].slice(2).replace(/-/g, "_")] = args[++i];
    }
  }
  return {
    currency: opts.currency,
    kind: opts.kind as "buy" | "sell" | undefined,
    limit: opts.limit ? parseInt(opts.limit, 10) : 20,
    listInstances,
    best,
  };
}

function getInstances(config: MostroConfig): MostroInstance[] {
  const configAny = config as any;
  const instances: MostroInstance[] = [];

  // Always include the primary instance
  if (config.mostro_pubkey) {
    instances.push({
      name: "default",
      pubkey: config.mostro_pubkey,
      relays: config.relays,
    });
  }

  // Add additional instances from config
  if (Array.isArray(configAny.mostro_instances)) {
    for (const inst of configAny.mostro_instances) {
      if (inst.pubkey && inst.name) {
        instances.push({
          name: inst.name,
          pubkey: inst.pubkey,
          relays: inst.relays ?? config.relays,
        });
      }
    }
  }

  return instances;
}

async function fetchFromInstance(
  instance: MostroInstance,
  config: MostroConfig,
  opts: { currency?: string; kind?: string; limit: number }
): Promise<RankedOrder[]> {
  const instanceConfig: MostroConfig = {
    ...config,
    mostro_pubkey: instance.pubkey,
    relays: instance.relays,
  };

  const client = createClient(instanceConfig);

  try {
    const events = await fetchOrderEvents(client, {
      status: "pending",
      kind: opts.kind,
      currency: opts.currency,
      limit: opts.limit,
    });

    return events.map((e) => ({
      ...parseOrderEvent(e.tags),
      instance: instance.name,
    }));
  } finally {
    closeClient(client);
  }
}

async function main() {
  const opts = parseArgs();
  const config = loadConfig();
  const instances = getInstances(config);

  if (instances.length === 0) {
    console.error("❌ No Mostro instances configured.");
    console.error("   Set mostro_pubkey in config.json or add mostro_instances array.");
    process.exit(1);
  }

  if (opts.listInstances) {
    console.log(`📡 Configured Mostro instances (${instances.length}):\n`);
    for (const inst of instances) {
      console.log(`  ${inst.name}`);
      console.log(`    Pubkey: ${inst.pubkey.slice(0, 16)}...`);
      console.log(`    Relays: ${inst.relays.join(", ")}`);
      console.log("");
    }
    return;
  }

  if (!opts.currency) {
    console.error("Usage: multi-mostro.ts --currency USD --kind sell [--best]");
    process.exit(1);
  }

  console.log(`🔍 Querying ${instances.length} Mostro instance(s) for ${opts.kind ?? "all"} ${opts.currency} orders...\n`);

  // Query all instances in parallel
  const results = await Promise.allSettled(
    instances.map((inst) => fetchFromInstance(inst, config, opts))
  );

  const allOrders: RankedOrder[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      allOrders.push(...result.value);
      console.log(`  ✅ ${instances[i].name}: ${result.value.length} orders`);
    } else {
      console.log(`  ❌ ${instances[i].name}: ${result.reason?.message ?? "failed"}`);
    }
  }

  console.log("");

  if (allOrders.length === 0) {
    console.log("📭 No matching orders found across any instance.");
    return;
  }

  // Sort by premium (best deal first)
  // For sell orders (buyer wants low premium), sort ascending
  // For buy orders (seller wants high premium), sort descending
  const sorted = allOrders.sort((a, b) => {
    if (opts.kind === "sell") return a.premium - b.premium; // lowest premium = best for buyer
    if (opts.kind === "buy") return b.premium - a.premium;  // highest premium = best for seller
    return a.premium - b.premium;
  });

  if (opts.best) {
    const best = sorted[0];
    console.log(`🏆 Best order:`);
    console.log(`   Instance: ${best.instance}`);
    console.log(`   ID: ${best.id}`);
    console.log(`   Type: ${best.kind}`);
    console.log(`   Amount: ${best.fiat_amount} ${best.currency}`);
    console.log(`   Premium: ${best.premium}%`);
    console.log(`   Payment: ${best.payment_methods.join(", ")}`);
    if (best.amount > 0) console.log(`   Sats: ${best.amount}`);
    return;
  }

  console.log(`📋 All orders (${sorted.length}), sorted by premium:\n`);
  for (const order of sorted) {
    const pmStr = order.payment_methods.join(", ");
    console.log(
      `  [${order.instance}] ${order.kind.toUpperCase()} ${order.fiat_amount} ${order.currency} @ ${order.premium}% | ${pmStr} | ${order.id.slice(0, 8)}...`
    );
  }
}

main().catch((e) => {
  console.error("❌ Error:", e.message);
  process.exit(1);
});
