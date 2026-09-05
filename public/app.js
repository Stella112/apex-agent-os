const state = { cycle: 4, capital: 1240, revenue: 18.42, buyers: 7 };
const $ = (id) => document.getElementById(id);

function money(value) { return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function now() { return new Date().toLocaleTimeString("en-GB", { hour12: false }); }

function addJournal(title, detail, color = "purple-mark") {
  const item = document.createElement("div");
  item.className = "journal-item";
  item.innerHTML = `<time>${now()}</time><p><span class="journal-mark ${color}">●</span><b>${title}</b><br /><span>${detail}</span></p>`;
  $("journal").prepend(item);
}

function setStep(index, status, icon) {
  const step = $("pipeline").children[index];
  if (!step) return;
  step.classList.remove("locked", "active", "done");
  step.classList.add(status);
  step.querySelector(".step-icon").textContent = icon;
  step.querySelector(".step-state").textContent = status === "done" ? "DONE" : status === "active" ? "READY" : "LOCKED";
}

async function runCycle() {
  const button = $("run-cycle");
  button.disabled = true;
  button.textContent = "Running cycle…";
  setStep(0, "active", "↻");
  addJournal("Context refresh started", "Reading market inputs through Agent OS", "blue-mark");
  await new Promise((resolve) => setTimeout(resolve, 550));
  setStep(0, "done", "✓");
  setStep(1, "active", "↗");
  addJournal("Thesis scored", "82/100 confidence · risk budget respected", "purple-mark");
  await new Promise((resolve) => setTimeout(resolve, 550));
  setStep(1, "done", "✓");
  setStep(2, "active", "↗");
  addJournal("Risk Referee ready", "Simulating post-fill liquidation distance and exposure", "yellow-mark");
  await new Promise((resolve) => setTimeout(resolve, 550));
  $("thesis").textContent = "Referee cleared the bounded thesis: simulated liquidation distance is 18.6%, exposure is 0.40%, concentration is 22%, and daily loss lock is inactive.";
  addJournal("Referee approved thesis", "Liquidation distance 18.6% · all hard limits passed", "green-mark");
  setStep(2, "done", "✓");
  setStep(3, "active", "↗");
  await new Promise((resolve) => setTimeout(resolve, 350));
  setStep(3, "locked", "◇");
  setStep(4, "active", "↗");
  state.revenue += 0.05;
  state.buyers += 1;
  $("revenue").textContent = money(state.revenue);
  $("revenue-large").textContent = money(state.revenue);
  $("signal-revenue").textContent = money(12.05);
  $("buyers").textContent = state.buyers;
  addJournal("Signal priced", "Buyer paid 0.05 USDC · delivery awaits execution", "purple-mark");
  $("cycle-counter").textContent = `Cycle ${String(++state.cycle).padStart(2, "0")}`;
  button.disabled = false;
  button.innerHTML = 'Run agent cycle <span>↗</span>';
}

function approveCycle() {
  setStep(3, "done", "✓");
  setStep(4, "done", "✓");
  setStep(5, "active", "↗");
  addJournal("Paper execution approved", "Simulated order created · no live funds touched", "yellow-mark");
  $("thesis").textContent = "Paper position opened. PROMETHEUS will monitor invalidation at $107,740 and keep the risk budget capped at 0.40% until the next review.";
  setTimeout(() => {
    addJournal("Signal delivered", "x402 receipt settled · intelligence released to buyer", "green-mark");
  }, 450);
  const button = $("approve-cycle");
  button.textContent = "Paper execution active";
  button.disabled = true;
  button.style.opacity = ".6";
}

$("run-cycle").addEventListener("click", runCycle);
$("approve-cycle").addEventListener("click", approveCycle);
$("reset-demo").addEventListener("click", () => window.location.reload());
$("clear-journal").addEventListener("click", () => { $("journal").innerHTML = '<div class="journal-item"><time>—</time><p><span class="journal-mark blue-mark">●</span><b>Journal cleared</b><br /><span>New events will appear here</span></p></div>'; });
