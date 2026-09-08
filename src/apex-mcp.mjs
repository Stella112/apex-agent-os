// APEX decision-layer MCP server.
//
// APEX is intentionally a second MCP server beside Binance's official MCP.
// Binance MCP owns account authorization and execution. APEX owns analysis,
// debate, portfolio policy, and the independent Guardian. This module contains
// only the transport and tool contract; the host supplies the actual handlers.

export const APEX_MCP_PROTOCOL_VERSION = "2025-06-18";

export const APEX_MCP_TOOLS = [
  {
    name: "apex_status",
    description:
      "Use automatically at the start of a plain-language APEX request. Return runtime, provider, provenance, and execution-safety status. Read-only; users do not need to name this tool.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "apex_find_opportunities",
    description:
      "When a user asks to find, scan, compare, or explain promising Binance markets, scan live public Binance data for indicative funding and momentum opportunities. Infer symbols from the user's words when possible; do not ask the user to write tool arguments. Read-only; never places orders.",
    inputSchema: {
      type: "object",
      properties: {
        symbols: {
          type: "array",
          items: { type: "string", pattern: "^[A-Z0-9._-]{2,30}$" },
          maxItems: 12,
          description: "Binance symbols such as BTCUSDT and ETHUSDT."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "apex_news_sentiment",
    description:
      "Automatically collect current matched news and sentiment when it could change the explanation of a Binance opportunity or proposed trade. Evidence only; not a trade instruction.",
    inputSchema: {
      type: "object",
      properties: {
        symbols: {
          type: "array",
          items: { type: "string", pattern: "^[A-Z0-9._-]{2,30}$" },
          maxItems: 8
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "apex_review_trade",
    description:
      "When a user asks whether a Binance trade or opportunity is worth considering, run the full APEX council: Bull, Bear, Constitution Referee, and Guardian. Translate plain language into the required book and proposal fields, asking only for genuinely missing essentials. It never submits or signs an order.",
    inputSchema: {
      type: "object",
      required: ["book", "proposal"],
      properties: {
        book: {
          type: "object",
          description: "The caller's current portfolio/book."
        },
        sessionOpeningEquity: { type: 'number', exclusiveMinimum: 0, description: 'Actual session opening equity in USDT for the loss gate.' },
        proposal: {
          type: "object",
          description: "The proposed Binance order and exact terms."
        },
        thesis: {
          type: "object",
          description: "Optional thesis fields used by the two analysts."
        },
        binance_market_data: {
          type: "object",
          description:
            "Reserved for future imported evidence. Currently not used: review fetches public Binance market data itself."
        }
      },
      additionalProperties: false
    }
  }
];

function jsonRpcError(id, code, message, data = undefined) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

function textResult(value) {
  const text = JSON.stringify(value);
  return {
    content: [{ type: "text", text }],
    structuredContent: value
  };
}

export async function handleApexMcp(message, handlers = {}) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return jsonRpcError(null, -32600, "Invalid JSON-RPC request");
  }

  const { id = null, method, params = {} } = message;
  if (message.jsonrpc !== "2.0" || typeof method !== "string") {
    return jsonRpcError(id, -32600, "Invalid JSON-RPC request");
  }

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return null;
  }
  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: ['2024-11-05','2025-03-26','2025-06-18'].includes(params?.protocolVersion) ? params.protocolVersion : APEX_MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "apex-decision-layer", version: "0.3.0" },
        instructions:
          "APEX is read-only. Give users a plain-language interface: infer whether they want a market scan, news context, or a full trade review and call the appropriate APEX tools automatically. For a full review, show Bull, Bear, Constitution Referee, and Guardian separately. Do not ask users to name tools, write JSON, or provide technical tool arguments. Ask only for missing information that is essential to a specific review. Keep Binance account authorization and order execution in the official Binance MCP server."
      }
    };
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: APEX_MCP_TOOLS } };
  }
  if (method !== "tools/call") {
    return jsonRpcError(id, -32601, "Method not found: " + method);
  }

  const name = params?.name;
  if (typeof name !== "string") {
    return jsonRpcError(id, -32602, "tools/call requires a tool name");
  }
  const tool = APEX_MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return jsonRpcError(id, -32602, "Unknown APEX tool: " + name);
  const args = params.arguments ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args)) return jsonRpcError(id, -32602, "arguments must be an object");
  if (Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties, key))) return jsonRpcError(id, -32602, "Unknown argument");
  if ((tool.inputSchema.required ?? []).some(key => !Object.hasOwn(args, key))) return jsonRpcError(id, -32602, "Missing required argument");
  if (args.symbols !== undefined && (!Array.isArray(args.symbols) || !args.symbols.length || args.symbols.length > tool.inputSchema.properties.symbols.maxItems || args.symbols.some(s => typeof s !== "string" || !/^[A-Z0-9._-]{2,30}$/.test(s)))) return jsonRpcError(id, -32602, "Invalid symbols");
  const handler = handlers[name];
  if (typeof handler !== "function") {
    return jsonRpcError(id, -32603, "APEX tool is not configured: " + name);
  }

  try {
    const value = await handler(
      params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
        ? params.arguments
        : {}
    );
    return { jsonrpc: "2.0", id, result: textResult(value) };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({
          error: error.code ?? "APEX_TOOL_FAILED",
          detail: error.message
        }) }]
      }
    };
  }
}
