// Application-level DNS resolution.
//
// Node's global fetch resolves through the operating system, which on this
// machine goes to a router that refuses to look up Binance domains. Rather than
// change the machine's network configuration, APEX resolves through a public
// resolver inside its own process. Nothing outside this program is affected.
//
// The resolver is configurable so an operator whose system DNS already works
// can leave APEX on the default path.

import https from "node:https";
import { Resolver } from "node:dns";

export const DEFAULT_DNS_SERVERS = ["1.1.1.1", "1.0.0.1"];

let resolver = null;

export function configureResolver(servers = DEFAULT_DNS_SERVERS) {
  if (!servers || servers.length === 0) {
    resolver = null;
    return null;
  }
  resolver = new Resolver();
  resolver.setServers(servers);
  return resolver;
}

// A `lookup` implementation matching Node's net.Socket contract.
//
// Node calls this either wanting a single address, or with `options.all` set
// wanting an array of {address, family} records. Returning the wrong shape
// produces a confusing ERR_INVALID_IP_ADDRESS far from the cause, so both are
// handled explicitly.
export function resolverLookup(hostname, options, callback) {
  if (!resolver) {
    // No override configured: defer to the system resolver.
    import("node:dns").then(({ default: dns }) => dns.lookup(hostname, options, callback));
    return;
  }

  resolver.resolve4(hostname, (error, addresses) => {
    if (error || !addresses || addresses.length === 0) {
      callback(error || new Error(`no A record for ${hostname}`));
      return;
    }
    if (options && options.all) {
      callback(
        null,
        addresses.map((address) => ({ address, family: 4 }))
      );
      return;
    }
    callback(null, addresses[0], 4);
  });
}

// Minimal JSON GET over HTTPS using the configured resolver.
//
// The request still uses the hostname for TLS SNI and the Host header, so
// certificate validation is unchanged. Only the address lookup is redirected.
export function getJsonViaResolver(url, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { lookup: resolverLookup, timeout: timeoutMs },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`${url} responded ${response.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`${url} returned unparseable JSON: ${body.slice(0, 200)}`));
          }
        });
      }
    );
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error(`${url} timed out after ${timeoutMs}ms`)));
  });
}

// Report whether Binance is reachable and by which path.
//
// The first connection of a process pays DNS resolution and a TLS handshake
// together, which can exceed a single short timeout on a cold start. Declaring
// the exchange unreachable on that basis is a false negative that fails every
// downstream check, so the probe retries before giving up. Only a genuine
// inability to connect is reported as unreachable.
export async function probeReachability({ attempts = 3, timeoutMs = 12_000 } = {}) {
  const url = "https://api.binance.com/api/v3/ping";
  const started = Date.now();
  const failures = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await getJsonViaResolver(url, { timeoutMs });
      return {
        reachable: true,
        via: resolver ? "apex-resolver" : "system-resolver",
        latency_ms: Date.now() - started,
        attempts_used: attempt
      };
    } catch (error) {
      failures.push(error.message);
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }

  return {
    reachable: false,
    via: resolver ? "apex-resolver" : "system-resolver",
    latency_ms: Date.now() - started,
    attempts_used: attempts,
    reason: failures[failures.length - 1],
    all_failures: failures
  };
}
