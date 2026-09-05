# APEX — Adversarial Portfolio Execution Engine

**Let the models fight. Let the math decide.**

Built for the Binance Agent OS Mini Hackathon, Track A.

---

## Try it

On Windows, double-click **`start-apex.bat`**. On macOS or Linux, run **`./start-apex.sh`**.
Your browser opens at <http://127.0.0.1:4173>.

If you would rather use a terminal:

```bash
node server.mjs
```

Node.js 18 or newer is the only requirement. There are no dependencies to install, no API keys,
no account to connect and no build step.

## What it does

Enter your book and the trade you are thinking about. APEX fetches the live Binance price,
runs your numbers through a deterministic risk engine, and tells you one of three things:

- **APPROVE.** The trade sits inside every rule.
- **RESIZE.** The idea is fine but the size is not, and here is the largest size that works.
- **DENY.** The resulting portfolio is unacceptable, and here is exactly which rule and by how much.

Every verdict shows the rule, your observed value, the limit, and the arithmetic. Nothing is
stored, and no account is ever connected.

There are also two worked examples on the page, a modest add and a deliberately reckless one,
if you want to see both outcomes before entering your own figures.

## Why it exists

Binance Agent OS bounds *where* an agent's funds can go. Agents run in a dedicated sub-account
with no withdrawal scope at all. What the platform does not bound is *how much* can be lost
inside that boundary.

APEX is the layer that does. Two agents argue from identical evidence, a deterministic Referee
simulates the resulting portfolio, and any proposal that breaches the Constitution is refused
with its arithmetic printed on screen.

The trade can be right and still be unsafe. APEX enforces that distinction in code rather than
asking a prompt to respect it.

## What the demo shows

1. **Live evidence.** Real Binance market data, each field labelled with its source, its age,
   and whether it is an exchange reading or an APEX calculation.
2. **A real disagreement.** Bull and Bear receive the identical evidence packet and reach
   opposite conclusions. Every claim cites the evidence keys behind it.
3. **Five scored strategies.** The portfolio router prices carry, reverse carry, directional,
   park and stand down in basis points, and explains why each loser lost.
4. **A denial with its arithmetic.** The Referee simulates the post-fill book and names each
   rule, the observed value and the limit.
5. **A resize you can act on.** A refusal that cannot tell you what would work is not useful,
   so the Referee computes the largest compliant size and offers that instead.
6. **A human gate.** Nothing proceeds until you authorise it.
7. **A tamper-evident record.** The journal is hash-linked, and the page will edit a past
   verdict in front of you to prove the chain catches it.

## The honest parts

This project's governing rule is that uncertainty is never silently turned into certainty.

**No liquidation value is ever labelled as coming from Binance.** The maintenance-margin
brackets come from a published static table rather than the account's live `leverageBracket`
response, which requires an API key. Every liquidation figure is an `APEX_ESTIMATE` under
formula `liq-v1` and ships with its six assumptions attached.

**No order is ever submitted.** The Binance MCP endpoint is real and OAuth-gated, verified by a
direct probe returning `HTTP 401` with a valid RFC 9728 discovery pointer. Its tool names and
schemas are not published anywhere authoritative. Writing execution code against a guessed
schema would violate this project's own first rule, so the pipeline stops at your
authorisation. You place the trade yourself.

**Absence is never rendered as zero.** A book with no liquidation exposure reports
`UNAVAILABLE`, because those two things mean opposite things.

Full detail in [BINANCE_CAPABILITIES.md](BINANCE_CAPABILITIES.md) and
[APEX_IMPLEMENTATION_AUDIT.md](APEX_IMPLEMENTATION_AUDIT.md), including two conflicts found
inside the specification itself and how each was resolved.

## Check it yourself

```bash
npm test
```

96 tests. The liquidation suite implements acceptance tests A through F, including a
deterministic comparison at the 15% boundary that does not flip on floating-point drift. The
adversarial suite covers unsupported evidence, invented indicators, fabricated fills and
fabricated payments.

```bash
node bin/verify.mjs
```

A verification harness that refuses to report PASS without evidence produced during that run.
It reports 22 PASS, 0 FAIL, and marks live execution and post-trade reconciliation as unproven,
because they are.

## Architecture

| Module | Responsibility |
|---|---|
| `src/resolver.mjs` | Application-level DNS, so APEX reaches Binance without changing system settings |
| `src/market.mjs` | Market data adapter over public Binance REST |
| `src/quant.mjs` | Turns market data and the book into keyed, provenance-wrapped measurements |
| `src/evidence.mjs` | Rejects any claim citing evidence the packet does not contain |
| `src/agents.mjs` | Bull, Bear, and the debate router |
| `src/router.mjs` | Scores five portfolio strategies and explains every rejection |
| `src/referee.mjs` | Post-fill portfolio simulation and the deterministic verdict |
| `src/liquidation.mjs` | Liquidation resolution with provenance classification |
| `src/constitution.mjs` | Policy loading, validation and SHA-256 identity |
| `src/journal.mjs` | Append-only hash-linked audit journal |
| `src/validate.mjs` | Strict validation of anything a visitor types |
| `src/cycle.mjs` | The full decision pipeline |

Bull and Bear are deterministic reasoners behind a `ModelProvider` seam. That is deliberate:
the demo runs with no API key and a judge can reproduce every argument exactly. Substituting a
language model is a change to `src/agents.mjs` alone, and the evidence validator applies either
way.

## Safety model

- No withdrawal scope exists on the platform, and APEX adds no path to one.
- The Constitution is refused at load time if it permits withdrawals or disables human
  confirmation.
- Every verdict records the Constitution's id, version and hash, so a historical decision stays
  bound to the exact policy that produced it.
- Stale or expired evidence halts the cycle before any agent is consulted.
- Denials are first-class output, recorded with the same detail as approvals.
- Nothing a visitor types is stored anywhere.

## Deploying

See [deploy.md](deploy.md). A Dockerfile is included.

---

Prototype built for a hackathon. Not financial advice. No live trading capability.
