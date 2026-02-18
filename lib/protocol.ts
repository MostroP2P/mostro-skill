/**
 * Mostro Protocol Types and Message Builders
 *
 * Implements the Mostro protocol as documented at https://mostro.network/protocol/
 * All messages are wrapped in NIP-59 gift wrap events.
 */

// ─── Enums ──────────────────────────────────────────────────────────────────

export type OrderKind = "buy" | "sell";

export type OrderStatus =
  | "pending"
  | "canceled"
  | "canceled-by-admin"
  | "settled-by-admin"
  | "completed-by-admin"
  | "dispute"
  | "expired"
  | "fiat-sent"
  | "settled-hold-invoice"
  | "success"
  | "waiting-buyer-invoice"
  | "waiting-payment"
  | "cooperatively-canceled"
  | "in-progress"
  | "active";

export type Action =
  | "new-order"
  | "take-sell"
  | "take-buy"
  | "pay-invoice"
  | "fiat-sent"
  | "fiat-sent-ok"
  | "release"
  | "released"
  | "cancel"
  | "canceled"
  | "cooperative-cancel-initiated-by-you"
  | "cooperative-cancel-initiated-by-peer"
  | "cooperative-cancel-accepted"
  | "dispute"
  | "dispute-initiated-by-you"
  | "dispute-initiated-by-peer"
  | "buyer-invoice-accepted"
  | "purchase-completed"
  | "hold-invoice-payment-accepted"
  | "hold-invoice-payment-settled"
  | "hold-invoice-payment-canceled"
  | "waiting-seller-to-pay"
  | "waiting-buyer-invoice"
  | "add-invoice"
  | "buyer-took-order"
  | "rate"
  | "rate-user"
  | "rate-received"
  | "cant-do"
  | "admin-cancel"
  | "admin-canceled"
  | "admin-settle"
  | "admin-settled"
  | "admin-add-solver"
  | "admin-take-dispute"
  | "admin-took-dispute"
  | "payment-failed"
  | "invoice-updated"
  | "send-dm"
  | "trade-pubkey"
  | "restore-session"
  | "last-trade-index"
  | "orders";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SmallOrder {
  id?: string;
  kind?: OrderKind;
  status?: OrderStatus;
  amount: number;
  fiat_code: string;
  min_amount?: number | null;
  max_amount?: number | null;
  fiat_amount: number;
  payment_method: string;
  premium: number;
  buyer_trade_pubkey?: string | null;
  seller_trade_pubkey?: string | null;
  buyer_invoice?: string | null;
  created_at?: number | null;
  expires_at?: number | null;
}

export interface Peer {
  pubkey: string;
  reputation?: {
    total_reviews: number;
    total_rating: number;
    last_rating: number;
    max_rate: number;
    min_rate: number;
  } | null;
}

export interface CantDoReason {
  // Mostro sends reason as a string enum
  [key: string]: unknown;
}

export interface PaymentFailedInfo {
  payment_attempts: number;
  payment_retries_interval: number;
}

export interface RestoreData {
  orders: Array<{ id: string; trade_index: number; status: string }>;
  disputes: Array<{
    dispute_id: string;
    order_id: string;
    trade_index: number;
    status: string;
  }>;
}

// Payload types
export type Payload =
  | { order: SmallOrder }
  | { payment_request: [SmallOrder | null, string, number | null] }
  | { text_message: string }
  | { peer: Peer }
  | { rating_user: number }
  | { amount: number }
  | { dispute: string }
  | { cant_do: CantDoReason | null }
  | { next_trade: [string, number] }
  | { payment_failed: PaymentFailedInfo }
  | { restore_data: RestoreData }
  | { ids: string[] }
  | { orders: SmallOrder[] }
  | null;

export interface MessageKind {
  version: number;
  id?: string;
  request_id?: number;
  trade_index?: number;
  action: Action;
  payload?: Payload;
}

// The top-level message wrapper
export type Message =
  | { order: MessageKind }
  | { dispute: MessageKind }
  | { cant_do: MessageKind }
  | { rate: MessageKind }
  | { dm: MessageKind }
  | { restore: MessageKind };

// Content of rumor: [Message, signature | null]
export type RumorContent = [Message, string | null];

// ─── Message Builders ───────────────────────────────────────────────────────

/**
 * Build an order message (most common message type)
 */
export function buildOrderMessage(
  action: Action,
  orderId?: string,
  requestId?: number,
  tradeIndex?: number,
  payload?: Payload
): Message {
  const kind: MessageKind = {
    version: 1,
    action,
    ...(orderId && { id: orderId }),
    ...(requestId !== undefined && { request_id: requestId }),
    ...(tradeIndex !== undefined && { trade_index: tradeIndex }),
    ...(payload !== undefined && payload !== null && { payload }),
  };
  return { order: kind };
}

/**
 * Build a restore message
 */
export function buildRestoreMessage(
  action: "restore-session" | "last-trade-index",
  payload?: Payload
): Message {
  const kind: MessageKind = {
    version: 1,
    action,
    ...(payload !== undefined && payload !== null && { payload }),
  };
  return { restore: kind };
}

/**
 * Build a DM message
 */
export function buildDmMessage(text: string): Message {
  const kind: MessageKind = {
    version: 1,
    action: "send-dm",
    payload: { text_message: text },
  };
  return { dm: kind };
}

/**
 * Build a new order payload
 */
