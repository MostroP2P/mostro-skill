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
| `trade-status.ts` | Check own trade status (see [Session Recovery](#session-recovery)) | `tsx scripts/trade-status.ts --order-id <uuid>` or `--all` |

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

### Advanced Tools

| Script | Description | Example |
|--------|-------------|---------|
| `add-invoice.ts` | Send LN invoice after taking a sell order | `tsx scripts/add-invoice.ts --order-id <uuid> --invoice <lnbc...>` |
| `dispute-chat.ts` | Send messages during a dispute | `tsx scripts/dispute-chat.ts --order-id <uuid> --message "proof attached"` |
| `restore-session.ts` | Import mnemonic and restore active orders | `tsx scripts/restore-session.ts --mnemonic "word1 word2 ..."` |
| `analytics.ts` | Trade history and statistics | `tsx scripts/analytics.ts` or `--recent 10` or `--csv` |
| `multi-mostro.ts` | Query multiple Mostro instances | `tsx scripts/multi-mostro.ts --currency USD --kind sell --best` |
| `auto-trade.ts` | Automated trading strategies | `tsx scripts/auto-trade.ts --strategy strategies/dca-weekly.json [--dry-run]` |

### auto-trade.ts Strategies

| Strategy | Config Example | Description |
|----------|---------------|-------------|
| DCA | `strategies/dca-weekly.json` | Buy/sell fixed amount at regular intervals |
| Limit | `strategies/limit-buy.json` | Take orders matching specific criteria (premium, rating) |
| Market Maker | `strategies/market-maker.json` | Maintain buy and sell orders with a spread |

All strategies support `--dry-run` for testing. Set `"enabled": true` in the strategy JSON to activate.

### analytics.ts Options

| Flag | Description | Example |
|------|-------------|---------|
| `--recent N` | Show last N audit entries | `--recent 10` |
| `--csv` | Export all trades to CSV file | `--csv` |
| `--days N` | Stats for last N days only | `--days 30` |
| `--output` | Output file for CSV export | `--output trades.csv` |

### multi-mostro.ts Options

| Flag | Description | Example |
|------|-------------|---------|
| `--currency` | Filter by fiat currency | `--currency USD` |
| `--kind` | Filter by order type | `--kind sell` |
| `--best` | Show only the single best order | `--best` |
| `--list-instances` | List configured Mostro instances | `--list-instances` |

Configure multiple instances in `config.json` under `mostro_instances` array.

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

### Session Recovery

Mostro uses ephemeral trade keys derived from your seed (BIP-32). If you lose your session (app crash, restart, new device), you can recover your active orders using `trade-status.ts --all`, which sends a `restore-session` message to Mostro.

**How it works:**

1. Your identity is tied to your seed mnemonic (saved at `~/.mostro-skill/seed`)
2. Mostro tracks which trade keys belong to which orders
3. `restore-session` asks Mostro to return all orders and disputes associated with your trade key

**Usage:**

```bash
# Recover all active orders and disputes after losing session
tsx scripts/trade-status.ts --all

# Check a specific order by ID (if you still have it)
tsx scripts/trade-status.ts --order-id <uuid>
```

**What you get back:**
- Active orders with their identifier (`id` per protocol docs, `order_id` in some server versions), `status`, and `trade_index`
- Active disputes with `dispute_id`, `order_id`, and `status`

**Important notes:**
- The seed mnemonic is your only way to recover. **Back it up!**
- Mostro returns all non-finalized orders for the requesting trade key. Currently the client sends the restore request using trade index 1 only (`keys.getTradeKeys(1)`), so only orders created with that trade key are returned. This is a client-side limitation, not a Mostro server restriction.
- `trade_index` and `request_id` are optional fields in the protocol (see [protocol overview](https://mostro.network/protocol/overview.html))
- Orders in terminal states (completed, expired) are not returned
- If you imported a mnemonic via `restore-session.ts`, use `--all` to verify your orders were recovered
- See the [official restore-session docs](https://mostro.network/protocol/restore_session.html) for full protocol details

### request_id

The `request_id` field is **optional** in all Mostro protocol messages. When included in a request, Mostro may echo it back in the response to allow correlation. However:
- Not all Mostro versions echo `request_id` in responses
- Clients should not rely on `request_id` being present in responses
- When filtering responses, fall back to matching by action type if no `request_id` match is found

See `docs/IMPLEMENTATION.md` for full protocol details.
