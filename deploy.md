# Deploying APEX

APEX is a single Node process with no dependencies, no database and no secrets. It needs
outbound HTTPS to Binance's public market endpoints and nothing else.

## What it does and does not need

- **No API keys.** Every Binance endpoint it reads is public.
- **No database.** Journals live in memory for the length of a cycle.
- **No inbound secrets.** Nothing a visitor types is stored.

## Run it directly

```bash
HOST=0.0.0.0 PORT=4173 node server.mjs
```

## Run it in Docker

```bash
docker build -t apex .
docker run -p 4173:4173 apex
```

## Behind a reverse proxy

Serve it over TLS. A minimal nginx location block:

```nginx
location / {
    proxy_pass http://127.0.0.1:4173;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

## Network requirement

The host must be able to resolve and reach `api.binance.com` and `fapi.binance.com`. APEX
resolves through a public resolver inside its own process, so a host whose system DNS blocks
those names still works. A host whose *egress IP* is geo-restricted by Binance will not: the
health endpoint will report `reachable: false` and every cycle will fail closed rather than
serve stale numbers.

Check before deploying:

```bash
curl -s https://api.binance.com/api/v3/ping
```

An empty JSON object means you are fine. A message about a restricted location means Binance
blocks that host's region, and APEX will correctly refuse to produce market data there.

## Verify a deployment

```bash
curl -s https://your-host/api/health
node bin/verify.mjs --base https://your-host
```
