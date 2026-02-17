/**
 * Nostr Client for Mostro Protocol
 *
 * Handles:
 * - Relay connections
 * - Event subscription and fetching
 * - NIP-59 Gift Wrap send/receive
 * - NIP-44 encryption/decryption
 */

import {
  SimplePool,
  getPublicKey,
  nip59,
  type Filter,
  type Event as NostrEvent,
} from "nostr-tools";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import type { MostroConfig } from "./config.js";
import type { MostroKeys } from "./keys.js";
import type { Message, RumorContent } from "./protocol.js";

// Mostro event kinds
export const KIND_ORDER = 38383;
export const KIND_RATING = 38384;
export const KIND_INFO = 38385;
export const KIND_DISPUTE = 38386;
export const KIND_GIFT_WRAP = 1059;

export interface MostroClient {
  pool: SimplePool;
  relays: string[];
  config: MostroConfig;
  keys?: MostroKeys;
}

/**
 * Create a Mostro Nostr client
 */
export function createClient(
  config: MostroConfig,
  keys?: MostroKeys
): MostroClient {
  const pool = new SimplePool();
  return { pool, relays: config.relays, config, keys };
}

/**
 * Close the client and disconnect from relays
 */
export function closeClient(client: MostroClient): void {
  client.pool.close(client.relays);
}

// ─── Event Fetching ─────────────────────────────────────────────────────────

/**
 * Fetch events matching a filter from relays
 */
export async function fetchEvents(
  client: MostroClient,
  filters: Filter[]
): Promise<NostrEvent[]> {
  // querySync accepts (relays, filter1, filter2, ...)
  const events: NostrEvent[] = [];
  for (const f of filters) {
    const result = await client.pool.querySync(client.relays, f);
    events.push(...result);
  }
  return events;
}

/**
 * Fetch order events (kind 38383) with optional filters
 */
export async function fetchOrderEvents(
  client: MostroClient,
  opts?: {
    status?: string;
    kind?: string;
    currency?: string;
    limit?: number;
  }
): Promise<NostrEvent[]> {
  const filter: Filter & Record<string, unknown> = {
    kinds: [KIND_ORDER],
    authors: [client.config.mostro_pubkey],
    limit: opts?.limit ?? 50,
  };

  if (opts?.status) filter["#s"] = [opts.status];
  if (opts?.kind) filter["#k"] = [opts.kind];
  if (opts?.currency) filter["#f"] = [opts.currency.toUpperCase()];
  filter["#z"] = ["order"];

  return fetchEvents(client, [filter as Filter]);
}

/**
 * Fetch Mostro info event (kind 38385)
 */
export async function fetchMostroInfo(
  client: MostroClient
): Promise<NostrEvent | null> {
  const filter: Filter & Record<string, unknown> = {
    kinds: [KIND_INFO],
    authors: [client.config.mostro_pubkey],
    limit: 1,
  };
  filter["#z"] = ["info"];

  const events = await fetchEvents(client, [filter as Filter]);
  return events.length > 0 ? events[0] : null;
}

/**
 * Fetch dispute events (kind 38386)
 */
export async function fetchDisputeEvents(
  client: MostroClient,
  opts?: { status?: string; limit?: number }
): Promise<NostrEvent[]> {
  const filter: Filter & Record<string, unknown> = {
    kinds: [KIND_DISPUTE],
    authors: [client.config.mostro_pubkey],
    limit: opts?.limit ?? 20,
  };
  filter["#z"] = ["dispute"];
  if (opts?.status) filter["#s"] = [opts.status];

  return fetchEvents(client, [filter as Filter]);
}

// ─── NIP-59 Gift Wrap ───────────────────────────────────────────────────────

// ─── NIP-59 Gift Wrap ───────────────────────────────────────────────────────

/**
 * Send a NIP-59 gift-wrapped message to Mostro
 *
 * Uses nostr-tools native NIP-59 implementation for correctness.
 * Structure:
 * 1. Rumor (unsigned kind 1) — trade key pubkey, contains the message
 * 2. Seal (kind 13) — signed by trade key, encrypts the rumor
 * 3. Gift Wrap (kind 1059) — signed by ephemeral key, encrypts the seal
 */
export async function sendGiftWrap(
  client: MostroClient,
  message: Message,
  signature: string | null,
  tradeKeyPrivate: string
): Promise<void> {
  if (!client.keys) throw new Error("Keys not configured");

  const mostroPublicKey = client.config.mostro_pubkey;
  const tradeKeyBytes = hexToBytes(tradeKeyPrivate);

  // Build rumor content: [message, signature] (Mostro protocol format)
  const rumorContent: RumorContent = [message, signature];
  const rumorContentStr = JSON.stringify(rumorContent);

  // Use nostr-tools native NIP-59 implementation
  const rumor = nip59.createRumor(
    {
      kind: 1,
      content: rumorContentStr,
      tags: [["p", mostroPublicKey]],
      created_at: Math.floor(Date.now() / 1000),
    },
    tradeKeyBytes
  );

  const seal = nip59.createSeal(rumor, tradeKeyBytes, mostroPublicKey);
  const wrap = nip59.createWrap(seal, mostroPublicKey);

  // Publish to relays — use allSettled to log per-relay failures
  const publishPromises = client.relays.map(async (relay) => {
    // pool.publish returns Promise<string>[] (one per relay), await the first
    const promises = client.pool.publish([relay], wrap);
    await Promise.all(promises);
    return relay;
  });
  const results = await Promise.allSettled(publishPromises);
  const succeeded = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected");
  for (const f of failed) {
    const reason = (f as PromiseRejectedResult).reason;
    console.warn(`⚠️  Relay publish failed: ${reason?.message ?? reason}`);
  }
  if (succeeded.length === 0) {
    throw new Error(
      `Failed to publish gift wrap to any relay: ${client.relays.join(", ")}`
    );
  }
}

/**
 * Fetch and decrypt gift-wrapped messages addressed to a specific key
 */
export async function fetchGiftWraps(
  client: MostroClient,
  recipientPrivkey: string,
  sinceMinutes = 60
): Promise<
  Array<{ message: Message; signature: string | null; timestamp: number }>
> {
  const recipientBytes = hexToBytes(recipientPrivkey);
  const recipientPubkey = getPublicKey(recipientBytes);

  // NIP-59 gift wraps use tweaked timestamps (up to 2 days in the past) for privacy.
  // Respect sinceMinutes but enforce a 3-day minimum floor so we never miss
  // responses with tweaked timestamps.
  const THREE_DAYS = 3 * 24 * 60 * 60;
  const requestedWindow = sinceMinutes * 60;
  const window = Math.max(requestedWindow, THREE_DAYS);
  const since = Math.floor(Date.now() / 1000) - window;

  const filter: Filter = {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientPubkey],
    since,
  };

  const events = await fetchEvents(client, [filter]);
  const results: Array<{
    message: Message;
    signature: string | null;
    timestamp: number;
  }> = [];

  for (const event of events) {
    try {
      // Use nostr-tools native NIP-59 unwrap
      const rumor = nip59.unwrapEvent(event, recipientBytes);

      // Parse rumor content
      const content = JSON.parse(rumor.content);
      const [message, signature] = Array.isArray(content)
        ? content
        : [content, null];

      results.push({ message, signature, timestamp: rumor.created_at });
    } catch {
      // Skip events we can't decrypt (not for us)
      continue;
    }
  }

  return results;
}
