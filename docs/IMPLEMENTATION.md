# Mostro AI Skills — Implementation Plan

## Overview

This document details the implementation of `mostro-trading`, an AI skill that enables AI agents (OpenClaw, Claude Desktop, etc.) to interact with the Mostro P2P Bitcoin exchange protocol over Nostr.

**Language choice: TypeScript (Node.js)**
- Faster prototyping than Rust
- Native to the AI agent ecosystem (OpenClaw, ClawHub)
- `nostr-tools` library provides full NIP-59 gift wrap support
- `@noble/secp256k1` for key derivation (BIP-32/39)
- Can reuse `mostro-core` type definitions as TypeScript interfaces
- Skill format requires scripts that agents invoke — TypeScript is ideal

**Key design principle**: The skill acts as a Mostro **client** — it communicates with Mostro via the existing Nostr protocol (NIP-59 gift wrap), just like mostro-cli or Mostro Mobile. No changes to mostrod are needed.

## Architecture

```
┌─────────────────┐     ┌──────────────────────────────┐     ┌─────────────┐
│   AI Agent      │────▶│  mostro-trading skill         │────▶│   Mostro    │
│ (OpenClaw,      │     │                                │     │   daemon    │
│  Claude, etc.)  │◀────│  SKILL.md (instructions)       │◀────│   (via      │
│                 │     │  scripts/ (TypeScript tools)   │     │    Nostr)   │
└─────────────────┘     └──────────────────────────────┘     └─────────────┘
                              │
                              ├── scripts/list-orders.ts
                              ├── scripts/create-order.ts
                              ├── scripts/take-order.ts
                              ├── scripts/cancel-order.ts
                              ├── scripts/fiat-sent.ts
                              ├── scripts/release.ts
                              ├── scripts/trade-status.ts
                              ├── scripts/rate-user.ts
                              ├── scripts/dispute.ts
                              ├── scripts/get-info.ts
                              └── lib/
                                  ├── nostr.ts        (Nostr connection, gift wrap, subscriptions)
                                  ├── protocol.ts     (Mostro protocol types & message building)
                                  ├── keys.ts         (HD key derivation, BIP-32/39)
                                  ├── config.ts       (Configuration management)
                                  └── safety.ts       (Trade limits, confirmation, audit logging)
```

## Protocol Summary

### Communication
- All messages to/from Mostro use **NIP-59 Gift Wrap** (kind 1059)
- Rumor content is a JSON array: `[message, signature]`
- Message wrapper: `{ "order": { version, id?, request_id?, trade_index?, action, payload? } }`
- Signature is the sha256 hash of the serialized first element, signed with trade key (or null for privacy mode)

### Key Management (NIP-06)
- Mnemonic seed → derivation path `m/44'/1237'/38383'/0/{index}`
- Index 0 = identity key (signs the seal in gift wrap)
- Index 1+ = trade keys (one per trade, rotated)
- Identity key is used for reputation; omit for full privacy

### Event Kinds
| Kind  | Type     | Description |
|-------|----------|-------------|
| 38383 | Orders   | P2P order book (addressable events) |
| 38384 | Ratings  | User ratings |
| 38385 | Info     | Mostro instance status |
| 38386 | Disputes | Dispute events |

### Order Lifecycle
```
pending → in-progress → waiting-payment → active → fiat-sent → success
                                            ↓
                                         dispute → settled/canceled by admin
```

### Actions (Client → Mostro)
| Action | Description | Payload |
|--------|-------------|---------|
| `new-order` | Create buy/sell order | `{ order: SmallOrder }` |
| `take-sell` | Take a sell order | `null` or `{ payment_request: [...] }` or `{ amount: N }` |
| `take-buy` | Take a buy order | `null` or `{ amount: N }` |
| `add-invoice` | Send LN invoice after taking | `{ payment_request: [null, "lnbc..."] }` |
| `fiat-sent` | Buyer confirms fiat sent | `null` or `{ next_trade: [pubkey, index] }` |
| `release` | Seller releases sats | `null` |
| `cancel` | Cancel order | `null` |
| `dispute` | Open dispute | `null` |
| `rate-user` | Rate counterparty | `{ rating_user: 1-5 }` |
| `orders` | Request order details by IDs | `{ ids: [...] }` |
| `last-trade-index` | Get last trade index | `null` |
| `restore-session` | Restore session from seed | `null` |

