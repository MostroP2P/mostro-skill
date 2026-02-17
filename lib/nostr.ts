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
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  type Filter,
  type Event as NostrEvent,
  type UnsignedEvent,
} from "nostr-tools";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha256";
import { schnorr } from "@noble/curves/secp256k1";
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

/**
 * Get a tweaked timestamp for privacy (random offset, always in the past)
 */
function getTweakedTimestamp(): number {
  const now = Math.floor(Date.now() / 1000);
  const twoDays = 2 * 24 * 60 * 60;
  const offset = Math.floor(Math.random() * twoDays);
  return now - offset - 60;
}

/**
 * NIP-44 encrypt content
 */
function nip44Encrypt(
  senderPrivkey: Uint8Array,
  receiverPubkey: string,
  content: string
): string {
  const conversationKey = nip44.v2.utils.getConversationKey(
    senderPrivkey,
    receiverPubkey
  );
  return nip44.v2.encrypt(content, conversationKey);
}

/**
 * NIP-44 decrypt content
 */
function nip44Decrypt(
  receiverPrivkey: Uint8Array,
  senderPubkey: string,
  ciphertext: string
): string {
  const conversationKey = nip44.v2.utils.getConversationKey(
    receiverPrivkey,
    senderPubkey
  );
  return nip44.v2.decrypt(ciphertext, conversationKey);
}

/**
 * Send a NIP-59 gift-wrapped message to Mostro
 *
 * Structure:
 * 1. Rumor (unsigned kind 1) — trade key pubkey, contains the message
 * 2. Seal (kind 13) — signed by identity key, encrypts the rumor
 * 3. Gift Wrap (kind 1059) — signed by ephemeral key, encrypts the seal
 */
export async function sendGiftWrap(
  client: MostroClient,
  message: Message,
  signature: string | null,
  tradeKeyPrivate: string,
  identityKeyPrivate?: string
): Promise<void> {
  if (!client.keys) throw new Error("Keys not configured");

  const mostroPublicKey = client.config.mostro_pubkey;
  const tradeKeyBytes = hexToBytes(tradeKeyPrivate);
  const tradePublicKey = getPublicKey(tradeKeyBytes);

  // The identity key signs the seal; if not provided, use trade key (privacy mode)
  const sealKeyBytes = identityKeyPrivate
    ? hexToBytes(identityKeyPrivate)
    : tradeKeyBytes;
  const sealPublicKey = identityKeyPrivate
    ? getPublicKey(sealKeyBytes)
    : tradePublicKey;

  // 1. Compute signature: SHA256 hash of serialized message, signed by trade key
  // This is required by Mostro protocol - without it, messages are silently ignored
  const messageStr = JSON.stringify(message);
  const messageHash = sha256(new TextEncoder().encode(messageStr));
  const signatureBytes = schnorr.sign(messageHash, tradeKeyBytes);
  const computedSignature = bytesToHex(signatureBytes);

  // 2. Build rumor content: [message, signature]
  const rumorContent: RumorContent = [message, computedSignature];
  const rumorContentStr = JSON.stringify(rumorContent);

  // 3. Create rumor (unsigned event, kind 1)
  const rumor: UnsignedEvent = {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: rumorContentStr,
    pubkey: tradePublicKey,
  };

  // 3. Create seal (kind 13) — encrypt rumor with identity key → Mostro
  const encryptedRumor = nip44Encrypt(
    sealKeyBytes,
    mostroPublicKey,
    JSON.stringify(rumor)
  );

  const sealUnsigned: UnsignedEvent = {
    kind: 13,
    created_at: getTweakedTimestamp(),
    tags: [],
    content: encryptedRumor,
    pubkey: sealPublicKey,
  };
  const signedSeal = finalizeEvent(sealUnsigned, sealKeyBytes);

  // 4. Create gift wrap (kind 1059) — encrypt seal with ephemeral key → Mostro
  const ephemeralKey = generateSecretKey();
  const encryptedSeal = nip44Encrypt(
    ephemeralKey,
    mostroPublicKey,
    JSON.stringify(signedSeal)
  );

  const giftWrapUnsigned: UnsignedEvent = {
    kind: KIND_GIFT_WRAP,
    created_at: getTweakedTimestamp(),
    tags: [["p", mostroPublicKey]],
    content: encryptedSeal,
    pubkey: getPublicKey(ephemeralKey),
  };
  const signedGiftWrap = finalizeEvent(giftWrapUnsigned, ephemeralKey);

  // 5. Publish to relays
  await Promise.any(
    client.relays.map((relay) =>
      client.pool.publish([relay], signedGiftWrap)
    )
  );
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

  const since = Math.floor(Date.now() / 1000) - sinceMinutes * 60;

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
      // Decrypt gift wrap → seal
      const sealJson = nip44Decrypt(
        recipientBytes,
        event.pubkey,
        event.content
      );
      const seal = JSON.parse(sealJson);

      // Decrypt seal → rumor
      const rumorJson = nip44Decrypt(
        recipientBytes,
        seal.pubkey,
        seal.content
      );
      const rumor = JSON.parse(rumorJson);

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
