# APEX — Adversarial Portfolio Execution Engine

**Let the models fight. Let the math decide.**

Built for the Binance Agent OS Mini Hackathon, Track A.

---

## What it is

Binance Agent OS bounds *where* an agent's funds can go. Agents run in a dedicated sub-account
and no withdrawal scope exists at all. What the platform does not bound is *how much* an agent
can lose inside that boundary.

APEX is the layer that does. Two agents argue from identical evidence, a deterministic Referee
simulates the resulting portfolio, and any proposal that breaches the Constitution is denied
with the rule and the arithmetic printed on screen.

The trade can be right and still be unsafe. APEX is built so that distinction is enforced in
code rather than asked of a prompt.

## Run it

Requires Node.js 18 or newer. No dependencies, no API keys, no build step.

```bash
npm test
```

```bash
node bin/demo.mjs
```

`node bin/demo.mjs --replay` runs the same cycle against a recorded market capture, so the demo
is fully reproducible with no network access.

## What the demo shows

1. **Live evidence.** Real Binance market data, each field labelled with its source, its age and
   whether it is an exchange reading or an APEX calculation.
2. **A real disagreement.** Bull and Bear receive the identical evidence packet and reach opposite
   conclusions. Every claim cites the evidence keys behind it.
3. **A denial with its arithmetic.** The Referee simulates the post-fill book and refuses the
   proposal, naming each rule, the observed value and the limit.
4. **A tamper-evident record.** The journal is hash-linked, and the demo edits a past verdict to
   prove the chain detects it.

## The honest parts

This project's governing rule is that uncertainty is never silently converted into certainty.
Three consequences follow, and all three are visible in the output.

**No liquidation value is ever labelled as coming from Binance.** The maintenance-margin brackets
come from a published static table rather than the account's live `leverageBracket` response,
which requires an API key. Every liquidation figure is therefore an `APEX_ESTIMATE` under formula
`liq-v1`, and ships with its six assumptions attached.

**No order is ever submitted.** The Binance MCP endpoint is real and OAuth-gated, verified by a
direct probe returning `HTTP 401` with a valid RFC 9728 discovery pointer. Its tool names and
schemas are not published anywhere authoritative. Writing execution code against a guessed schema
would violate the project's own first rule, so the pipeline stops at the execution preview.

**Absence is never rendered as zero.** A book with no liquidation exposure reports `UNAVAILABLE`,
not `0`, because those mean opposite things.

Full detail in [BINANCE_CAPABILITIES.md](BINANCE_CAPABILITIES.md), including two conflicts found
inside the specification itself and how each was resolved.

## Architecture

| Module | Responsibility |
|---|---|
| `src/resolver.mjs` | Application-level DNS, so APEX resolves Binance without changing system settings |
| `src/market.mjs` | Market data adapter over public Binance REST |
| `src/quant.mjs` | Turns market data and the book into keyed, provenance-wrapped measurements |
| `src/evidence.mjs` | Rejects any claim citing evidence the packet does not contain |
| `src/agents.mjs` | Bull, Bear, and the debate router |
| `src/referee.mjs` | Post-fill portfolio simulation and the deterministic verdict |
| `src/liquidation.mjs` | Liquidation resolution with provenance classification |
| `src/constitution.mjs` | Policy loading, validation and SHA-256 identity |
| `src/journal.mjs` | Append-only hash-linked audit journal |
| `src/cycle.mjs` | The full decision pipeline |

Bull and Bear are deterministic reasoners behind a `ModelProvider` seam. That is deliberate: the
demo runs with no API key and a judge can reproduce every argument exactly. Substituting a
language model is a change to `src/agents.mjs` alone, and the evidence validator applies either
way.

## Safety model

- No withdrawal scope exists on the platform, and APEX adds no path to one.
- The Constitution is refused at load time if it permits withdrawals or disables human confirmation.
- Every verdict records the Constitution's id, version and hash, so a historical decision stays
  bound to the exact policy that produced it.
- Stale or expired evidence halts the cycle before any agent is consulted.
- Denials are first-class output, recorded with the same detail as approvals.

## Test coverage

72 tests. The liquidation suite implements acceptance tests A through F from the specification,
including a deterministic comparison at the 15% boundary that does not flip on floating-point
drift. The adversarial suite covers unsupported evidence, invented indicators, fabricated fills
and fabricated payments.

```bash
npm test
```

---

Prototype built for a hackathon. Not financial advice. No live trading capability.
