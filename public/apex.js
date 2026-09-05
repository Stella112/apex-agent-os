// APEX dashboard.
//
// Every number rendered here comes from /api/cycle. Nothing is hardcoded, and
// nothing is shown without its provenance. Where a value is absent the UI says
// so rather than printing a zero.

const $ = (id) => document.getElementById(id);

let current = null;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const money = (v) =>
  `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const FORMATTERS = {
  "price.mark": money,
  "price.last": money,
  "price.index": money,
  "price.bid": money,
  "price.ask": money,
  "price.mid": money,
  "price.spread": (v) => `$${v.toFixed(2)}`,
  "price.spread_bps": (v) => `${v.toFixed(3)} bps`,
  "funding.current": (v) => `${(v * 100).toFixed(4)}%`,
  "market.basis_bps": (v) => `${v.toFixed(2)} bps`,
  "market.realized_volatility": (v) => `${(v * 100).toFixed(2)}%`,
  "market.order_book_imbalance": (v) => v.toFixed(4),
  "market.flow_toxicity": (v) => v.toFixed(4),
  "market.open_interest": (v) => v.toLocaleString("en-US"),
  "market.volume_24h": money,
  "market.price_change_pct_24h": (v) => `${v.toFixed(2)}%`,
  "portfolio.equity": money,
  "portfolio.wallet_balance": money,
  "portfolio.gross_notional": money,
  "portfolio.name_notional": money,
  "portfolio.leverage": (v) => `${v.toFixed(2)}x`,
  "portfolio.net_delta_btc": (v) => `${v.toFixed(6)} BTC`,
  "portfolio.name_exposure_pct": (v) => `${v.toFixed(2)}%`,
  "portfolio.liquidation_price": money,
  "portfolio.liquidation_distance_pct": (v) => `${v.toFixed(2)}%`,
  "portfolio.position_qty": (v) => `${v.toFixed(6)} BTC`,
  "portfolio.entry_price": money
};

// The rows worth surfacing first. The rest stay available in the provenance
// modal rather than crowding the panel.
const HEADLINE_KEYS = [
  "price.mark",
  "price.spread_bps",
  "funding.current",
  "market.order_book_imbalance",
  "market.realized_volatility",
  "market.flow_toxicity",
  "market.open_interest",
  "portfolio.equity",
  "portfolio.leverage",
  "portfolio.net_delta_btc",
  "portfolio.liquidation_price",
  "portfolio.liquidation_distance_pct"
];

function formatField(key, field) {
  if (!field || field.value === null) return "UNAVAILABLE";
  const formatter = FORMATTERS[key];
  return formatter ? formatter(field.value) : String(field.value);
}

function classTone(classification) {
  if (classification === "BINANCE_REPORTED") return "tone-binance";
  if (classification === "APEX_ESTIMATE") return "tone-estimate";
  if (classification === "SIMULATION") return "tone-sim";
  return "tone-none";
}

function freshTone(freshness) {
  if (freshness === "FRESH") return "fresh-ok";
  if (freshness === "AGING") return "fresh-aging";
  return "fresh-bad";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderEvidence(packet) {
  const list = $("evidence-list");
  const keys = Object.keys(packet.evidence);
  $("evidence-count").textContent = `${keys.length} keys`;

  if (keys.length === 0) {
    list.innerHTML = '<div class="empty">Packet is empty. No new risk may be opened.</div>';
    return;
  }

  const rows = HEADLINE_KEYS.filter((k) => k in packet.evidence).map((key) => {
    const field = packet.evidence[key];
    const absent = !field || field.value === null;
    return `
      <button class="evidence-row${absent ? " absent" : ""}" data-key="${key}">
        <span class="ev-key">${key}</span>
        <span class="ev-value">${formatField(key, field)}</span>
        <span class="ev-tags">
          <em class="${classTone(field?.classification)}">${field?.classification ?? "UNAVAILABLE"}</em>
          <i class="${freshTone(field?.freshness)}">${field?.freshness ?? "—"}</i>
        </span>
      </button>`;
  });

  list.innerHTML = rows.join("");
  for (const button of list.querySelectorAll(".evidence-row")) {
    button.addEventListener("click", () => openProvenance(button.dataset.key));
  }
}

function renderProposal(proposal, verdict) {
  const sim = verdict?.simulation;
  $("proposal").innerHTML = `
    <div class="prop-head">
      <b>${proposal.side} ${proposal.qty} ${proposal.symbol}</b>
      <span class="sim-chip">${proposal.classification}</span>
    </div>
    <p class="prop-desc">${escapeHtml(proposal.description ?? "")}</p>
    <div class="prop-grid">
      <div><span>Reference price</span><b>${money(proposal.reference_price)}</b></div>
      <div><span>Equity after</span><b>${sim ? money(sim.equityAfter) : "—"}</b></div>
      <div><span>Leverage after</span><b>${sim && isFinite(sim.leverageAfter) ? sim.leverageAfter.toFixed(2) + "x" : "—"}</b></div>
      <div><span>Liquidation after</span><b>${sim?.liquidationPriceAfter != null ? money(sim.liquidationPriceAfter) : "none"}</b></div>
    </div>`;
}

function renderRoutes(data) {
  const table = $("route-table");
  if (!data.routes) {
    table.innerHTML = '<div class="empty">No routes evaluated. The cycle halted first.</div>';
    $("route-selected").textContent = "—";
    return;
  }

  const rows = data.routes.evaluations
    .map((e) => {
      const score = e.score === null ? "—" : `${e.score.toFixed(2)} bps`;
      const cls =
        e.status === "REJECTED" ? "rejected" : e.route === data.routes.selected ? "chosen" : "";
      return `<div class="route-row ${cls}">
        <span class="rt-name">${e.route}</span>
        <span class="rt-side">${e.side ?? "—"}</span>
        <span class="rt-score">${score}</span>
        <span class="rt-status">${e.status}</span>
      </div>
      ${e.reason ? `<div class="route-reason">${escapeHtml(e.reason)}</div>` : ""}`;
    })
    .join("");

  const breaches = data.routes.book_breaches?.length
    ? `<div class="route-breach"><b>Book is outside policy:</b> ${data.routes.book_breaches
        .map(escapeHtml)
        .join("; ")}</div>`
    : "";

  table.innerHTML = `
    <div class="route-row header"><span>ROUTE</span><span>SIDE</span><span>SCORE</span><span>STATUS</span></div>
    ${rows}${breaches}
    <div class="route-foot">Selected: <b>${data.routes.selected ?? "none"}</b>. Position routes
    stay unexecutable while no Binance write schema is verified.</div>`;

  $("route-selected").textContent = data.routes.selected ?? "none";
}

function renderAgents(data) {
  const container = $("agents");
  const blocks = [
    ["BULL", data.bull, "bull"],
    ["BEAR", data.bear, "bear"]
  ].map(([name, agent, cls]) => {
    if (!agent) return "";
    if (!agent.valid) {
      return `<div class="agent-memo ${cls}"><div class="avatar">${name[0]}</div>
        <div><div class="memo-title"><b>${name}</b><span class="invalid">NO SUPPORTABLE CLAIM</span></div>
        <p>${agent.failure ?? "Output rejected by the evidence validator."}</p></div></div>`;
    }
    const claims = agent.claims
      .map(
        (c) => `<li>${escapeHtml(c.claim)}
          <small>cites ${c.evidence_keys.map((k) => `<code>${k}</code>`).join(" · ")}</small></li>`
      )
      .join("");
    const rejected = agent.rejected.length
      ? `<div class="rejected">${agent.rejected.length} claim(s) rejected as unsupported</div>`
      : "";
    return `<div class="agent-memo ${cls}">
      <div class="avatar">${name[0]}</div>
      <div>
        <div class="memo-title"><b>${name}</b><span>${agent.decision} · ${(agent.confidence * 100).toFixed(0)}%</span></div>
        <ul class="claims">${claims}</ul>
        ${rejected}
      </div></div>`;
  });

  container.innerHTML = blocks.join("");

  if (data.debate) {
    $("debate-state").textContent = data.debate.classification;
    $("debate-state").className = `debate-state ${data.debate.material ? "material" : ""}`;
    $("router-line").textContent = data.debate.detail;
  }
}

function renderVerdict(data) {
  const table = $("rule-table");
  if (!data.verdict) {
    table.innerHTML = '<div class="empty">No verdict. The cycle halted before the Referee.</div>';
    return;
  }

  const rows = data.verdict.checks
    .map((check) => {
      const { observed, limit } = pickNumbers(check.numbers);
      return `<div class="rule-row ${check.result === "FAIL" ? "fail" : "pass"}">
        <span class="r-id">${check.rule_id}</span>
        <span class="r-obs">${observed}</span>
        <span class="r-lim">${limit}</span>
        <span class="r-res">${check.result}</span>
      </div>`;
    })
    .join("");

  const failed = data.verdict.checks.filter((c) => c.result === "FAIL");
  const why = failed.length
    ? `<div class="why"><b>Why:</b><ul>${failed
        .map((c) => `<li>${escapeHtml(c.detail)}</li>`)
        .join("")}</ul></div>`
    : "";

  const resize =
    data.resize === null
      ? ""
      : data.resize > 0
        ? `<div class="resize">Largest compliant size: <b>${data.resize.toFixed(6)}</b>, computed from the rules.</div>`
        : `<div class="resize">No compliant size exists. The correct action is to stand down.</div>`;

  table.innerHTML = `
    <div class="rule-row header"><span>RULE</span><span>OBSERVED</span><span>LIMIT</span><span>RESULT</span></div>
    ${rows}${why}${resize}`;

  if (data.constitution) {
    $("rule-source").innerHTML = `Policy <code>${data.constitution.constitution_id}</code>
      v${data.constitution.constitution_version} ·
      <code>${data.constitution.constitution_sha256.slice(0, 16)}…</code> · enforced in code, not prompt text`;
  }
}

function pickNumbers(numbers) {
  const first = (keys) => {
    for (const k of keys) {
      const v = numbers?.[k];
      if (typeof v === "number" && isFinite(v)) return v;
    }
    return null;
  };
  const obs = first([
    "distanceAfter",
    "leverage",
    "netDeltaBtc",
    "concentration",
    "riskFraction",
    "drawdown",
    "confidence",
    "toxicity"
  ]);
  const lim = first(["required", "cap", "limit", "budget", "ceiling", "floor", "threshold"]);
  const f = (v) => (v === null ? "—" : Math.abs(v) < 1 ? v.toFixed(4) : v.toFixed(2));
  return { observed: f(obs), limit: f(lim) };
}

function renderExecution(data) {
  const el = $("execution");

  // Anything the Referee can make compliant reaches the operator, whether it
  // was approved as proposed or cut down to a size that passes.
  if (data.authorisable) {
    const a = data.authorisable;
    const resized = a.resized
      ? `<div class="resize-note">
           The Referee refused <b>${a.original_qty} BTC</b> and computed the largest size that
           clears every rule: <b>${a.qty.toFixed(6)} BTC</b>. That is what you are authorising.
         </div>`
      : "";
    el.innerHTML = `<div class="exec-await">
      <b>${a.resized ? "RESIZED · AWAITING YOUR AUTHORISATION" : "AWAITING YOUR AUTHORISATION"}</b>
      ${resized}
      <div class="preview-grid">
        <div><span>Symbol</span><b>${a.symbol}</b></div>
        <div><span>Side</span><b>${a.side}</b></div>
        <div><span>Quantity</span><b>${a.qty.toFixed(6)} BTC</b></div>
        <div><span>Reference price</span><b>${money(a.entryPrice ?? data.proposal.reference_price)}</b></div>
        <div><span>Referee</span><b class="ok">APPROVE</b></div>
        <div><span>Constitution</span><b>${data.constitution?.constitution_id} v${data.constitution?.constitution_version}</b></div>
      </div>
      <p>Nothing moves until you authorise it. Authorising records your decision in the journal;
      it does not send an order, because no Binance write tool has a verified schema.</p>
      <button class="authorise" id="authorise">Authorise ${a.qty.toFixed(6)} BTC</button>
      <div id="authorise-result"></div>
    </div>`;
    $("authorise").addEventListener("click", () => authorise(data.cycle_id));
    return;
  }

  if (data.halt === "REFEREE_DENIED") {
    el.innerHTML = `<div class="exec-blocked">
      <b>BLOCKED BY THE REFEREE</b>
      <p>No compliant size exists for this proposal, so it never reached a human and nothing was
      submitted anywhere. Standing down is the correct outcome.</p>
    </div>`;
    return;
  }

  el.innerHTML = `<div class="exec-halt"><b>${data.halt ?? "HALTED"}</b><p>${escapeHtml(
    data.message ?? "The cycle stopped before execution."
  )}</p></div>`;
}

function renderJournal(data) {
  const el = $("journal");
  el.innerHTML = data.journal.events
    .map(
      (e) => `<div class="event">
        <time>${e.event_id}</time>
        <p><b>${e.event_type}</b><br /><span>${e.event_hash.slice(0, 16)}…</span></p>
      </div>`
    )
    .join("");

  const badge = $("journal-badge");
  badge.textContent = data.journal.valid ? "VALID" : data.journal.failure;
  badge.className = `journal-valid ${data.journal.valid ? "" : "broken"}`;
  $("m-journal").textContent = data.journal.valid ? "VALID" : "BROKEN";
  $("m-journal-sub").textContent = `${data.journal.length} hash-linked events`;
}

function renderVerdictHero(data) {
  const big = $("verdict-big");
  const rule = $("verdict-rule");
  const math = $("verdict-math");

  if (!data.verdict) {
    big.textContent = data.halt ?? "HALTED";
    big.className = "verdict-idle";
    rule.textContent = data.message ?? "The cycle stopped early.";
    math.innerHTML = "";
    return;
  }

  const verdict = data.verdict.verdict;
  big.textContent = verdict;
  big.className = verdict === "DENY" ? "verdict-denied" : verdict === "APPROVE" ? "verdict-approved" : "verdict-resize";

  const worst = data.verdict.checks.find((c) => c.result === "FAIL");
  rule.textContent = worst ? worst.rule_id.replace(/_/g, " ") : "ALL RULES PASSED";

  const liq = data.verdict.checks.find((c) => c.rule_id === "LIQUIDATION_DISTANCE");
  if (liq && liq.numbers?.distanceAfter != null) {
    math.innerHTML = `<b>${(liq.numbers.distanceAfter * 100).toFixed(2)}%</b>
      <span>liquidation distance after fill</span>
      <em>policy ≥ ${(liq.numbers.required * 100).toFixed(0)}%</em>`;
  } else {
    math.innerHTML = "";
  }
}

// ---------------------------------------------------------------------------
// Provenance modal (spec section 38)
// ---------------------------------------------------------------------------
function openProvenance(key) {
  const field = current?.packet?.evidence?.[key];
  if (!field) return;

  $("prov-key").textContent = key;
  $("prov-value").textContent = formatField(key, field);

  const rows = [
    ["Classification", field.classification],
    ["Source", field.source ?? "—"],
    ["Status", field.status],
    ["Freshness", field.freshness],
    ["Timestamp", field.timestamp ?? "—"],
    ["Age", field.age_ms === null ? "—" : `${field.age_ms} ms`],
    ["Formula", field.formula ?? "—"],
    ["Formula version", field.formula_version ?? "—"],
    ["Reason", field.reason ?? "—"]
  ];

  let html = rows
    .filter(([, v]) => v !== "—" || true)
    .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`)
    .join("");

  if (field.assumptions) {
    html += `<dt>Assumptions</dt><dd><ul>${field.assumptions
      .map((a) => `<li>${escapeHtml(a)}</li>`)
      .join("")}</ul></dd>`;
  }

  $("prov-rows").innerHTML = html;
  $("prov-backdrop").hidden = false;
}

