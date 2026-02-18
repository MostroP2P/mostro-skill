/**
 * Configuration Management for Mostro Trading Skill
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

export interface TradeLimits {
  /** @deprecated Use max_trade_amount_sats instead */
  max_trade_amount_fiat?: number;
  /** @deprecated Use max_daily_volume_sats instead */
  max_daily_volume_fiat?: number;
  max_trade_amount_sats: number;
  max_daily_volume_sats: number;
  max_trades_per_day: number;
  cooldown_seconds: number;
  require_confirmation: boolean;
}

export interface MostroConfig {
  mostro_pubkey: string;
  relays: string[];
  network: "mainnet" | "testnet" | "signet";
  limits: TradeLimits;
  price_api: string;
  max_premium_deviation: number;
}

const DEFAULT_CONFIG: MostroConfig = {
  mostro_pubkey: "",
  relays: ["wss://relay.mostro.network", "wss://nos.lol"],
  network: "mainnet",
  limits: {
    max_trade_amount_sats: 50000,    // ~$50 USD at $100k/BTC
    max_daily_volume_sats: 500000,   // ~$500 USD at $100k/BTC
    max_trades_per_day: 10,
    cooldown_seconds: 300,
    require_confirmation: true,
  },
  price_api: "https://api.yadio.io/exrates/BTC",
  max_premium_deviation: 5,
};

/**
 * Load configuration from config.json in the skill directory
 */
export function loadConfig(configPath?: string): MostroConfig {
  const skillDir = new URL(".", import.meta.url).pathname.replace(
    /\/lib\/?$/,
    ""
  );
  const path = configPath ?? join(skillDir, "config.json");

  if (!existsSync(path)) {
    console.error(
      `⚠️  Config file not found at ${path}. Using defaults. Copy config.example.json to config.json and set mostro_pubkey.`
    );
    return DEFAULT_CONFIG;
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const userConfig = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...userConfig, limits: { ...DEFAULT_CONFIG.limits, ...userConfig.limits } };
  } catch (e) {
    console.error(`⚠️  Failed to parse config: ${e}`);
    return DEFAULT_CONFIG;
  }
}

/**
 * Validate that the configuration is usable
 */
export function validateConfig(config: MostroConfig): string[] {
  const errors: string[] = [];
  if (!config.mostro_pubkey) {
    errors.push("mostro_pubkey is required — set the hex pubkey of your Mostro instance");
  }
  if (config.relays.length === 0) {
    errors.push("At least one relay is required");
  }
  if (config.limits.max_trade_amount_sats <= 0) {
    errors.push("max_trade_amount_sats must be positive");
  }
  return errors;
}
