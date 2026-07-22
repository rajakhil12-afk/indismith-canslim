/**
 * app.js — IndiSmith CAN SLIM Terminal
 * Fully static: loads pre-built JSON from /data (refreshed by GitHub Actions),
 * then does all CAN SLIM scoring live in the browser via canslim.js.
 */
(function () {
  'use strict';

  const state = {
    universes: { nifty50: [], nifty100: [], nifty500: [] },
    technicals: {},
    fundamentals: {},
    marketDirection: null,
    meta: null,
    currentUniverse: 'nifty100',
    currentSort: 'rs',
    selectedTicker: null,
    sessionFundamentalsOverrides: {}, // symbol -> parsed fundamentals (paste tab, in-memory only)
    chart: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  async function fetchJson(path, fallback) {
    try {
      const res = await fetch(path, { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (e) {
      console.warn('Failed to load', path, e);
      return fallback;
    }
  }

  function showToast(msg) {
    const toast = $('#toast');
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  async function boot() {
    const [n50, n100, n500, technicals, fundamentals, marketDirection, meta] = await Promise.all([
      fetchJson('data/nifty50.json', []),
      fetchJson('data/nifty100.json', []),
      fetchJson('data/nifty500.json', []),
      fetchJson('data/technicals.json', {}),
      fetchJson('data/fundamentals.json', {}),
      fetchJson('data/market_direction.json', null),
      fetchJson('data/meta.json', null),
    ]);

    state.universes = { nifty50: n50, nifty100: n100, nifty500: n500 };
    state.technicals = technicals;
    state.fundamentals = fundamentals;
    state.marketDirection = marketDirection;
    state.meta = meta;

    renderMarketPulse();
    renderFreshness();
    renderTickerTape();
    renderStockList();
    renderSectorOptions();
    wireEvents();
  }

  // ---------------------------------------------------------------------
  // Scoring helpers
  // ---------------------------------------------------------------------
  function fundamentalsFor(symbol) {
    const upper = symbol.toUpperCase();
    return state.sessionFundamentalsOverrides[upper] || state.fundamentals[upper] || null;
  }

  function scoreStock(row) {
    const fundamentals = fundamentalsFor(row.symbol);
    const tech = state.technicals[row.ticker] || null;
    const result = CanSlim.calculateCanslimScore(row.ticker, fundamentals, tech, state.marketDirection);
    return result;
  }

  function rsRatingFor(row) {
    const tech = state.technicals[row.ticker];
    return tech ? (tech.rs_rating ?? 50) : 50;
  }

  // ---------------------------------------------------------------------
  // Market pulse / ticker tape / freshness
  // ---------------------------------------------------------------------
  function renderMarketPulse() {
    const md = state.marketDirection;
    if (!md) return;
    $('#nifty-price').textContent = md.nifty_price != null ? `₹${md.nifty_price.toLocaleString('en-IN')}` : '—';
    $('#nifty-dist-days').textContent = md.distribution_days != null ? `${md.distribution_days} / 25d` : '—';

    const badge = $('#market-status-badge');
    badge.textContent = md.status || 'Unknown';
    badge.className = 'status-pill ' + (
      md.status === 'Confirmed Uptrend' ? 'uptrend' :
      md.status === 'Uptrend Under Pressure' ? 'pressure' :
      md.status === 'Market in Correction' ? 'correction' : 'unknown'
    );
  }

  function renderFreshness() {
    const dot = $('#freshness-dot');
    const text = $('#freshness-text');
    const lastBuild = state.meta && state.meta.last_build;
    if (!lastBuild) {
      dot.classList.add('stale');
      text.textContent = 'Seed data — run the "Refresh CAN SLIM Data" GitHub Action to sync live prices';
      return;
    }
    const d = new Date(lastBuild);
    const ageHours = (Date.now() - d.getTime()) / 3.6e6;
    if (ageHours > 48) dot.classList.add('stale'); else dot.classList.remove('stale');
    text.textContent = `Data synced ${formatRelative(d)}`;
  }

  function formatRelative(date) {
    const diffMs = Date.now() - date.getTime();
    const hours = Math.floor(diffMs / 3.6e6);
    if (hours < 1) return 'less than an hour ago';
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function renderTickerTape() {
    const rows = state.universes.nifty100.length ? state.universes.nifty100 : state.universes.nifty500;
    const withRs = rows
      .map(r => ({ ...r, rs: rsRatingFor(r), price: (state.technicals[r.ticker] || {}).current_price }))
      .filter(r => r.price != null)
      .sort((a, b) => b.rs - a.rs)
      .slice(0, 40);

    if (!withRs.length) {
      $('#ticker-track').textContent = 'Market data pending first sync — run the Refresh CAN SLIM Data workflow.';
      return;
    }

    const track = $('#ticker-track');
    track.innerHTML = withRs.map(r => {
      const cls = r.rs >= 70 ? 'tk-up' : r.rs <= 30 ? 'tk-down' : '';
      return `<span class="${cls}">${r.symbol} · ₹${Number(r.price).toLocaleString('en-IN')} · RS ${r.rs}</span>`;
    }).join('<span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>');
  }

  // ---------------------------------------------------------------------
  // Sidebar stock list
  // ---------------------------------------------------------------------
  function currentRows(searchTerm) {
    let rows = state.universes[state.currentUniverse] || [];
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      rows = rows.filter(r => r.symbol.toLowerCase().includes(q) || r.company_name.toLowerCase().includes(q));
    }
    const withMeta = rows.map(r => ({ row: r, rs: rsRatingFor(r) }));

    if (state.currentSort === 'rs') {
      withMeta.sort((a, b) => b.rs - a.rs);
    } else if (state.currentSort === 'az') {
      withMeta.sort((a, b) => a.row.symbol.localeCompare(b.row.symbol));
    } else if (state.currentSort === 'score') {
      withMeta.forEach(x => { x.score = scoreStock(x.row).total_score; });
      withMeta.sort((a, b) => b.score - a.score);
    }
    return withMeta;
  }

  function rsClass(rs) {
    if (rs >= 80) return 'rs-high';
    if (rs >= 50) return 'rs-mid';
    return 'rs-low';
  }

  function renderStockList() {
    const container = $('#stock-list-container');
    const searchTerm = $('#stock-search').value.trim();
    const withMeta = currentRows(searchTerm);

    if (!withMeta.length) {
      container.innerHTML = `<div class="list-empty">No stocks match "${escapeHtml(searchTerm)}"</div>`;
      return;
    }

    container.innerHTML = withMeta.map(({ row, rs }) => `
      <div class="stock-row ${row.ticker === state.selectedTicker ? 'active' : ''}" data-ticker="${row.ticker}" data-symbol="${row.symbol}">
        <div class="stock-row-main">
          <span class="stock-row-symbol">${row.symbol}</span>
          <span class="stock-row-name">${escapeHtml(row.company_name)}</span>
        </div>
        <span class="stock-row-rs ${rsClass(rs)}">${rs}</span>
      </div>
    `).join('');

    $$('.stock-row').forEach(el => el.addEventListener('click', () => selectStock(el.dataset.symbol)));
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ---------------------------------------------------------------------
  // Stock selection + hero + ledger
  // ---------------------------------------------------------------------
  function findRow(symbol) {
    const upper = symbol.toUpperCase();
    for (const uni of Object.values(state.universes)) {
      const found = uni.find(r => r.symbol.toUpperCase() === upper);
      if (found) return found;
    }
    return { symbol: upper, ticker: `${upper}.NS`, company_name: upper, industry: 'N/A' };
  }

  function selectStock(symbol) {
    const row = findRow(symbol);
    state.selectedTicker = row.ticker;

    $('#no-selection-screen').style.display = 'none';
    $('#stock-dashboard').style.display = 'block';

    const result = scoreStock(row);
    renderHero(row, result);
    renderLedger(result);
    renderChart(row);
    renderPasteTab(row);
    renderThesis(result);
    renderScanner(); // keep scanner in sync (cheap enough for current universe)
    renderStockList(); // refresh active highlight
  }

  function verdictClass(recommendation) {
    if (recommendation.startsWith('STRONG BUY')) return 'strong-buy';
    if (recommendation.startsWith('WATCHLIST')) return 'watchlist';
    return 'avoid';
  }

  function renderHero(row, result) {
    $('#hero-industry-eyebrow').textContent = (row.industry || 'N/A').toUpperCase();
    $('#hero-name').textContent = row.company_name;
    $('#hero-symbol').textContent = row.symbol;
    $('#hero-mcap').textContent = result.market_cap_crores ? `MCap: ₹${Math.round(result.market_cap_crores).toLocaleString('en-IN')} Cr` : 'MCap: —';
    $('#hero-price').textContent = result.current_price ? `Price: ₹${result.current_price.toLocaleString('en-IN')}` : 'Price: —';

    const seal = $('#verdict-seal');
    seal.className = 'verdict-seal ' + verdictClass(result.recommendation);
    $('#hero-score-text').textContent = result.total_score;

    const rs = result.scorecard.L.metrics.rs_rating;
    $('#hero-rs-rating').textContent = rs;

    const vv = $('#verdict-value');
    vv.textContent = result.recommendation;
    vv.className = 'verdict-text ' + verdictClass(result.recommendation);
  }

  const LETTER_TITLES = {
    C: 'Current Quarterly Earnings', A: 'Annual Earnings Growth', N: 'New Highs / Products / Management',
    S: 'Supply and Demand', L: 'Leader or Laggard', I: 'Institutional Sponsorship', M: 'Market Direction',
  };
  const LETTER_ORDER = ['C', 'A', 'N', 'S', 'L', 'I', 'M'];

  function renderLedger(result) {
    const container = $('#ledger-container');
    container.innerHTML = LETTER_ORDER.map(letter => {
      const section = result.scorecard[letter];
      const pct = Math.round((section.score / section.max) * 100);
      const detailsHtml = section.details.map(d => {
        const cls = d.startsWith('Pass') ? 'pass' : d.startsWith('Fail') ? 'fail' : 'note';
        return `<li class="${cls}">${escapeHtml(d)}</li>`;
      }).join('');
      return `
        <div class="ledger-row">
          <div class="ledger-letter">${letter}</div>
          <div>
            <p class="ledger-title">${LETTER_TITLES[letter]}</p>
            <ul class="ledger-details">${detailsHtml}</ul>
          </div>
          <div class="ledger-score">
            <div><span class="frac">${section.score}</span><span class="of">/${section.max}</span></div>
            <div class="ledger-bar"><div class="ledger-bar-fill" style="width:${pct}%"></div></div>
          </div>
        </div>`;
    }).join('');
  }

  // ---------------------------------------------------------------------
  // Chart
  // ---------------------------------------------------------------------
  function calcEmaSeries(closes, period) {
    if (closes.length < period) return closes.map(() => null);
    const k = 2 / (period + 1);
    const ema = new Array(closes.length).fill(null);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += closes[i];
    ema[period - 1] = sum / period;
    for (let i = period; i < closes.length; i++) ema[i] = (closes[i] * k) + (ema[i - 1] * (1 - k));
    return ema;
  }

  function renderChart(row) {
    const tech = state.technicals[row.ticker];
    const candles = (tech && tech.price_history) || [];
    const ctx = document.getElementById('priceChart').getContext('2d');
    if (state.chart) { state.chart.destroy(); state.chart = null; }

    if (!candles.length) {
      ctx.canvas.parentElement.insertAdjacentHTML('afterbegin', '');
      return;
    }

    const labels = candles.map(c => c.date);
    const closes = candles.map(c => c.close);
    const ema50 = calcEmaSeries(closes, 50);
    const ema200 = calcEmaSeries(closes, 200);
    const volColors = candles.map(c => (c.close >= c.open ? 'rgba(51,182,137,0.55)' : 'rgba(224,100,87,0.55)'));

    state.chart = new Chart(ctx, {
      data: {
        labels,
        datasets: [
          { type: 'line', label: 'Close', data: closes, borderColor: '#edeff5', borderWidth: 1.4, pointRadius: 0, yAxisID: 'y', tension: 0.15 },
          { type: 'line', label: '50 EMA', data: ema50, borderColor: '#e8a33d', borderWidth: 1.4, pointRadius: 0, yAxisID: 'y', tension: 0.15 },
          { type: 'line', label: '200 EMA', data: ema200, borderColor: '#e06457', borderWidth: 1.4, pointRadius: 0, yAxisID: 'y', tension: 0.15 },
          { type: 'bar', label: 'Volume', data: candles.map(c => c.volume), backgroundColor: volColors, yAxisID: 'y1' },
        ],
      },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#7d84a0', maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.04)' } },
          y: { position: 'left', ticks: { color: '#7d84a0' }, grid: { color: 'rgba(255,255,255,0.04)' } },
          y1: { position: 'right', ticks: { display: false }, grid: { display: false } },
        },
      },
    });
  }

  // ---------------------------------------------------------------------
  // Paste tab
  // ---------------------------------------------------------------------
  function renderPasteTab(row) {
    $('#screener-link').href = `https://www.screener.in/company/${row.symbol}/`;
    $('#screener-text-input').value = '';
  }

  function handlePasteSubmit() {
    if (!state.selectedTicker) return;
    const symbol = state.selectedTicker.replace('.NS', '');
    const text = $('#screener-text-input').value;
    if (!text.trim()) { showToast('Paste some Screener.in text first'); return; }

    try {
      const parsed = CanSlim.parseScreenerText(text);
      // Merge: keep any ratios already cached (e.g. market cap) if the paste didn't include them
      const existing = fundamentalsFor(symbol) || {};
      parsed.ratios = { ...(existing.ratios || {}), ...(parsed.ratios || {}) };
      state.sessionFundamentalsOverrides[symbol.toUpperCase()] = parsed;

      const row = findRow(symbol);
      const result = scoreStock(row);
      renderHero(row, result);
      renderLedger(result);
      renderThesis(result);
      showToast(`Recalculated ${symbol} — new score ${result.total_score}/100 (session only)`);
      $('.tab-btn[data-tab="tab-scorecard"]').click();
    } catch (e) {
      console.error(e);
      showToast('Could not parse that text — check it includes the Screener.in tables');
    }
  }

  // ---------------------------------------------------------------------
  // Thesis (tiny markdown -> HTML for our fixed template subset)
  // ---------------------------------------------------------------------
  function miniMarkdown(md) {
    const lines = md.split('\n');
    let html = '';
    let inTable = false;
    let inList = false;

    for (let raw of lines) {
      const line = raw;
      if (/^\s*---\s*$/.test(line)) { html += '<hr>'; continue; }
      if (/^####\s/.test(line)) { html += `<h4>${inline(line.replace(/^####\s/, ''))}</h4>`; continue; }
      if (/^###\s/.test(line)) { html += `<h3>${inline(line.replace(/^###\s/, ''))}</h3>`; continue; }

      if (/^\|/.test(line.trim())) {
        const cells = line.trim().slice(1, -1).split('|').map(c => c.trim());
        if (cells.every(c => /^:?-+:?$/.test(c))) continue; // separator row
        if (!inTable) { html += '<table>'; inTable = true; html += `<thead><tr>${cells.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`; continue; }
        html += `<tr>${cells.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`;
        continue;
      } else if (inTable) { html += '</tbody></table>'; inTable = false; }

      if (/^\*\s/.test(line)) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += `<li>${inline(line.replace(/^\*\s/, ''))}</li>`;
        continue;
      } else if (inList) { html += '</ul>'; inList = false; }

      if (line.trim() === '') continue;
      html += `<p>${inline(line)}</p>`;
    }
    if (inTable) html += '</tbody></table>';
    if (inList) html += '</ul>';
    return html;
  }
  function inline(s) {
    return escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>');
  }

  function renderThesis(result) {
    $('#thesis-content').innerHTML = miniMarkdown(result.thesis);
    renderThesis._current = result;
  }

  function copyClaudePrompt() {
    const result = renderThesis._current;
    if (!result) { showToast('Select a stock first'); return; }
    const prompt = `You are an expert equity research analyst. Using the CAN SLIM® growth-investing framework, review the following quantitative scorecard for ${result.ticker} (Indian NSE-listed stock) and produce a concise, balanced investment thesis with explicit risks and a suggested watchlist trigger price.\n\n${result.thesis}`;
    navigator.clipboard.writeText(prompt).then(
      () => showToast('Prompt copied — paste it into Claude or Gemini'),
      () => showToast('Could not copy — select and copy manually')
    );
  }

  // ---------------------------------------------------------------------
  // Sector scanner
  // ---------------------------------------------------------------------
  function renderSectorOptions() {
    const rows = state.universes[state.currentUniverse] || [];
    const sectors = Array.from(new Set(rows.map(r => r.industry).filter(i => i && i !== 'N/A' && i !== 'Unclassified'))).sort();
    const select = $('#scanner-sector-select');
    select.innerHTML = '<option value="ALL">All sectors</option>' + sectors.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  }

  function renderScanner() {
    const rows = state.universes[state.currentUniverse] || [];
    const sectorFilter = $('#scanner-sector-select').value;
    const filtered = sectorFilter === 'ALL' ? rows : rows.filter(r => r.industry === sectorFilter);

    const scored = filtered.map(row => {
      const result = scoreStock(row);
      return { row, score: result.total_score };
    });

    const leaders = scored.filter(s => s.score >= 80).sort((a, b) => b.score - a.score);
    const watchlist = scored.filter(s => s.score >= 60 && s.score < 80).sort((a, b) => b.score - a.score);
    const avoid = scored.filter(s => s.score < 60).sort((a, b) => b.score - a.score);

    $('#count-leaders').textContent = leaders.length;
    $('#count-watchlist').textContent = watchlist.length;
    $('#count-avoid').textContent = avoid.length;

    fillScannerList('#scanner-list-leaders', leaders);
    fillScannerList('#scanner-list-watchlist', watchlist);
    fillScannerList('#scanner-list-avoid', avoid);
  }

  function fillScannerList(sel, items) {
    const el = $(sel);
    if (!items.length) { el.innerHTML = '<div class="list-empty">None</div>'; return; }
    el.innerHTML = items.map(({ row, score }) => `
      <div class="scanner-item" data-symbol="${row.symbol}">
        <div><span class="si-symbol">${row.symbol}</span><div class="si-name">${escapeHtml(row.company_name)}</div></div>
        <span class="si-score">${score}</span>
      </div>`).join('');
    Array.from(el.querySelectorAll('.scanner-item')).forEach(item =>
      item.addEventListener('click', () => selectStock(item.dataset.symbol)));
  }

  // ---------------------------------------------------------------------
  // CSV export (Sector Scanner)
  // ---------------------------------------------------------------------
  function exportScannerCsv() {
    const rows = state.universes[state.currentUniverse] || [];
    const sectorFilter = $('#scanner-sector-select').value;
    const filtered = sectorFilter === 'ALL' ? rows : rows.filter(r => r.industry === sectorFilter);

    const lines = [['Symbol', 'Company', 'Industry', 'RS Rating', 'CAN SLIM Score', 'Verdict'].join(',')];
    filtered.forEach(row => {
      const result = scoreStock(row);
      const rs = rsRatingFor(row);
      lines.push([
        row.symbol,
        `"${(row.company_name || '').replace(/"/g, '""')}"`,
        row.industry,
        rs,
        result.total_score,
        result.recommendation,
      ].join(','));
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `canslim-scanner-${state.currentUniverse}-${sectorFilter}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${filtered.length} stocks to CSV`);
  }

  // ---------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------
  function wireEvents() {
    $('#stock-search').addEventListener('input', debounce(renderStockList, 120));

    $$('.uni-btn').forEach(btn => btn.addEventListener('click', () => {
      $$('.uni-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentUniverse = btn.dataset.uni;
      renderStockList();
      renderSectorOptions();
      renderScanner();
      renderTickerTape();
    }));

    $$('.sort-btn').forEach(btn => btn.addEventListener('click', () => {
      $$('.sort-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentSort = btn.dataset.sort;
      renderStockList();
    }));

    $$('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      $$('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      $('#' + btn.dataset.tab).classList.add('active');
    }));

    $('#btn-tab-scanner-jump').addEventListener('click', () => {
      if (!state.selectedTicker) {
        // No stock selected yet — just jump into the first row so the dashboard renders
        const rows = state.universes[state.currentUniverse];
        if (rows && rows.length) selectStock(rows[0].symbol);
      }
      $('.tab-btn[data-tab="tab-scanner"]').click();
    });

    $('#btn-submit-analysis').addEventListener('click', handlePasteSubmit);
    $('#btn-copy-prompt').addEventListener('click', copyClaudePrompt);
    $('#scanner-sector-select').addEventListener('change', renderScanner);
    $('#btn-export-csv').addEventListener('click', exportScannerCsv);
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
