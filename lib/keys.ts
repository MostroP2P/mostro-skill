/**
 * HD Key Management for Mostro
 *
 * Implements NIP-06 key derivation with Mostro-specific derivation path:
 *   m/44'/1237'/38383'/0/{index}
 *
 * - Index 0: Identity key (signs seal, used for reputation)
 * - Index 1+: Trade keys (one per trade, rotated)
 */

import { HDKey } from "@scure/bip32";
import {
  generateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

// Mostro derivation path: m/44'/1237'/38383'/0/{index}
const MOSTRO_DERIVATION_PREFIX = "m/44'/1237'/38383'/0";

export interface MostroKeys {
  identityPrivateKey: string; // hex
  identityPublicKey: string; // hex
  getTradeKeys(index: number): { privateKey: string; publicKey: string };
}

/**
 * Derive a key at the given index from the Mostro derivation path
 */
function deriveKey(seed: Uint8Array, index: number): HDKey {
  const master = HDKey.fromMasterSeed(seed);
  return master.derive(`${MOSTRO_DERIVATION_PREFIX}/${index}`);
}

/**
 * Get hex private and public key from an HDKey
 */
function getKeyPair(hdkey: HDKey): { privateKey: string; publicKey: string } {
  if (!hdkey.privateKey) throw new Error("No private key derived");
  // x-only pubkey (32 bytes) for Nostr
  const pubkeyFull = hdkey.publicKey;
  if (!pubkeyFull) throw new Error("No public key derived");
  // Remove the 02/03 prefix to get x-only (32 bytes)
  const xOnlyPubkey = pubkeyFull.slice(1);
  return {
    privateKey: bytesToHex(hdkey.privateKey),
    publicKey: bytesToHex(xOnlyPubkey),
  };
}

/**
 * Create MostroKeys from a mnemonic phrase
 */
export function keysFromMnemonic(mnemonic: string): MostroKeys {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error("Invalid mnemonic phrase");
  }

  const seed = mnemonicToSeedSync(mnemonic);
  const identity = deriveKey(seed, 0);
  const identityPair = getKeyPair(identity);

  return {
    identityPrivateKey: identityPair.privateKey,
    identityPublicKey: identityPair.publicKey,
    getTradeKeys(index: number) {
      if (index < 1) throw new Error("Trade key index must be >= 1");
      const tradeKey = deriveKey(seed, index);
      return getKeyPair(tradeKey);
    },
  };
}

/**
 * Generate a new mnemonic phrase (12 words)
 */
export function generateNewMnemonic(): string {
  return generateMnemonic(wordlist, 128);
}

// ─── Trade Index Persistence ────────────────────────────────────────────────

const SKILL_DATA_DIR = join(process.env.HOME ?? "/tmp", ".mostro-skill");
const TRADE_STATE_FILE = join(SKILL_DATA_DIR, "trade-state.json");

interface TradeKeyState {
  next_trade_index: number;
}

function ensureDataDir(): void {
  if (!existsSync(SKILL_DATA_DIR)) {
    mkdirSync(SKILL_DATA_DIR, { recursive: true, mode: 0o700 });
  }
}

function loadTradeKeyState(): TradeKeyState {
  if (!existsSync(TRADE_STATE_FILE)) return { next_trade_index: 1 };
  try {
    const data = JSON.parse(readFileSync(TRADE_STATE_FILE, "utf-8"));
    return { next_trade_index: data.next_trade_index ?? 1 };
  } catch {
    return { next_trade_index: 1 };
  }
}

function saveTradeKeyState(state: TradeKeyState): void {
  ensureDataDir();
  // Merge with existing file (safety.ts also writes trade-state.json)
  let existing: Record<string, unknown> = {};
  if (existsSync(TRADE_STATE_FILE)) {
    try { existing = JSON.parse(readFileSync(TRADE_STATE_FILE, "utf-8")); } catch {}
  }
  writeFileSync(
    TRADE_STATE_FILE,
    JSON.stringify({ ...existing, next_trade_index: state.next_trade_index }, null, 2),
    { mode: 0o600 }
  );
}

/**
 * Get the next trade keys and auto-increment the trade index
 */
export function getNextTradeKeys(keys: MostroKeys): { privateKey: string; publicKey: string; index: number } {
  const state = loadTradeKeyState();
  const index = state.next_trade_index;
  const tradeKeys = keys.getTradeKeys(index);
  state.next_trade_index = index + 1;
  saveTradeKeyState(state);
  return { ...tradeKeys, index };
}

/**
 * Get current trade index without incrementing
 */
export function getCurrentTradeIndex(): number {
  return loadTradeKeyState().next_trade_index;
}

/**
 * Set the trade index (used during session restore)
 */
export function setTradeIndex(index: number): void {
  saveTradeKeyState({ next_trade_index: index });
}

/**
 * Import an existing mnemonic phrase
 */
export function importMnemonic(mnemonic: string): MostroKeys {
  const trimmed = mnemonic.trim();
  if (!validateMnemonic(trimmed, wordlist)) {
    throw new Error("Invalid mnemonic phrase");
  }
  saveMnemonic(trimmed);
  return keysFromMnemonic(trimmed);
}

// ─── Seed Storage ───────────────────────────────────────────────────────────

const SEED_DIR = SKILL_DATA_DIR;
const SEED_FILE = join(SEED_DIR, "seed");

/**
 * Save mnemonic to disk (plaintext for now — Phase 2 will add encryption)
 *
 * TODO: Encrypt with passphrase using scrypt + AES-256-GCM
 */
export function saveMnemonic(mnemonic: string): void {
  if (!existsSync(SEED_DIR)) {
    mkdirSync(SEED_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(SEED_FILE, mnemonic, { mode: 0o600 });
}

/**
 * Load mnemonic from disk
 */
export function loadMnemonic(): string | null {
  if (!existsSync(SEED_FILE)) return null;
  return readFileSync(SEED_FILE, "utf-8").trim();
}

/**
 * Check if a mnemonic/seed is already configured
 */
export function hasSeed(): boolean {
  return existsSync(SEED_FILE);
}

/**
 * Get or create keys — loads existing mnemonic or generates new one
 */
export function getOrCreateKeys(): { keys: MostroKeys; mnemonic: string; isNew: boolean } {
  const existing = loadMnemonic();
  if (existing) {
    return { keys: keysFromMnemonic(existing), mnemonic: existing, isNew: false };
  }
  const mnemonic = generateNewMnemonic();
  saveMnemonic(mnemonic);
  return { keys: keysFromMnemonic(mnemonic), mnemonic, isNew: true };
}