export function buildNewOrderPayload(params: {
  kind: OrderKind;
  fiat_code: string;
  fiat_amount: number;
  amount?: number;
  min_amount?: number;
  max_amount?: number;
  payment_method: string;
  premium?: number;
  buyer_invoice?: string;
}): Payload {
  const order: SmallOrder = {
    kind: params.kind,
    status: "pending",
    amount: params.amount ?? 0,
    fiat_code: params.fiat_code.toUpperCase(),
    fiat_amount: params.fiat_amount,
    min_amount: params.min_amount ?? null,
    max_amount: params.max_amount ?? null,
    payment_method: params.payment_method,
    premium: params.premium ?? 0,
    buyer_invoice: params.buyer_invoice ?? null,
    created_at: 0,
  };
  return { order };
}

// ─── Response Parsing ───────────────────────────────────────────────────────

/**
 * Extract the inner MessageKind from a Message
 */
export function getInnerMessageKind(msg: Message): MessageKind {
  if ("order" in msg) return msg.order;
  if ("dispute" in msg) return msg.dispute;
  if ("cant-do" in msg) return (msg as any)["cant-do"];
  if ("cant_do" in msg) return msg.cant_do;
  if ("rate" in msg) return msg.rate;
  if ("dm" in msg) return msg.dm;
  if ("restore" in msg) return msg.restore;
  // Skip unknown message types instead of crashing
  console.warn(`⚠️ Skipping unknown message type: ${Object.keys(msg).join(", ")}`);
  return { version: 1, action: "unknown", payload: null } as any;
}

/**
 * Filter gift wrap responses by request_id to avoid processing stale responses.
 * Returns only responses matching the given requestId, or falls back to the
 * most recent response if no match is found.
 */
export function filterResponsesByRequestId(
  responses: Array<{ message: Message; signature: string | null; timestamp: number }>,
  requestId: number
): Array<{ message: Message; signature: string | null; timestamp: number }> {
  const matching = responses.filter((resp) => {
    const kind = getInnerMessageKind(resp.message);
    return kind.request_id === requestId;
  });
  // If no match, return empty — don't fallback to stale responses
  return matching;
}

/**
 * Parse a rumor content string into [Message, signature]
 */
export function parseRumorContent(content: string): RumorContent {
  const parsed = JSON.parse(content);
  if (Array.isArray(parsed) && parsed.length >= 1) {
    return [parsed[0] as Message, (parsed[1] as string) ?? null];
  }
  // Some messages are not wrapped in array
  return [parsed as Message, null];
}

// ─── Order Event Parsing ────────────────────────────────────────────────────

export interface ParsedOrderEvent {
  id: string;
  kind: OrderKind;
  currency: string;
  status: OrderStatus;
  amount: number;
  fiat_amount: string;
  payment_methods: string[];
  premium: number;
  rating?: string;
  network: string;
  layer: string;
  platform: string;
  expires_at?: number;
}

/**
 * Parse an order event (kind 38383) from its tags
 */
export function parseOrderEvent(tags: string[][]): ParsedOrderEvent {
  const tagMap = new Map<string, string[]>();
  for (const tag of tags) {
    tagMap.set(tag[0], tag.slice(1));
  }

  return {
    id: tagMap.get("d")?.[0] ?? "",
    kind: (tagMap.get("k")?.[0] as OrderKind) ?? "buy",
    currency: tagMap.get("f")?.[0] ?? "",
    status: (tagMap.get("s")?.[0] as OrderStatus) ?? "pending",
    amount: parseInt(tagMap.get("amt")?.[0] ?? "0", 10),
    fiat_amount: tagMap.get("fa")?.[0] ?? "0",
    payment_methods: tagMap.get("pm") ?? [],
    premium: parseInt(tagMap.get("premium")?.[0] ?? "0", 10),
    rating: tagMap.get("rating")?.[0],
    network: tagMap.get("network")?.[0] ?? "mainnet",
    layer: tagMap.get("layer")?.[0] ?? "lightning",
    platform: tagMap.get("y")?.[0] ?? "mostro",
    expires_at: tagMap.get("expires_at")?.[0]
      ? parseInt(tagMap.get("expires_at")![0], 10)
      : undefined,
  };
}

// ─── Mostro Info Event Parsing ──────────────────────────────────────────────

export interface MostroInfo {
  pubkey: string;
  version: string;
  commit_hash: string;
  max_order_amount: number;
  min_order_amount: number;
  expiration_hours: number;
  expiration_seconds: number;
  fiat_currencies: string[];
  fee: number;
  pow: number;
  max_orders_per_response?: number;
}

/**
 * Parse a Mostro info event (kind 38385) from its tags
 */
export function parseMostroInfoEvent(
  pubkey: string,
  tags: string[][]
): MostroInfo {
  const tagMap = new Map<string, string>();
  for (const tag of tags) {
    if (tag.length >= 2) {
      tagMap.set(tag[0], tag[1]);
    }
  }

  return {
    pubkey,
    version: tagMap.get("mostro_version") ?? "unknown",
    commit_hash: tagMap.get("mostro_commit_hash") ?? "unknown",
    max_order_amount: parseInt(tagMap.get("max_order_amount") ?? "0", 10),
    min_order_amount: parseInt(tagMap.get("min_order_amount") ?? "0", 10),
    expiration_hours: parseInt(tagMap.get("expiration_hours") ?? "0", 10),
    expiration_seconds: parseInt(tagMap.get("expiration_seconds") ?? "0", 10),
    fiat_currencies: (tagMap.get("fiat_currencies_accepted") ?? "").split(","),
    fee: parseFloat(tagMap.get("fee") ?? "0"),
    pow: parseInt(tagMap.get("pow") ?? "0", 10),
    max_orders_per_response: tagMap.get("max_orders_per_response")
      ? parseInt(tagMap.get("max_orders_per_response")!, 10)
      : undefined,
  };
}
