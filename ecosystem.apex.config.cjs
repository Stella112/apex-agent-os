module.exports = {
  apps: [
    {
      name: "apex-agent",
      script: "server.mjs",
      cwd: "/opt/apex-agent",
      interpreter: "node",
      node_args: "--env-file=/opt/apex-agent/.env",
      env: {
        NODE_ENV: "production",
        // Qevor is a private loopback runtime; Vercel is the public read-only surface.
        // APEX is the only public listener on this port. Ollama remains on
        // 127.0.0.1:11434 and is never exposed by this process.
        HOST: "0.0.0.0",
        PORT: "4174",
        APEX_PUBLIC_READ_ONLY: process.env.APEX_PUBLIC_READ_ONLY || "false",
        OLLAMA_ENABLED: "true",
        OLLAMA_BASE_URL: "http://127.0.0.1:11434",
        OLLAMA_MODEL: "qwen2.5:1.5b",
        // Set these on the VPS after Binance OAuth client registration.
        BINANCE_OAUTH_CLIENT_ID: process.env.BINANCE_OAUTH_CLIENT_ID || "",
        BINANCE_OAUTH_REDIRECT_URI: process.env.BINANCE_OAUTH_REDIRECT_URI || "",
        BINANCE_OAUTH_SCOPES: process.env.BINANCE_OAUTH_SCOPES || "account trade",
        BINANCE_MCP_ACCESS_TOKEN: process.env.BINANCE_MCP_ACCESS_TOKEN || "",
        BINANCE_LIVE_EXECUTION: process.env.BINANCE_LIVE_EXECUTION || "false"
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      watch: false
    }
  ]
};
