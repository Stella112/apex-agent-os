(function () {
  const root = document.documentElement;
  const toggle = document.getElementById('theme-toggle');
  const saved = localStorage.getItem('apex-theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

  function setTheme(theme) {
    root.dataset.theme = theme;
    if (toggle) {
      const dark = theme === 'dark';
      toggle.setAttribute('aria-pressed', String(dark));
      toggle.querySelector('span').textContent = dark ? '☀' : '☾';
      toggle.querySelector('em').textContent = dark ? 'Light mode' : 'Dark mode';
    }
  }

  setTheme(saved || (prefersDark ? 'dark' : 'light'));
  toggle?.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('apex-theme', next);
    setTheme(next);
  });

  const bridgeTitle = document.querySelector('.dark-card h2');
  if (bridgeTitle) bridgeTitle.innerHTML = 'One skill for the verdict.<br>One MCP for the account.';
  const bridgeCopy = document.querySelector('.dark-card p:not(.kicker)');
  if (bridgeCopy) bridgeCopy.textContent = 'Use the APEX Binance Council Skill alongside Binance Skills or Binance MCP in Codex, Claude, Cursor, ChatGPT, Antigravity, or another compatible agent. APEX researches and challenges. Binance authenticates and executes only after you confirm.';
  const handoff = document.querySelectorAll('.handoff-step');
  if (handoff.length >= 3) {
    handoff[0].querySelector('strong').textContent = 'APEX SKILL';
    handoff[0].querySelector('span').textContent = 'Teaches your agent the safe order of operations.';
    handoff[1].querySelector('strong').textContent = 'APEX MCP';
    handoff[1].querySelector('span').textContent = 'Finds, debates, and returns evidence.';
  }

  const heroTitle = document.querySelector('.hero h1');
  if (heroTitle) heroTitle.innerHTML = 'A signal is not a decision.<br><em>It is a case to prove.</em>';
  const heroLead = document.querySelector('.hero-lead');
  if (heroLead) heroLead.textContent = 'Markets move faster than certainty. APEX gives your agent a Quant packet, an adversarial Bull-versus-Bear debate, and a hard control plane that can deny or resize the trade before capital moves.';
  const councilHeading = document.querySelector('#council h2');
  if (councilHeading) councilHeading.textContent = 'The council argues. The control plane decides.';
  const councilCopy = document.querySelector('#council .section-intro > p:last-child');
  if (councilCopy) councilCopy.textContent = 'Bull and Bear reason from the same facts. Quant, the routers, Constitution, Referee, Guardian, Executor, and Journal turn that debate into a controlled handoff.';
})();