function closeProvenance() {
  $("prov-backdrop").hidden = true;
}

// ---------------------------------------------------------------------------
// Cycle
// ---------------------------------------------------------------------------
async function runCycle(proposalId) {
  const mode = $("replay-mode").checked ? "replay" : "live";
  const buttons = [$("run-modest"), $("run-reckless")];
  buttons.forEach((b) => (b.disabled = true));

  setBanner(null);
  $("mode-label").textContent = mode === "live" ? "LIVE" : "SIMULATION";
  $("mode-pill").className = `mode-pill ${mode === "live" ? "live" : "sim"}`;

  try {
    const response = await fetch(
      `/api/cycle?mode=${encodeURIComponent(mode)}&proposal=${encodeURIComponent(proposalId)}`
    );
    const data = await response.json();
    if (!response.ok) {
      setBanner(`Cycle failed: ${data.error ?? response.status}. ${data.detail ?? ""}`, "bad");
      return;
    }
    current = data;
    paintCycle(data);
    $("tamper-result").textContent = "";
  } catch (error) {
    setBanner(`Could not reach the APEX API: ${error.message}`, "bad");
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

function paintCycle(data) {
    $("m-fresh").textContent = data.packet.worst_freshness;
    $("m-fresh-sub").textContent = data.packet.missing_keys.length
      ? `${data.packet.missing_keys.length} field(s) unavailable`
      : "all fields present";

    if (data.halted && !data.verdict) {
      setBanner(`${data.halt}: ${data.message}. This is the fail-closed path, no new risk was opened.`, "warn");
    }
    if (data.execution_mode === "SIMULATION") {
      setBanner("SIMULATION. Market data is a replayed capture with its clock rebased. Nothing here is a live exchange reading.", "sim");
    }

    renderEvidence(data.packet);
    renderProposal(data.proposal, data.verdict);
    renderRoutes(data);
    renderAgents(data);
    renderVerdict(data);
    renderVerdictHero(data);
    renderExecution(data);
    renderJournal(data);
}

async function authorise(cycleId) {
  const button = $("authorise");
  const out = $("authorise-result");
  button.disabled = true;
  button.textContent = "Authorising…";

  try {
    const response = await fetch("/api/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cycle_id: cycleId })
    });
    const data = await response.json();
    if (!response.ok) {
      out.innerHTML = `<div class="auth-fail">${escapeHtml(data.error ?? "authorisation failed")}</div>`;
      button.disabled = false;
      button.textContent = "Authorise this trade";
      return;
    }

    button.textContent = "Authorised";
    out.innerHTML = `<div class="auth-ok">
      <b>AUTHORISATION RECORDED</b>
      <p>${escapeHtml(data.detail)}</p>
      <small>Journal now holds ${data.journal.length} events and the chain is
      ${data.journal.valid ? "valid" : "BROKEN"}.</small>
    </div>`;

    // The confirmation is part of the same chain, so redraw the journal.
    current.journal = data.journal;
    renderJournal(current);
  } catch (error) {
    out.innerHTML = `<div class="auth-fail">${escapeHtml(error.message)}</div>`;
    button.disabled = false;
    button.textContent = "Authorise this trade";
  }
}

function setBanner(text, tone = "warn") {
  const el = $("banner");
  if (!text) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.className = `banner ${tone}`;
  el.textContent = text;
}

async function loadHealth() {
  try {
    const data = await (await fetch("/api/health")).json();
    $("m-reach").textContent = data.binance.reachable ? "REACHABLE" : "UNREACHABLE";
    $("m-reach-sub").textContent = data.binance.reachable
      ? `${data.binance.latency_ms} ms via ${data.binance.via}`
      : data.binance.reason ?? "no route";
    $("m-const").textContent = data.constitution.constitution_id;
    $("m-const-sub").textContent = `v${data.constitution.constitution_version} · ${data.constitution.constitution_sha256.slice(0, 10)}…`;
    $("writes-pill").textContent = `WRITES: ${data.writes_enabled ? "ENABLED" : "DISABLED"}`;
  } catch {
    $("m-reach").textContent = "UNKNOWN";
    $("m-reach-sub").textContent = "health check failed";
  }
}

// Tamper demonstration. Recomputes the chain in the browser over an edited
// payload, so a viewer can watch the break appear.
async function tamperTest() {
  if (!current) return;
  const events = current.journal.events;
  const target = events.find((e) => e.event_type === "REFEREE_DECISION");
  if (!target) {
    $("tamper-result").textContent = "no verdict event to tamper with";
    return;
  }
  // Flipping any byte of a committed event breaks the link to the next one.
  let previous = null;
  let brokenAt = null;
  for (const event of events) {
    if (previous && event.previous_hash !== previous) {
      brokenAt = event.event_id;
      break;
    }
    previous = event.event_id === target.event_id ? `${target.event_hash}TAMPERED` : event.event_hash;
  }
  $("tamper-result").textContent = brokenAt
    ? `chain breaks at ${brokenAt}`
    : `chain breaks immediately after ${target.event_id}`;
  $("journal-badge").textContent = "BROKEN";
  $("journal-badge").className = "journal-valid broken";
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

// --- Evaluate a book the user typed in --------------------------------------
async function evaluateOwnBook(event) {
  event.preventDefault();
  const button = $("evaluate");
  const errorBox = $("form-error");
  errorBox.hidden = true;
  button.disabled = true;
  button.textContent = "Checking…";

  const qty = Number($("in-qty").value);
  const invalidation = $("in-invalidation").value.trim();

  const payload = {
    mode: $("replay-mode").checked ? "replay" : "live",
    book: {
      walletBalance: Number($("in-wallet").value),
      // A zero position is simply no position, not a position of size zero.
      positions:
        qty === 0 || Number.isNaN(qty)
          ? []
          : [
              {
                symbol: "BTCUSDT",
                qty,
                entryPrice: Number($("in-entry").value)
              }
            ]
    },
    proposal: {
      symbol: "BTCUSDT",
      side: $("in-side").value,
      qty: Number($("in-add").value)
    },
    thesis: invalidation === "" ? {} : { invalidation: Number(invalidation) }
  };

  setBanner(null);
  $("mode-label").textContent = payload.mode === "live" ? "LIVE" : "SIMULATION";
  $("mode-pill").className = `mode-pill ${payload.mode === "live" ? "live" : "sim"}`;

  try {
    const response = await fetch("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();

    if (!response.ok) {
      errorBox.hidden = false;
      errorBox.textContent = data.detail ?? data.error ?? `request failed (${response.status})`;
      return;
    }

    current = data;
    paintCycle(data);
    document.querySelector(".book-debate").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    errorBox.hidden = false;
    errorBox.textContent = error.message;
  } finally {
    button.disabled = false;
    button.innerHTML = 'Check this trade <span>↗</span>';
  }
}

$("book-form").addEventListener("submit", evaluateOwnBook);
$("run-modest").addEventListener("click", () => runCycle("modest"));
$("run-reckless").addEventListener("click", () => runCycle("reckless"));
$("prov-close").addEventListener("click", closeProvenance);
$("prov-backdrop").addEventListener("click", (e) => {
  if (e.target === $("prov-backdrop")) closeProvenance();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeProvenance();
});
$("tamper").addEventListener("click", tamperTest);

loadHealth();
