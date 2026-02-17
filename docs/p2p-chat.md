# P2P Chat Implementation

## Overview

P2P chat enables direct messaging between trade counterparties (buyer ↔ seller) **without going through the Mostro daemon**. Messages are end-to-end encrypted using a shared ECDH key derived from both parties' trade keys.

This is separate from the `send-dm` action which routes messages through Mostro (used for dispute resolution with solvers).

## Protocol

Full spec: https://mostro.network/protocol/chat.html

### Key Derivation

Both parties independently derive the same shared key using ECDH:

```
Alice (seller):  shared_secret = ECDH(alice_trade_privkey, bob_trade_pubkey)
Bob (buyer):     shared_secret = ECDH(bob_trade_privkey, alice_trade_pubkey)
                 → Same shared_secret (ECDH is symmetric)

shared_pubkey = getPublicKey(shared_secret)
```

Implementation (`lib/p2p-chat.ts`):

```typescript
import { secp256k1 } from "@noble/curves/secp256k1";

const sharedPoint = secp256k1.getSharedSecret(ourPrivKeyHex, "02" + peerPubKeyHex);
const sharedPrivKey = sharedPoint.slice(1, 33); // x-coordinate only
const sharedPubKey = getPublicKey(sharedPrivKey);
```

### Message Structure (Simplified NIP-59)

Unlike Mostro daemon messages which use full NIP-59 (rumor → seal → wrap), P2P chat uses a simplified 2-layer structure:

#### Layer 1: Inner Event (kind 1)

A regular Nostr event signed by the sender's trade key:

```json
{
  "id": "<event_id>",
  "pubkey": "<sender_trade_pubkey>",
  "kind": 1,
  "created_at": 1691518405,
  "content": "Hello! Here are my payment details...",
  "tags": [["p", "<shared_pubkey>"]],
  "sig": "<trade_key_signature>"
}
```

The signature authenticates the sender. In case of a dispute, either party can share the shared key with a solver to verify messages.

#### Layer 2: Wrapper (kind 1059)

The inner event is NIP-44 encrypted with an ephemeral key targeting the shared pubkey:

```json
{
  "kind": 1059,
  "created_at": "<tweaked_timestamp>",
  "pubkey": "<ephemeral_pubkey>",
  "content": "<NIP-44 encrypted inner event>",
  "tags": [["p", "<shared_pubkey>"]],
  "sig": "<ephemeral_signature>"
}
```

**Encryption**: `NIP44.encrypt(JSON.stringify(innerEvent), conversationKey(ephemeralPrivKey, sharedPubKey))`

**Decryption**: `NIP44.decrypt(wrapper.content, conversationKey(sharedPrivKey, wrapper.pubkey))`

### Comparison: P2P Chat vs Daemon Messages

| | Daemon (gift wrap) | P2P Chat |
|---|---|---|
| Goes through Mostro | ✅ Yes | ❌ No, direct |
| Encryption layers | 3 (rumor → seal → wrap) | 2 (inner → wrap) |
| `p` tag points to | Mostro/trade pubkey | **Shared ECDH pubkey** |
| Inner event signed | ❌ Unsigned (rumor) | ✅ Signed by trade key |
| Use case | Orders, actions, disputes | Chat between buyer/seller |
| Privacy from Mostro | Mostro sees content | Mostro cannot read |

## Files

### `lib/p2p-chat.ts`

Core library with three exports:

- **`computeSharedKey(ourPrivKey, peerPubKey)`** → `{ privateKey, publicKey }`
  - ECDH shared secret derivation
  - Used for both encryption and relay subscription

- **`sendP2PMessage(pool, relays, tradePrivKey, sharedKey, message)`** → `void`
  - Creates signed inner event (kind 1)
  - Encrypts with ephemeral key → shared pubkey
  - Publishes kind 1059 wrapper to relays

- **`fetchP2PMessages(pool, relays, sharedKey)`** → `ChatMessage[]`
  - Queries kind 1059 events tagged with shared pubkey
  - Decrypts using shared secret
  - Returns messages sorted by timestamp

### `scripts/chat.ts`

CLI interface:

```bash
# Send a message
npx tsx scripts/chat.ts --order-id <uuid> --message "Hello!"

# Read messages
npx tsx scripts/chat.ts --order-id <uuid> --read

# Read and send in one call
npx tsx scripts/chat.ts --order-id <uuid> --read --message "Hello!"
```

The script automatically:
1. Fetches the order details from Mostro to get the peer's trade pubkey
2. Determines our role (buyer/seller)
3. Computes the shared ECDH key
4. Reads/sends messages

Example output:

```
🔍 Fetching order 0c8d56ac-799c-4504-bdfb-661585532e11...
   Role: seller
   Peer: dc6d2a24a416d43b...
   Shared key: a72883c2e3b386b2...

💬 Chat (2 messages):

  ← [17:39] Peer: hola, a dónde te envío los pesos?
  → [17:42] You: Hey! Here are my payment details...

📤 Sending: "Thanks, payment received!"
✅ Message sent!
```

## Security Considerations

- **Shared key privacy**: The shared ECDH key should not be shared publicly. Either party can voluntarily disclose it to a dispute solver for message verification.
- **Ephemeral keys**: Each message uses a fresh ephemeral key for the wrapper, preventing linkability between messages.
- **Tweaked timestamps**: Wrapper events use randomized timestamps (up to 2 days in the past) per NIP-59 to prevent time-analysis attacks.
- **Trade key authentication**: Inner events are signed by the sender's trade key, ensuring message authenticity and non-repudiation.

## Dependencies

- `nostr-tools` — Event creation, NIP-44 encryption, relay pool
- `@noble/curves/secp256k1` — ECDH shared secret computation
- `@noble/hashes/utils` — Hex encoding utilities
