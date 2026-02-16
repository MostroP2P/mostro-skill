#!/usr/bin/env tsx
/**
 * Analytics — Trade history and statistics from the audit log
 *
 * Usage:
 *   tsx scripts/analytics.ts                      # Show summary stats
 *   tsx scripts/analytics.ts --recent 10          # Show last 10 trades
 *   tsx scripts/analytics.ts --csv                # Export all trades to CSV
 *   tsx scripts/analytics.ts --days 30            # Stats for last 30 days
 */

import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import type { AuditEntry } from "../lib/safety.js";

const AUDIT_LOG = join(process.env.HOME ?? "/tmp", ".mostro-skill", "audit.log");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      opts[args[i].slice(2).replace(/-/g, "_")] = args[++i];
    } else if (args[i] === "--csv") {
      opts.csv = "true";
    }
  }
  return {
    recent: opts.recent ? parseInt(opts.recent, 10) : undefined,
    csv: opts.csv === "true",
    days: opts.days ? parseInt(opts.days, 10) : undefined,
    output: opts.output,
  };
}

function loadAuditLog(): AuditEntry[] {
  if (!existsSync(AUDIT_LOG)) {
    console.error(`📭 No audit log found at ${AUDIT_LOG}`);
    console.error("   Start trading to generate history.");
    process.exit(0);
  }
  const lines = readFileSync(AUDIT_LOG, "utf-8").trim().split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

// Trade actions that represent actual trades
const TRADE_ACTIONS = ["create-order", "take-order", "take-sell", "take-buy"];
const COMPLETION_ACTIONS = ["release", "fiat-sent"];

function isTradeEntry(entry: AuditEntry): boolean {
  return TRADE_ACTIONS.includes(entry.action);
}

function main() {
  const opts = parseArgs();
  let entries = loadAuditLog();

  // Filter by date range if specified
  if (opts.days) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - opts.days);
    const cutoffStr = cutoff.toISOString();
    entries = entries.filter((e) => e.timestamp >= cutoffStr);
  }

  // CSV export mode
  if (opts.csv) {
    const header = "timestamp,action,order_id,fiat_amount,fiat_code,result,details";
    const rows = entries.map((e) =>
      [
        e.timestamp,
        e.action,
        e.order_id ?? "",
        e.fiat_amount ?? "",
        e.fiat_code ?? "",
        e.result,
        (e.details ?? "").replace(/,/g, ";"),
      ].join(",")
    );
    const csv = [header, ...rows].join("\n");

    const outFile = opts.output ?? "trade-history.csv";
    writeFileSync(outFile, csv);
    console.log(`📄 Exported ${entries.length} entries to ${outFile}`);
    return;
  }

  // Recent trades mode
  if (opts.recent) {
    const recent = entries.slice(-opts.recent);
    console.log(`📋 Last ${recent.length} audit entries:\n`);
    for (const entry of recent) {
      const time = new Date(entry.timestamp).toLocaleString();
      const amount = entry.fiat_amount ? `${entry.fiat_amount} ${entry.fiat_code ?? ""}` : "";
      const icon = entry.result === "success" ? "✅" : entry.result === "failed" ? "❌" : "⏳";
      console.log(`  ${icon} ${time} | ${entry.action} ${amount} ${entry.order_id ? `[${entry.order_id.slice(0, 8)}...]` : ""}`);
      if (entry.details) console.log(`     ${entry.details}`);
    }
    return;
  }

  // Summary stats (default)
  const trades = entries.filter(isTradeEntry);
  const successful = trades.filter((t) => t.result === "success");
  const failed = trades.filter((t) => t.result === "failed");
  const rejected = trades.filter((t) => t.result === "rejected");

  // Volume calculation
  let totalVolume = 0;
  const volumeByCurrency: Record<string, number> = {};
  for (const trade of successful) {
    if (trade.fiat_amount && trade.fiat_code) {
      totalVolume += trade.fiat_amount;
      volumeByCurrency[trade.fiat_code] = (volumeByCurrency[trade.fiat_code] ?? 0) + trade.fiat_amount;
    }
  }

  // Trade sizes
  const amounts = successful.filter((t) => t.fiat_amount).map((t) => t.fiat_amount!);
  const avgSize = amounts.length > 0 ? amounts.reduce((a, b) => a + b, 0) / amounts.length : 0;
  const minSize = amounts.length > 0 ? Math.min(...amounts) : 0;
  const maxSize = amounts.length > 0 ? Math.max(...amounts) : 0;

  // Time range
  const firstTrade = entries.length > 0 ? entries[0].timestamp : "N/A";
  const lastTrade = entries.length > 0 ? entries[entries.length - 1].timestamp : "N/A";

  // Action breakdown
  const actionCounts: Record<string, number> = {};
  for (const entry of entries) {
    actionCounts[entry.action] = (actionCounts[entry.action] ?? 0) + 1;
  }

  const period = opts.days ? `(last ${opts.days} days)` : "(all time)";

  console.log(`📊 Mostro Trading Analytics ${period}\n`);
  console.log(`   Period: ${firstTrade.slice(0, 10)} → ${lastTrade.slice(0, 10)}`);
  console.log(`   Total audit entries: ${entries.length}`);
  console.log("");
  console.log("📈 Trade Summary:");
  console.log(`   Total trades: ${trades.length}`);
  console.log(`   Successful: ${successful.length}`);
  console.log(`   Failed: ${failed.length}`);
  console.log(`   Rejected (limits): ${rejected.length}`);
  console.log(`   Success rate: ${trades.length > 0 ? ((successful.length / trades.length) * 100).toFixed(1) : 0}%`);
  console.log("");
  console.log("💰 Volume:");
  if (Object.keys(volumeByCurrency).length > 0) {
    for (const [currency, vol] of Object.entries(volumeByCurrency)) {
      console.log(`   ${currency}: ${vol.toFixed(2)}`);
    }
  } else {
    console.log("   No completed trades yet.");
  }
  console.log("");
  console.log("📏 Trade Size:");
  console.log(`   Average: ${avgSize.toFixed(2)}`);
  console.log(`   Min: ${minSize}`);
  console.log(`   Max: ${maxSize}`);
  console.log("");
  console.log("🔧 Action Breakdown:");
  for (const [action, count] of Object.entries(actionCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${action}: ${count}`);
  }
}

main();