### Actions (Mostro → Client)
| Action | Description |
|--------|-------------|
| `new-order` | Order created confirmation |
| `pay-invoice` | Pay this hold invoice (seller) |
| `add-invoice` | Send invoice for this amount (buyer) |
| `buyer-took-order` | Buyer took your order |
| `fiat-sent-ok` | Fiat sent confirmed |
| `hold-invoice-payment-accepted` | Hold invoice paid |
| `released` | Sats released to buyer |
| `purchase-completed` | Trade complete |
| `canceled` | Order canceled |
| `rate` | Rate your counterparty |
| `cant-do` | Action rejected with reason |
| `dispute-initiated-by-you` | Dispute opened by you |
| `dispute-initiated-by-peer` | Dispute opened by counterparty |

### SmallOrder Fields
```typescript
interface SmallOrder {
  id?: string;           // UUID
  kind?: "buy" | "sell";
  status?: string;
  amount: number;         // sats (0 = market price)
  fiat_code: string;      // ISO 4217
  min_amount?: number;    // range orders
  max_amount?: number;    // range orders
  fiat_amount: number;
  payment_method: string; // comma-separated
  premium: number;        // percentage
  buyer_trade_pubkey?: string;
  seller_trade_pubkey?: string;
  buyer_invoice?: string; // LN address for buy orders
  created_at?: number;
  expires_at?: number;
}
```

### Order Event Tags (kind 38383)
```
d: Order ID
k: sell|buy
f: Currency (ISO 4217)
s: Status (pending|canceled|in-progress|success|expired)
amt: Amount in sats
fa: Fiat amount (or "min-max" for range)
pm: Payment methods
premium: Premium percentage
rating: Maker's rating JSON
network: mainnet|testnet|signet
layer: lightning|onchain|liquid
y: Platform name
z: "order"
expires_at: Order expiration timestamp
expiration: Event expiration (NIP-40)
```

## Implementation Phases

### Phase 1: Foundation + Read-Only (This PR)
**Goal**: Skill structure, Nostr connectivity, key management, and read-only operations.

**Deliverables**:
- `SKILL.md` — Agent instructions
- `config.json` — Configuration template
- `lib/config.ts` — Configuration management
- `lib/keys.ts` — HD key derivation (BIP-32/39, path `m/44'/1237'/38383'/0/{n}`)
- `lib/nostr.ts` — Nostr client (connect, subscribe, gift wrap send/receive)
- `lib/protocol.ts` — Mostro protocol types and message builders
- `lib/safety.ts` — Audit logging, trade limits config
- `scripts/get-info.ts` — Query Mostro instance info (kind 38385)
- `scripts/list-orders.ts` — List orders from order book (kind 38383, filter by currency/type/status)
- `scripts/trade-status.ts` — Check status of own orders
- `package.json` + `tsconfig.json`
- Documentation in `docs/`

**Why start here**: Read-only operations are safe, let us validate the Nostr connection, gift wrap implementation, and key management without risking any funds.

### Phase 2: Order Creation + Taking
**Goal**: Create and take orders with confirmation workflow.

**Deliverables**:
- `scripts/create-order.ts` — Create buy/sell orders (fixed and range)
- `scripts/take-order.ts` — Take existing orders (buy/sell, with invoice/LN address)
- `scripts/cancel-order.ts` — Cancel own pending orders
- Enhanced `lib/safety.ts` — Confirmation mode, trade limits enforcement
- `scripts/add-invoice.ts` — Send LN invoice when taking sell orders

**Safety**: All order creation/taking requires explicit user confirmation by default.

### Phase 3: Trade Completion Flow
**Goal**: Full trade lifecycle.

**Deliverables**:
- `scripts/fiat-sent.ts` — Buyer confirms fiat sent
- `scripts/release.ts` — Seller releases sats
- `scripts/rate-user.ts` — Rate counterparty after trade
- `scripts/dispute.ts` — Open dispute on active trade
- Trade state tracking and notifications
- Range order support (child order creation)

### Phase 4: Advanced Features ✅
**Goal**: Automation, multi-Mostro, ecosystem integration.

**Deliverables**:
- `scripts/auto-trade.ts` — Automated trading with configurable strategies (DCA, limit, market making)
- `strategies/` — Example strategy configs (dca-weekly, limit-buy, market-maker)
- `scripts/multi-mostro.ts` — Query multiple Mostro instances, compare orders, find best prices
- `scripts/restore-session.ts` — Import mnemonic, restore active orders/disputes, sync trade index
- `scripts/analytics.ts` — Trade history parsing, stats calculation, CSV export
- `scripts/dispute-chat.ts` — Send messages during disputes via Mostro's `send-dm` action
- `scripts/add-invoice.ts` — Send LN invoice after taking a sell order without one
- Updated `lib/keys.ts` — Trade index persistence, `getNextTradeKeys()`, `importMnemonic()`
- Updated `lib/safety.ts` — Market price validation via `validateOrderPrice()`
- Config: `mostro_instances` array for multi-Mostro support

