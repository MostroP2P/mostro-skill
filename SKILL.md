# mostro-trading

Trade Bitcoin P2P on [Mostro](https://mostro.network) — a censorship-resistant exchange over Lightning Network and Nostr.

## When to Use

Use this skill when the user wants to:
- Buy or sell Bitcoin peer-to-peer
- View available P2P orders on Mostro
- Check Mostro exchange info (fees, limits, currencies)
- Manage trades (create, take, cancel, confirm, dispute)
- Check trade status or history

## Setup

1. Install dependencies: `cd <skill-dir> && npm install`
2. Copy `config.example.json` to `config.json`
3. Set `mostro_pubkey` to the hex public key of the target Mostro instance
4. Optionally adjust relays, limits, and other settings

Keys are auto-generated on first use (BIP-39 mnemonic). The mnemonic is saved to `~/.mostro-skill/seed`. **Back it up!**

## Tools

All scripts are in `scripts/` and run with `tsx`:

### Read-Only (Safe)

| Script | Description | Example |
|--------|-------------|---------|
| `get-info.ts` | Mostro instance info (version, fees, currencies, limits) | `tsx scripts/get-info.ts` |
| `list-orders.ts` | List order book | `tsx scripts/list-orders.ts --currency USD --kind sell --status pending` |
| `trade-status.ts` | Check own trade status | `tsx scripts/trade-status.ts --order-id <uuid>` or `--all` |

### Trading (Requires Confirmation)

| Script | Description | Example |
|--------|-------------|---------|
| `create-order.ts` | Create buy/sell order | `tsx scripts/create-order.ts --kind buy --currency USD --fiat-amount 50 --payment-method "bank transfer"` |
| `take-order.ts` | Take an existing order | `tsx scripts/take-order.ts --order-id <uuid> --action take-sell --invoice <lnbc...>` |
| `cancel-order.ts` | Cancel own order | `tsx scripts/cancel-order.ts --order-id <uuid>` |
| `fiat-sent.ts` | Buyer confirms fiat sent | `tsx scripts/fiat-sent.ts --order-id <uuid>` |
| `release.ts` | Seller releases sats | `tsx scripts/release.ts --order-id <uuid>` |
| `rate-user.ts` | Rate counterparty (1-5) | `tsx scripts/rate-user.ts --order-id <uuid> --rating 5` |
| `dispute.ts` | Open a dispute | `tsx scripts/dispute.ts --order-id <uuid>` |

### create-order.ts Options

| Flag | Required | Description |
|------|----------|-------------|
| `--kind` | ✅ | `buy` or `sell` |
| `--currency` | ✅ | Fiat currency code (USD, EUR, ARS, VES, etc.) |
| `--fiat-amount` | ✅ | Amount in fiat (set 0 for range orders) |
| `--payment-method` | ✅ | Payment method (e.g., "bank transfer", "face to face") |
| `--premium` | ❌ | Premium percentage (default: 0) |
| `--amount` | ❌ | Fixed sats amount (default: 0 = market price) |
| `--min-amount` | ❌ | Min fiat for range orders |
| `--max-amount` | ❌ | Max fiat for range orders |
| `--invoice` | ❌ | Lightning address for buy orders (e.g., user@ln.tips) |

### take-order.ts Options

| Flag | Required | Description |
|------|----------|-------------|
| `--order-id` | ✅ | UUID of the order to take |
| `--action` | ✅ | `take-sell` (buyer) or `take-buy` (seller) |
| `--invoice` | ❌ | LN invoice or address (for take-sell) |
| `--amount` | ❌ | Fiat amount (required for range orders) |

## Trade Flow

### Buying BTC
1. `list-orders.ts --kind sell --currency USD` — Find sell orders
2. `take-order.ts --order-id <id> --action take-sell --invoice <lnbc...>` — Take order
3. Wait for seller to pay hold invoice
4. Send fiat payment to seller via agreed method
5. `fiat-sent.ts --order-id <id>` — Confirm fiat sent
6. Wait for seller to release sats → you receive BTC!
7. `rate-user.ts --order-id <id> --rating 5` — Rate the seller

### Selling BTC
1. `create-order.ts --kind sell --currency USD --fiat-amount 50 --payment-method "bank transfer"` — Create sell order
2. Wait for buyer to take the order
3. Pay the hold invoice Mostro sends you
4. Wait for buyer to confirm fiat sent
5. Verify fiat received in your account
6. `release.ts --order-id <id>` — Release sats to buyer
7. `rate-user.ts --order-id <id> --rating 5` — Rate the buyer

## Safety

- **Confirmation mode** is ON by default — always present trade details to the user and ask for explicit approval before executing
- **Trade limits** are configured in `config.json` (max amount, daily volume, cooldown)
- **Audit log** at `~/.mostro-skill/audit.log` records all actions
- **Never** log or expose private keys or mnemonics
- When in doubt about a trade, advise the user to verify manually

## Configuration

Edit `config.json`:

```json
{
  "mostro_pubkey": "<hex pubkey>",
  "relays": ["wss://relay.mostro.network"],
  "network": "mainnet",
  "limits": {
    "max_trade_amount_fiat": 100,
    "max_daily_volume_fiat": 500,
    "max_trades_per_day": 10,
    "cooldown_seconds": 300,
    "require_confirmation": true
  }
}
```

## Protocol Reference

Mostro uses Nostr events for communication:
- **Kind 38383**: Order book (addressable events with tags for filtering)
- **Kind 38385**: Mostro instance info
- **Kind 38386**: Disputes
- **Kind 1059**: Gift wrap messages (NIP-59) for private communication

All messages are encrypted using NIP-44 and wrapped in NIP-59 gift wrap for privacy.

See `docs/IMPLEMENTATION.md` for full protocol details.
