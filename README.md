# 🧌 mostro-skill

> AI skill for trading Bitcoin P2P on [Mostro](https://mostro.network) — enabling AI agents to interact with the Mostro exchange protocol via Nostr.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What is this?

**mostro-skill** is a modular skill package that teaches AI agents how to trade Bitcoin peer-to-peer on Mostro. It acts as a bridge between AI agent platforms (like [OpenClaw](https://openclaw.ai), Claude Desktop, Cursor, etc.) and the Mostro P2P exchange, communicating through the existing Nostr protocol.

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│   AI Agent      │────▶│  mostro-skill     │────▶│   Mostro    │
│ (OpenClaw,      │     │                   │     │   daemon    │
│  Claude, etc.)  │◀────│  SKILL.md +       │◀────│   (via      │
│                 │     │  scripts/         │     │    Nostr)   │
└─────────────────┘     └──────────────────┘     └─────────────┘
```

**Key points:**
- 🔌 **No changes to mostrod** — communicates via the standard Nostr protocol (NIP-59 gift wrap)
- 🤖 **Agent-agnostic** — works with any AI platform that supports skills
- 🔐 **Security-first** — trade limits, confirmation mode, audit logging, encrypted keys
- ⚡ **Full trade lifecycle** — list, create, take, confirm, release, rate, dispute

## Why?

Mostro is a censorship-resistant P2P Bitcoin exchange built on Nostr and Lightning Network. By making it accessible to AI agents, we enable:

- **Automated DCA** — "Buy $20 of BTC every Monday on Mostro"
- **Personal trading assistants** — "Find me the best sell order under market price"
- **Market making** — Agents maintaining buy/sell orders with a spread
- **Remittance automation** — Scheduled cross-border transfers
- **Portfolio rebalancing** — Automatic trades to maintain target allocations

No P2P Bitcoin exchange currently offers AI agent integration. mostro-skill makes Mostro the **first censorship-resistant P2P exchange accessible to AI agents**.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v20+ (with npm)
- A Mostro instance pubkey (find one at [mostro.network](https://mostro.network))

### Installation

```bash
git clone https://github.com/MostroP2P/mostro-skill.git
cd mostro-skill
npm install
```

### Configuration

```bash
cp config.example.json config.json
```

Edit `config.json` with your settings:

```json
{
  "mostro_pubkey": "<hex pubkey of your Mostro instance>",
  "relays": [
    "wss://relay.mostro.network",
    "wss://relay.damus.io",
    "wss://relay.nostr.band"
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

### First Run

```bash
# Check Mostro instance info
npx tsx scripts/get-info.ts

# List available orders
npx tsx scripts/list-orders.ts --currency USD --kind sell
```

On first run, a new BIP-39 mnemonic is generated and saved to `~/.mostro-skill/seed`. **Back up this mnemonic** — it's the only way to recover your trading identity and reputation.

## Available Tools

### 📖 Read-Only (Safe — no funds at risk)

| Script | Description | Usage |
|--------|-------------|-------|
| `get-info.ts` | Query Mostro instance info (version, fees, currencies, limits) | `npx tsx scripts/get-info.ts` |
| `list-orders.ts` | Browse the order book with filters | `npx tsx scripts/list-orders.ts [options]` |
| `trade-status.ts` | Check status of own orders/trades | `npx tsx scripts/trade-status.ts --order-id <uuid>` |

#### list-orders.ts Options

| Flag | Description | Example |
|------|-------------|---------|
| `--currency` | Filter by fiat currency (ISO 4217) | `--currency USD` |
| `--kind` | Filter by order type | `--kind buy` or `--kind sell` |
| `--status` | Filter by status (default: `pending`) | `--status active` |
| `--limit` | Max number of results | `--limit 20` |

### 💰 Trading (Requires user confirmation by default)

| Script | Description | Usage |
|--------|-------------|-------|
| `create-order.ts` | Create a new buy or sell order | See [Creating Orders](#creating-orders) |
| `take-order.ts` | Take an existing order from the book | See [Taking Orders](#taking-orders) |
| `cancel-order.ts` | Cancel your own pending order | `npx tsx scripts/cancel-order.ts --order-id <uuid>` |
| `fiat-sent.ts` | Buyer confirms fiat payment sent | `npx tsx scripts/fiat-sent.ts --order-id <uuid>` |
| `release.ts` | Seller releases sats after receiving fiat | `npx tsx scripts/release.ts --order-id <uuid>` |
| `rate-user.ts` | Rate your counterparty (1-5 stars) | `npx tsx scripts/rate-user.ts --order-id <uuid> --rating 5` |
| `dispute.ts` | Open a dispute on an active trade | `npx tsx scripts/dispute.ts --order-id <uuid>` |

### 🤖 Advanced (Phase 4)

| Script | Description | Usage |
|--------|-------------|-------|
| `add-invoice.ts` | Send LN invoice after taking a sell order without one | `npx tsx scripts/add-invoice.ts --order-id <uuid> --invoice <lnbc...>` |
| `dispute-chat.ts` | Send messages during an active dispute | `npx tsx scripts/dispute-chat.ts --order-id <uuid> --message <text>` |
| `restore-session.ts` | Import mnemonic and restore active orders/disputes | `npx tsx scripts/restore-session.ts [--mnemonic "..."]` |
| `analytics.ts` | Trade history, stats, and CSV export | `npx tsx scripts/analytics.ts [--recent 10] [--csv] [--days 30]` |
| `multi-mostro.ts` | Query and compare orders across multiple Mostro instances | `npx tsx scripts/multi-mostro.ts --currency USD --kind sell [--best]` |
| `auto-trade.ts` | Automated trading (DCA, limit orders, market making) | `npx tsx scripts/auto-trade.ts --strategy <path> [--dry-run]` |

#### Auto-Trading Strategies

Example strategy configs in `strategies/`:

- **`dca-weekly.json`** — Buy $20 USD of BTC every week
- **`limit-buy.json`** — Auto-take sell orders below -2% premium
- **`market-maker.json`** — Maintain ARS/BTC buy/sell spread

All strategies support `--dry-run` mode for safe testing.

## Trade Flows

### 🛒 Buying Bitcoin

```
1. Browse orders     →  list-orders.ts --kind sell --currency USD
2. Take an order     →  take-order.ts --order-id <id> --action take-sell --invoice <lnbc...>
3. Wait              →  Seller pays hold invoice (sats locked in escrow)
4. Pay fiat          →  Send fiat via the agreed payment method
5. Confirm           →  fiat-sent.ts --order-id <id>
6. Receive sats      →  Seller releases → BTC arrives at your invoice! ⚡
7. Rate seller       →  rate-user.ts --order-id <id> --rating 5
```

### 💰 Selling Bitcoin

```
1. Create order      →  create-order.ts --kind sell --currency USD --fiat-amount 50 --payment-method "bank transfer"
2. Wait for buyer    →  A buyer takes your order
3. Pay hold invoice  →  Pay the Lightning invoice Mostro sends you (sats locked in escrow)
4. Wait for fiat     →  Buyer sends fiat and confirms
5. Verify payment    →  Check your bank/payment app
6. Release sats      →  release.ts --order-id <id>
7. Rate buyer        →  rate-user.ts --order-id <id> --rating 5
```

### Creating Orders

```bash
# Fixed amount buy order
npx tsx scripts/create-order.ts \
  --kind buy \
  --currency USD \
  --fiat-amount 50 \
  --payment-method "bank transfer" \
  --premium 2

# Range sell order (buyer picks amount between min-max)
npx tsx scripts/create-order.ts \
  --kind sell \
  --currency VES \
  --fiat-amount 0 \
  --min-amount 1000 \
  --max-amount 5000 \
  --payment-method "mobile,bank transfer" \
  --premium 1

# Buy order with Lightning address (faster — no manual invoice needed)
npx tsx scripts/create-order.ts \
  --kind buy \
  --currency EUR \
  --fiat-amount 100 \
  --payment-method "SEPA" \
  --invoice user@walletofsatoshi.com
```

#### create-order.ts Options

| Flag | Required | Description |
|------|----------|-------------|
| `--kind` | ✅ | `buy` or `sell` |
| `--currency` | ✅ | Fiat currency code (USD, EUR, ARS, VES, CUP, etc.) |
| `--fiat-amount` | ✅ | Fiat amount (use `0` for range orders) |
| `--payment-method` | ✅ | Payment method(s), comma-separated |
| `--premium` | ❌ | Premium/discount percentage over market price (default: 0) |
| `--amount` | ❌ | Fixed sats amount (default: 0 = market price from API) |
| `--min-amount` | ❌ | Minimum fiat amount (range orders only) |
| `--max-amount` | ❌ | Maximum fiat amount (range orders only) |
| `--invoice` | ❌ | Lightning address for buy orders (e.g., `user@ln.tips`) |

### Taking Orders

```bash
# Take a sell order (you're buying BTC)
npx tsx scripts/take-order.ts \
  --order-id "c7dba9db-f13f-4c3f-a77f-3b82e43c2b1a" \
  --action take-sell \
  --invoice "lnbc50u1p..."

# Take a sell order with Lightning address
npx tsx scripts/take-order.ts \
  --order-id "c7dba9db-f13f-4c3f-a77f-3b82e43c2b1a" \
  --action take-sell \
  --invoice "user@walletofsatoshi.com"

# Take a buy order (you're selling BTC)
npx tsx scripts/take-order.ts \
  --order-id "c7dba9db-f13f-4c3f-a77f-3b82e43c2b1a" \
  --action take-buy

# Take a range order (specify fiat amount)
npx tsx scripts/take-order.ts \
  --order-id "c7dba9db-f13f-4c3f-a77f-3b82e43c2b1a" \
  --action take-sell \
  --amount 15 \
  --invoice "user@ln.tips"
```

## Architecture

### Project Structure

```
mostro-skill/
├── SKILL.md                    # AI agent instructions (the "brain")
├── README.md                   # This file
├── package.json                # Dependencies
├── tsconfig.json               # TypeScript config
├── config.example.json         # Configuration template
├── docs/
│   └── IMPLEMENTATION.md       # Detailed implementation document
├── lib/                        # Core library
│   ├── config.ts               # Configuration management
│   ├── keys.ts                 # HD key derivation (BIP-32/39)
│   ├── nostr.ts                # Nostr client, NIP-59 gift wrap, NIP-44 encryption
│   ├── protocol.ts             # Mostro protocol types & message builders
│   └── safety.ts               # Trade limits, audit logging, cooldowns
├── scripts/                    # Executable tools
│   ├── get-info.ts             # Mostro instance info
│   ├── list-orders.ts          # Order book browser
│   ├── trade-status.ts         # Trade status checker
│   ├── create-order.ts         # Order creation
│   ├── take-order.ts           # Order taking
│   ├── cancel-order.ts         # Order cancellation
│   ├── add-invoice.ts          # Send LN invoice
│   ├── fiat-sent.ts            # Fiat sent confirmation
│   ├── release.ts              # Sats release
│   ├── rate-user.ts            # User rating
│   ├── dispute.ts              # Dispute opening
│   ├── dispute-chat.ts         # Dispute messaging
│   ├── restore-session.ts      # Session restore from mnemonic
│   ├── analytics.ts            # Trade history & stats
│   ├── multi-mostro.ts         # Multi-instance queries
│   └── auto-trade.ts           # Automated trading strategies
└── strategies/                 # Example strategy configs
    ├── dca-weekly.json         # DCA: $20/week
    ├── limit-buy.json          # Limit: take below -2%
    └── market-maker.json       # Market maker: ARS spread
```

### How It Works

1. **SKILL.md** tells the AI agent what tools are available and when/how to use them
2. The agent invokes **scripts** based on user intent (e.g., "buy 50 USD of BTC")
3. Scripts use the **lib/** modules to:
   - Derive HD keys from the user's mnemonic (BIP-32/39)
   - Build Mostro protocol messages
   - Wrap messages in NIP-59 gift wrap (encrypted, private)
   - Publish to Nostr relays
   - Fetch and decrypt responses from Mostro
4. Results are returned to the agent, which presents them to the user

### Key Management

Keys follow the [Mostro protocol specification](https://mostro.network/protocol/key_management.html):

- **Derivation path**: `m/44'/1237'/38383'/0/{index}`
- **Index 0**: Identity key — used for reputation tracking (signs the seal layer)
- **Index 1+**: Trade keys — one per trade, rotated for privacy
- **Mnemonic**: BIP-39 12-word phrase, stored at `~/.mostro-skill/seed`

The same mnemonic works across all Mostro clients (mobile, CLI, this skill). Import your existing mnemonic to use the same identity, or generate a new one for a separate trading profile.

### Protocol Communication

All communication with Mostro uses **NIP-59 Gift Wrap** for maximum privacy:

```
┌─────────────────────────────────────────────────────────┐
│ Gift Wrap (kind 1059)                                    │
│ Signed by: ephemeral key (random, single-use)           │
│ Encrypted to: Mostro's pubkey                           │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Seal (kind 13)                                       │ │
│ │ Signed by: identity key (index 0)                   │ │
│ │ Encrypted to: Mostro's pubkey                       │ │
│ │ ┌─────────────────────────────────────────────────┐ │ │
│ │ │ Rumor (kind 1, unsigned)                         │ │ │
│ │ │ Pubkey: trade key (index N)                     │ │ │
│ │ │ Content: [message, signature]                   │ │ │
│ │ └─────────────────────────────────────────────────┘ │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

- **Outer layer** (gift wrap): Hides the sender's identity from relays
- **Middle layer** (seal): Links the message to your identity (for reputation)
- **Inner layer** (rumor): Contains the actual Mostro protocol message

### Mostro Event Kinds

| Kind  | Type     | Description |
|-------|----------|-------------|
| 38383 | Orders   | P2P order book (addressable events with tags) |
| 38384 | Ratings  | User rating events |
| 38385 | Info     | Mostro instance status and configuration |
| 38386 | Disputes | Dispute events |
| 1059  | GiftWrap | Encrypted private messages (NIP-59) |

## Security

### Trade Limits

All trading actions are subject to configurable limits:

| Limit | Default | Description |
|-------|---------|-------------|
| `max_trade_amount_fiat` | 100 | Maximum fiat amount per single trade |
| `max_daily_volume_fiat` | 500 | Maximum total daily trading volume |
| `max_trades_per_day` | 10 | Maximum number of trades per day |
| `cooldown_seconds` | 300 | Minimum seconds between trades |
| `require_confirmation` | true | Agent must ask user before executing trades |

### Confirmation Mode

When `require_confirmation` is `true` (default), the agent will:
1. Present trade details to the user
2. Wait for explicit approval
3. Only then execute the trade

This prevents accidental or runaway trades.

### Audit Trail

Every action is logged to `~/.mostro-skill/audit.log`:

```json
{"timestamp":"2025-02-16T06:00:00.000Z","action":"create-order","fiat_amount":50,"fiat_code":"USD","result":"success","order_id":"c7dba9db-..."}
{"timestamp":"2025-02-16T06:05:00.000Z","action":"take-order","order_id":"751bc178-...","result":"success","details":"take-sell"}
```

### Threat Mitigations

| Threat | Mitigation |
|--------|------------|
| **Prompt injection** via order descriptions | All order text sanitized before display |
| **Price manipulation** | Order premium compared against market API; deviations flagged |
| **Key exfiltration** | Keys never appear in logs or error messages |
| **Runaway trading** | Daily volume limits, trade count limits, cooldown periods |
| **Stale data attacks** | Fresh order data fetched before every action |

## For AI Agent Platforms

### OpenClaw

Install as a skill:
```bash
# Copy to your workspace skills directory
cp -r mostro-skill ~/.openclaw/workspace/skills/mostro-trading
```

Or install from ClawHub (coming soon):
```bash
clawhub install mostro-trading
```

### Other Platforms

The skill follows the standard skill format:
- `SKILL.md` — Natural language instructions for the agent
- `scripts/` — Executable tools the agent can invoke
- `config.json` — User configuration

Any AI platform that can read instructions and execute shell commands can use this skill.

## Implementation Phases

| Phase | Status | Description |
|-------|--------|-------------|
| **Phase 1**: Foundation | ✅ | Skill structure, Nostr connectivity, key management, read-only tools |
| **Phase 2**: Order Creation | ✅ | Create/take/cancel orders with confirmation workflow |
| **Phase 3**: Trade Completion | ✅ | Full lifecycle (fiat-sent, release, rate, dispute) |
| **Phase 4**: Advanced | ✅ | Auto-trading, DCA, multi-Mostro, session restore, analytics, dispute chat |

See [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) for the full technical specification.

## Development

```bash
# Install dependencies
npm install

# Type check
npx tsc --noEmit

# Build (compile TypeScript)
npm run build
```

### Dependencies

| Package | Purpose |
|---------|---------|
| `nostr-tools` | Nostr protocol (events, NIP-44 encryption, NIP-59 gift wrap) |
| `@noble/hashes` | SHA-256 and other cryptographic hashes |
| `@noble/secp256k1` | Secp256k1 elliptic curve operations |
| `@scure/bip32` | HD key derivation (BIP-32) |
| `@scure/bip39` | Mnemonic phrase generation/validation (BIP-39) |
| `uuid` | UUID generation for order IDs and request IDs |

## Related Projects

- [Mostro](https://github.com/MostroP2P/mostro) — The Mostro daemon (Rust)
- [Mostro Mobile](https://github.com/MostroP2P/mobile) — Mobile client (Flutter)
- [mostro-cli](https://github.com/MostroP2P/mostro-cli) — Command-line client (Rust)
- [Mostro Protocol](https://mostro.network/protocol/) — Protocol specification
- [OpenClaw](https://openclaw.ai) — AI agent platform with skill support

## Contributing

Contributions welcome! Areas where help is needed:

- **Testing against real Mostro instances** (testnet/signet)
- **Auto-trading strategies** (DCA, market making, arbitrage)
- **MCP server wrapper** for Model Context Protocol compatibility
- **Additional AI platform integrations**
- **Improved key encryption** (scrypt + AES-256-GCM)

## License

[MIT](LICENSE)