**Auto-Trading Strategies**:
- **DCA**: Create orders at regular intervals with configurable amount, premium, and payment method
- **Limit**: Monitor order book and auto-take orders matching criteria (premium, rating, amount range)
- **Market Maker**: Maintain simultaneous buy/sell orders with a spread
- All strategies support `--dry-run` mode and respect existing safety limits

**Key Management Improvements**:
- Trade index persisted in `~/.mostro-skill/trade-state.json`
- `getNextTradeKeys()` auto-increments index per trade
- `importMnemonic()` for migrating from other Mostro clients
- `setTradeIndex()` for syncing after session restore

**Price Validation**:
- `validateOrderPrice()` compares order price/premium against market API
- Checks both premium-based and calculated price deviation
- Configurable max deviation via `max_premium_deviation` in config

## Security Model

### Key Storage
- Mnemonic seed stored encrypted in `~/.mostro-skill/seed.enc`
- Encryption key derived from user-provided passphrase (or agent-managed)
- Trade keys derived deterministically — only seed needed for backup
- Keys NEVER logged or included in error messages

### Trade Limits (config.json)
```json
{
  "limits": {
    "max_trade_amount_fiat": 100,
    "max_daily_volume_fiat": 500,
    "max_trades_per_day": 10,
    "cooldown_seconds": 300,
    "require_confirmation": true
  }
}
```

### Confirmation Workflow
- Default: ALL trading actions require user confirmation
- Agent presents order details → user approves → agent executes
- Auto-mode available for advanced users (must explicitly enable + set strict limits)

### Audit Trail
- All actions logged to `~/.mostro-skill/audit.log`
- Each entry: timestamp, action, order_id, amount, result
- Agent can review audit log for anomaly detection

### Threat Mitigations
| Threat | Mitigation |
|--------|------------|
| Prompt injection via order descriptions | Sanitize all order text before displaying to agent |
| Price manipulation | Compare order price against market API before taking |
| Key exfiltration | Keys never in logs/errors; encrypted at rest |
| Runaway trading | Daily volume limits, cooldown periods, max trades/day |
| Stale data | Always fetch fresh order data before acting |

## Configuration

```json
{
  "mostro_pubkey": "<hex pubkey of the Mostro instance>",
  "relays": [
    "wss://relay.mostro.network",
    "wss://relay.damus.io"
  ],
  "network": "mainnet",
  "limits": {
    "max_trade_amount_fiat": 100,
    "max_daily_volume_fiat": 500,
    "max_trades_per_day": 10,
    "cooldown_seconds": 300,
    "require_confirmation": true
  },
  "price_api": "https://api.yadio.io/exrates/BTC",
  "max_premium_deviation": 5
}
```

## Dependencies

- `nostr-tools` — Nostr protocol (events, NIP-44 encryption, NIP-59 gift wrap)
- `@noble/secp256k1` — Secp256k1 operations
- `@scure/bip32` + `@scure/bip39` — HD key derivation
- `@noble/hashes` — SHA256, etc.
- `uuid` — Order ID generation

## File Structure

```
mostro-skill/
├── SKILL.md                    # Agent instructions
├── package.json
├── tsconfig.json
├── config.example.json         # Configuration template
├── docs/
│   └── IMPLEMENTATION.md       # This document
├── lib/
│   ├── config.ts               # Configuration management
│   ├── keys.ts                 # HD key derivation
│   ├── nostr.ts                # Nostr client & gift wrap
│   ├── protocol.ts             # Mostro protocol types
│   └── safety.ts               # Limits, audit, confirmation
└── scripts/
    ├── get-info.ts             # Mostro instance info
    ├── list-orders.ts          # List order book
    ├── trade-status.ts         # Check trade status
    ├── create-order.ts         # Phase 2
    ├── take-order.ts           # Phase 2
    ├── cancel-order.ts         # Phase 2
    ├── add-invoice.ts          # Phase 2
    ├── fiat-sent.ts            # Phase 3
    ├── release.ts              # Phase 3
    ├── rate-user.ts            # Phase 3
    └── dispute.ts              # Phase 3
```
