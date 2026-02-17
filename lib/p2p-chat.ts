/**
 * P2P Chat for Mostro Protocol
 *
 * Direct peer-to-peer messaging between trade counterparties.
 * This communication bypasses the Mostro daemon entirely.
 *
 * Protocol spec: https://mostro.network/protocol/chat.html
 *
 * Flow:
 * 1. Compute shared ECDH key from our trade key + peer's trade pubkey
 * 2. Inner event (kind 1): message content, signed by our trade key
 * 3. Wrapper (kind 1059): NIP-44 encrypted inner event, signed by ephemeral key
 *    - p tag points to shared pubkey (not peer's trade key)
 *
 * This is a simplified NIP-59 — no seal layer, just inner event + wrapper.
 */

import {
  SimplePool,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  verifyEvent,
  type Filter,
  type Event as NostrEvent,
} from "nostr-tools";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import { secp256k1 } from "@noble/curves/secp256k1";
import { publishToRelays } from "./nostr.js";

// ─── Shared Key ─────────────────────────────────────────────────────────────

export interface SharedKeyPair {
  /** Raw shared secret (32 bytes hex) — used as private key */
  privateKey: string;
  /** Corresponding public key */
  publicKey: string;
}

/**
 * Compute the ECDH shared key between our trade key and peer's trade pubkey.
 *
 * This shared key is used as the encryption target for P2P chat messages.
 * Both parties derive the same shared key independently.
 */
export function computeSharedKey(
  ourPrivateKeyHex: string,
  peerPublicKeyHex: string
): SharedKeyPair {
  // secp256k1 ECDH: multiply peer's pubkey by our private key
  // getSharedSecret returns 33-byte compressed point; take x-coordinate (bytes 1-33)
  // Normalize pubkey: if already compressed (66 hex chars with 02/03 prefix), use as-is;
  // if raw x-coordinate (64 hex chars), prepend "02"
  let compressedPubkey: string;
  if (peerPublicKeyHex.length === 66 && (peerPublicKeyHex.startsWith("02") || peerPublicKeyHex.startsWith("03"))) {
    compressedPubkey = peerPublicKeyHex;
  } else if (peerPublicKeyHex.length === 64) {
    compressedPubkey = "02" + peerPublicKeyHex;
  } else {
    throw new Error(`Invalid peer public key length: ${peerPublicKeyHex.length} hex chars (expected 64 or 66)`);
  }
  const sharedPoint = secp256k1.getSharedSecret(
    ourPrivateKeyHex,
    compressedPubkey
  );
  const privateKey = bytesToHex(sharedPoint.slice(1, 33));
  const publicKey = getPublicKey(hexToBytes(privateKey));
  return { privateKey, publicKey };
}

// ─── Send Message ───────────────────────────────────────────────────────────

/**
 * Get a tweaked timestamp for the wrapper event (NIP-59 privacy).
 */
function getTweakedTimestamp(): number {
  const now = Math.floor(Date.now() / 1000);
  const twoDays = 2 * 24 * 60 * 60;
  const offset = Math.floor(Math.random() * twoDays);
  return now - offset - 60;
}

/**
 * Send a P2P chat message to the trade counterparty.
 *
 * Creates a simplified NIP-59 wrapped event:
 * - Inner: kind 1, signed by our trade key, content = message text
 * - Wrapper: kind 1059, encrypted with ephemeral key → shared pubkey
 */
export async function sendP2PMessage(
  pool: SimplePool,
  relays: string[],
  tradePrivateKeyHex: string,
  sharedKey: SharedKeyPair,
  message: string
): Promise<void> {
  const tradeKeyBytes = hexToBytes(tradePrivateKeyHex);

  // 1. Create inner event (kind 1) signed by trade key
  const innerEvent = finalizeEvent(
    {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      content: message,
      tags: [["p", sharedKey.publicKey]],
    },
    tradeKeyBytes
  );

  // 2. Encrypt inner event with ephemeral key → shared pubkey
  const ephemeralKey = generateSecretKey();
  const conversationKey = nip44.v2.utils.getConversationKey(
    ephemeralKey,
    sharedKey.publicKey
  );
  const encryptedContent = nip44.v2.encrypt(
    JSON.stringify(innerEvent),
    conversationKey
  );

  // 3. Create wrapper (kind 1059) signed by ephemeral key
  const wrapper = finalizeEvent(
    {
      kind: 1059,
      created_at: getTweakedTimestamp(),
      content: encryptedContent,
      tags: [["p", sharedKey.publicKey]],
    },
    ephemeralKey
  );

  // 4. Publish to relays
  await publishToRelays(pool, relays, wrapper);
}

// ─── Receive Messages ───────────────────────────────────────────────────────

export interface ChatMessage {
  /** Sender's trade pubkey */
  senderPubkey: string;
  /** Message text */
  content: string;
  /** Timestamp from inner event */
  timestamp: number;
  /** Event ID of the wrapper */
  eventId: string;
}

/**
 * Fetch and decrypt P2P chat messages for a trade.
 *
 * Subscribes to kind 1059 events tagged with the shared pubkey,
 * decrypts each using the shared secret, and returns parsed messages.
 */
export async function fetchP2PMessages(
  pool: SimplePool,
  relays: string[],
  sharedKey: SharedKeyPair
): Promise<ChatMessage[]> {
  const sharedKeyBytes = hexToBytes(sharedKey.privateKey);

  // NIP-59 tweaked timestamps can be up to 2 days in the past
  const THREE_DAYS = 3 * 24 * 60 * 60;
  const since = Math.floor(Date.now() / 1000) - THREE_DAYS;

  const filter: Filter = {
    kinds: [1059],
    "#p": [sharedKey.publicKey],
    since,
  };

  const events = await pool.querySync(relays, filter);
  const messages: ChatMessage[] = [];

  for (const event of events) {
    try {
      // Decrypt wrapper content using shared key
      const conversationKey = nip44.v2.utils.getConversationKey(
        sharedKeyBytes,
        event.pubkey
      );
      const decrypted = nip44.v2.decrypt(event.content, conversationKey);
      const innerEvent = JSON.parse(decrypted) as NostrEvent;

      // Verify the inner event signature to prevent spoofing
      if (!verifyEvent(innerEvent)) {
        continue;
      }

      messages.push({
        senderPubkey: innerEvent.pubkey,
        content: innerEvent.content,
        timestamp: innerEvent.created_at,
        eventId: event.id,
      });
    } catch {
      // Skip events we can't decrypt
      continue;
    }
  }

  // Sort by timestamp (oldest first)
  return messages.sort((a, b) => a.timestamp - b.timestamp);
}
