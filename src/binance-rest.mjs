// Minimal Binance Spot REST adapter for the Qevor autopilot path.
// Credentials are read only on the server. This module never exposes them to
// the browser and keeps writes disabled unless an explicit runtime gate is on.

import { createHmac, randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

export const BINANCE_REST_BASE_URL = process.env.BINANCE_REST_BASE_URL || "https://api.binance.com";

function formEncode(params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") body.set(key, String(value));
  }
  return body.toString();
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 500) }; }
}

export class BinanceRestError extends Error {
  constructor(message, code = "BINANCE_REST_ERROR", details = null) {
    super(message);
    this.name = "BinanceRestError";
    this.code = code;
    this.details = details;
  }
}

export class BinanceRestClient {
  constructor({
    apiKey = process.env.BINANCE_API_KEY,
    apiSecret = process.env.BINANCE_API_SECRET,
    baseUrl = BINANCE_REST_BASE_URL,
    fetchImpl = fetch,
    now = () => Date.now(),
    stopFile = process.env.BINANCE_EMERGENCY_STOP_FILE || "/opt/apex-agent/AUTOPILOT_STOP"
  } = {}) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.stopFile = stopFile;
  }

  get configured() {
    return Boolean(this.apiKey && this.apiSecret);
  }

  get writesEnabled() {
    return this.autopilotEnabled && this.policyConfigured;
  }

  get autopilotEnabled() {
    return process.env.BINANCE_AUTOPILOT_ENABLED === "true" &&
      process.env.BINANCE_REST_WRITES === "true" &&
      !this.emergencyStopped;
  }

  get emergencyStopped() {
    return existsSync(this.stopFile);
  }

  get maxOrderNotional() {
    const value = Number(process.env.BINANCE_MAX_ORDER_NOTIONAL_USDT);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  get allowedSymbols() {
    return (process.env.BINANCE_ALLOWED_SYMBOLS || "")
      .split(",")
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean);
  }

  get policyConfigured() {
    return this.maxOrderNotional !== null && this.allowedSymbols.length > 0;
  }

  status() {
    return {
      configured: this.configured,
      base_url: this.baseUrl,
      account_scope: this.configured ? "configured" : "missing_credentials",
      autopilot_enabled: this.autopilotEnabled,
      emergency_stopped: this.emergencyStopped,
      policy_configured: this.policyConfigured,
      max_order_notional_usdt: this.maxOrderNotional,
      allowed_symbols: this.allowedSymbols,
      writes_enabled: this.writesEnabled,
      withdrawal_scope: "not_requested_by_adapter",
      blocker: !this.configured
        ? "BINANCE_API_KEY and BINANCE_API_SECRET are not configured"
        : this.emergencyStopped
          ? "Emergency stop marker is active; remove it manually after review"
          : !this.policyConfigured
            ? "Autopilot requires BINANCE_MAX_ORDER_NOTIONAL_USDT and BINANCE_ALLOWED_SYMBOLS"
            : !this.autopilotEnabled
              ? "REST writes are disabled; read-only account checks remain available"
          : "Autopilot writes enabled only after Guardian integration and explicit policy review"
    };
  }

  async executionContext(symbol) {
    const context = {
      accountBound: false,
      writesEnabled: false,
      autopilotEnabled: false,
      pendingOrder: false,
      maxOrderNotional: this.maxOrderNotional,
      allowedSymbols: this.allowedSymbols
    };
    if (!this.configured) return context;
    try {
      const account = await this.getAccount();
      const orders = await this.getOpenOrders(symbol);
      return {
        ...context,
        accountBound: account.canTrade !== false,
        writesEnabled: this.writesEnabled,
        autopilotEnabled: this.autopilotEnabled,
        pendingOrder: Array.isArray(orders) && orders.length > 0
      };
    } catch {
      return context;
    }
  }

  activateEmergencyStop() {
    writeFileSync(this.stopFile, `APEX emergency stop ${new Date().toISOString()}\n`, { mode: 0o600 });
    return { stopped: true, stop_file: this.stopFile };
  }

  requireCredentials() {
    if (!this.configured) {
      throw new BinanceRestError("Binance REST credentials are not configured", "NOT_CONFIGURED");
    }
  }

  async request(path, { method = "GET", params = {}, signed = false } = {}) {
    if (signed) this.requireCredentials();

    const values = { ...params };
    if (signed) values.timestamp = this.now();
    let encoded = formEncode(values);
    if (signed) {
      values.signature = createHmac("sha256", this.apiSecret).update(encoded).digest("hex");
      encoded = formEncode(values);
    }

    const url = `${this.baseUrl}${path}${method === "GET" && encoded ? `?${encoded}` : ""}`;
    const headers = { Accept: "application/json" };
    if (this.apiKey) headers["X-MBX-APIKEY"] = this.apiKey;
    const init = {
      method,
      signal: AbortSignal.timeout(15_000),
      headers
    };
    if (method !== "GET") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      init.body = encoded;
    }

    let response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      throw new BinanceRestError(`Binance REST request failed: ${error.message}`, "NETWORK_ERROR");
    }
    const text = await response.text();
    const payload = safeJson(text);
    if (!response.ok) {
      const code = payload?.code === -2015 ? "INVALID_API_KEY" : "BINANCE_HTTP_ERROR";
      throw new BinanceRestError(`Binance REST returned HTTP ${response.status}`, code, payload);
    }
    return payload;
  }

  async getAccount() {
    return this.request("/api/v3/account", { signed: true });
  }

  async getOpenOrders(symbol = null) {
    return this.request("/api/v3/openOrders", { signed: true, params: symbol ? { symbol } : {} });
  }

  async getOrderStatus({ symbol, orderId, origClientOrderId } = {}) {
    if (!symbol || (!orderId && !origClientOrderId)) {
      throw new BinanceRestError("Order status requires symbol and orderId or origClientOrderId", "INVALID_ORDER_QUERY");
    }
    return this.request("/api/v3/order", {
      signed: true,
      params: { symbol, orderId, origClientOrderId }
    });
  }

  async placeMarketOrder({ symbol, side, quantity, quoteOrderQty, clientOrderId = randomUUID() } = {}) {
    if (!this.writesEnabled) {
      throw new BinanceRestError("Binance REST writes are disabled", "WRITES_DISABLED");
    }
    if (!symbol || !["BUY", "SELL"].includes(side) || (!quantity && !quoteOrderQty)) {
      throw new BinanceRestError("A market order requires symbol, BUY/SELL side, and quantity or quoteOrderQty", "INVALID_ORDER");
    }
    return this.request("/api/v3/order", {
      method: "POST",
      signed: true,
      params: {
        symbol,
        side,
        type: "MARKET",
        quantity,
        quoteOrderQty,
        newClientOrderId: clientOrderId,
        newOrderRespType: "ACK"
      }
    });
  }

  async placeCandidate(candidate) {
    if (!candidate?.symbol || !["LONG", "SHORT"].includes(candidate.side)) {
      throw new BinanceRestError("Candidate is not a supported APEX order", "INVALID_ORDER");
    }
    if (!this.allowedSymbols.includes(candidate.symbol)) {
      throw new BinanceRestError("Candidate symbol is outside the autopilot allowlist", "SYMBOL_NOT_ALLOWED");
    }
    const notional = Number(candidate.qty) * Number(candidate.entryPrice);
    if (!Number.isFinite(notional) || notional <= 0 || notional > this.maxOrderNotional) {
      throw new BinanceRestError("Candidate exceeds the configured order-notional cap", "ORDER_NOTIONAL_LIMIT");
    }
    return this.placeMarketOrder({
      symbol: candidate.symbol,
      side: candidate.side === "LONG" ? "BUY" : "SELL",
      quantity: candidate.qty
    });
  }

  async cancelOrder({ symbol, orderId, origClientOrderId } = {}) {
    if (!this.writesEnabled) {
      throw new BinanceRestError("Binance REST writes are disabled", "WRITES_DISABLED");
    }
    if (!symbol || (!orderId && !origClientOrderId)) {
      throw new BinanceRestError("Cancel requires symbol and orderId or origClientOrderId", "INVALID_ORDER_QUERY");
    }
    return this.request("/api/v3/order", {
      method: "DELETE",
      signed: true,
      params: { symbol, orderId, origClientOrderId }
    });
  }
}

export function createBinanceRestClient(options = {}) {
  return new BinanceRestClient(options);
}
