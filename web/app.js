// Lenox Solar dashboard: live via WebSocket, history via REST. No build step.
const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const fmtW = (w) => (Math.abs(w) >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${Math.round(w)} W`);
const fmtKWh = (k) => (k == null ? '–' : `${k.toFixed(1)}`);

// Fixed series identity: one entity, one colour, everywhere.
const SERIES = {
  pv: { label: 'Solar', var: '--s-pv' },
  load: { label: 'Home', var: '--s-load' },
  batt: { label: 'Battery', var: '--s-batt' },
  grid: { label: 'Grid', var: '--s-grid' },
};

/* ---------------- live ---------------- */
let last = null;
let lastAt = 0;
let wsOk = false;

function setConn(state, text) {
  $('conn').dataset.state = state;
  $('conn-text').textContent = text;
}

function edge(id, watts, reverse) {
  const e = $(id);
  const on = Math.abs(watts) >= 15;
  e.classList.toggle('on', on);
  e.classList.toggle('rev', on && reverse);
  // faster dashes for more power: 2.4 s at ~0 W → 0.5 s at 5 kW+
  e.style.setProperty('--dur', `${Math.max(0.5, 2.4 - Math.abs(watts) / 2600).toFixed(2)}s`);
}

function renderLive(s) {
  last = s;
  lastAt = Date.now();
  const b = s.battery, g = s.grid;

  // flow: solar → inv; grid ↔ inv (import flows right); inv → load; battery: discharge flows up
  edge('e-pv', s.pv.powerW, false);
  edge('e-grid', g.connected ? g.powerW : 0, g.powerW < 0);
  edge('e-load', s.load.powerW, false);
  edge('e-batt', b.powerW, b.powerW > 0);
  $('v-pv').textContent = fmtW(s.pv.powerW);
  $('v-load').textContent = fmtW(s.load.powerW);
  $('v-grid').textContent = g.connected ? fmtW(Math.abs(g.powerW)) + (g.powerW < -15 ? ' out' : '') : 'Off';
  $('v-batt').textContent = `${fmtW(Math.abs(b.powerW))}${b.state === 'charging' ? ' in' : b.state === 'discharging' ? ' out' : ''}`;
  document.querySelector('.ring.s-grid').parentElement.classList.toggle('off', !g.connected);
  $('inv-state').textContent = `Inverter ${s.inverter.state}`;

  // battery
  $('soc').textContent = b.soc;
  $('socfill').style.width = `${Math.min(100, Math.max(0, b.soc))}%`;
  $('socbar').setAttribute('aria-valuenow', b.soc);
  $('batt-state').textContent = b.state[0].toUpperCase() + b.state.slice(1);
  $('b-v').textContent = `${b.voltage.toFixed(2)} V`;
  $('b-a').textContent = `${Math.abs(b.currentA).toFixed(1)} A`;
  $('b-w').textContent = fmtW(Math.abs(b.powerW));
  $('b-t').textContent = b.tempC == null ? 'No sensor' : `${b.tempC} °C`;

  // today
  const t = s.today;
  $('t-pv').textContent = fmtKWh(t.pvKWh);
  $('t-load').textContent = fmtKWh(t.loadKWh);
  $('t-grid').textContent = fmtKWh(t.gridImportKWh);
  $('t-batt').textContent = `${fmtKWh(t.batteryChargeKWh)} / ${fmtKWh(t.batteryDischargeKWh)}`;
  $('t-self').textContent = t.loadKWh > 0 ? `${Math.round(Math.max(0, Math.min(1, 1 - t.gridImportKWh / t.loadKWh)) * 100)}%` : '–';

  // details
  const [p1, p2] = s.pv.strings;
  $('d-pv1').textContent = p1 ? `${fmtW(p1.powerW)} · ${p1.voltage} V · ${p1.current} A` : '–';
  $('d-pv2').textContent = p2 ? `${fmtW(p2.powerW)} · ${p2.voltage} V · ${p2.current} A` : '–';
  $('d-grid').textContent = g.connected ? `${g.voltage} V · ${g.frequency} Hz · ${fmtW(g.powerW)}` : 'Disconnected';
  $('d-out').textContent = `${s.inverter.outputVoltage} V · ${s.inverter.outputFrequency} Hz`;
  $('d-temp').textContent = `${s.inverter.tempDcTransformerC} °C / ${s.inverter.tempRadiatorC} °C`;
  const faults = s.inverter.faultCodes.some((c) => c !== 0);
  $('d-fault').textContent = faults ? `⚠ ${s.inverter.faultCodes.map((c) => c.toString(16)).join(' ')}` : '✓ None';
  $('d-life').textContent = `${Math.round(s.total.pvKWh).toLocaleString()} kWh`;
  if (s.inverter.serial) $('d-serial').textContent = `${s.inverter.serial} · ${(s.inverter.ratedPowerW / 1000).toFixed(0)} kW`;
  if (s.inverter.clock) $('clock').textContent = `Inverter clock ${s.inverter.clock.slice(11, 16)}`;
  document.title = `${s.pv.powerW} W solar · ${b.soc}% · Lenox Solar`;
  updateConn();
}

let serverStatus = null;
function renderStatus(st) {
  serverStatus = st;
  if (st.donglePn) $('foot-pn').textContent = `Dongle ${st.donglePn}`;
  updateConn();
}

function updateConn() {
  const age = lastAt ? Math.round((Date.now() - lastAt) / 1000) : Infinity;
  const span = age < 120 ? `${age}s` : `${Math.round(age / 60)} min`;
  const ago = age === Infinity ? '' : ` · data ${span} old`;
  // Freeze + dim the live view whenever the numbers on screen are not current.
  document.body.classList.toggle('stale', age > 10);
  if (!wsOk) return setConn('down', `Server offline${ago}`);
  if (serverStatus && !serverStatus.dongleConnected) return setConn('down', `Dongle not connected${ago}`);
  if (serverStatus && serverStatus.inverterResponding === false) return setConn('down', `Inverter not answering${ago}`);
  if (!lastAt) return setConn('wait', 'Waiting for data');
  if (age <= 10) setConn('live', 'Live');
  else setConn('stale', `Last update ${span} ago`);
}
setInterval(updateConn, 1000);

function connectWs(delay = 1000) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/live`);
  ws.onopen = () => { wsOk = true; delay = 1000; updateConn(); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'snapshot') { renderLive(m.data); liveAppend(m.data); }
    else if (m.type === 'status') renderStatus(m.data);
  };
  ws.onclose = () => {
    wsOk = false; updateConn();
    setTimeout(() => connectWs(Math.min(delay * 2, 15000)), delay);
  };
}

/* ---------------- history (uPlot) ---------------- */
let range = (() => { try { return localStorage.getItem('range') || '6h'; } catch { return '6h'; } })();
let hist = null;
let plots = [];
let lastLiveAppend = 0;

function axes(fmt) {
  const c = { stroke: css('--muted'), grid: { stroke: css('--grid'), width: 1 }, ticks: { stroke: css('--grid'), width: 1 }, font: '11px system-ui, sans-serif' };
  return [c, { ...c, values: (u, vals) => vals.map(fmt), size: 64 }];
}

function makePlot(el, series, data, yFmt, height, opts = {}) {
  const width = el.clientWidth || 600;
  return new uPlot({
    width, height,
    cursor: { points: { size: 8, width: 2, stroke: css('--surface') }, drag: { x: false, y: false } },
    legend: { live: true },
    scales: { x: { time: true }, y: opts.y || {} },
    axes: axes(yFmt),
    series: [
      { value: (u, v) => (v == null ? '–' : new Date(v * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })) },
      ...series.map((s) => ({ label: s.label, stroke: css(s.var), width: 2, points: { show: false }, value: (u, v) => (v == null ? '–' : yFmt(v)) })),
    ],
  }, data, el);
}

function drawHistory() {
  for (const p of plots) p.destroy();
  plots = [];
  const pts = hist?.points ?? [];
  $('hist-empty').hidden = pts.length > 1;
  $('chart-power').hidden = $('chart-soc').hidden = pts.length <= 1;
  if (pts.length <= 1) return;
  const xs = pts.map((p) => p.ts / 1000);
  plots.push(makePlot($('chart-power'), [SERIES.pv, SERIES.load, SERIES.batt, SERIES.grid],
    [xs, pts.map((p) => p.pv_w), pts.map((p) => p.load_w), pts.map((p) => p.batt_w), pts.map((p) => p.grid_w)],
    (v) => fmtW(v), 260));
  plots.push(makePlot($('chart-soc'), [{ label: 'State of charge', var: '--s-batt' }],
    [xs, pts.map((p) => p.batt_soc)], (v) => `${Math.round(v)}%`, 140, { y: { range: [0, 100] } }));
}

async function loadHistory() {
  document.querySelectorAll('#ranges button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.r === range)));
  try {
    hist = await (await fetch(`/api/history?range=${range}`)).json();
  } catch { hist = null; }
  drawHistory();
}

/** For short ranges, append live snapshots so the chart moves between reloads. */
function liveAppend(s) {
  if (!hist || !plots.length || !['1h', '6h'].includes(range)) return;
  const now = Date.parse(s.time);
  if (now - lastLiveAppend < hist.bucketSec * 1000) return;
  lastLiveAppend = now;
  hist.points.push({ ts: now, pv_w: s.pv.powerW, load_w: s.load.powerW, batt_w: s.battery.powerW, grid_w: s.grid.powerW, batt_soc: s.battery.soc });
  const cutoff = now - { '1h': 3600e3, '6h': 6 * 3600e3 }[range];
  while (hist.points.length && hist.points[0].ts < cutoff) hist.points.shift();
  const pts = hist.points, xs = pts.map((p) => p.ts / 1000);
  plots[0].setData([xs, pts.map((p) => p.pv_w), pts.map((p) => p.load_w), pts.map((p) => p.batt_w), pts.map((p) => p.grid_w)]);
  plots[1].setData([xs, pts.map((p) => p.batt_soc)]);
}

$('ranges').addEventListener('click', (e) => {
  const r = e.target.closest('button')?.dataset.r;
  if (!r || r === range) return;
  range = r;
  try { localStorage.setItem('range', r); } catch { /* ignore */ }
  void loadHistory();
});

/* ---------------- daily energy (SVG grouped bars) ---------------- */
const DAILY = [
  { key: 'pvKWh', ...SERIES.pv },
  { key: 'loadKWh', ...SERIES.load },
  { key: 'gridImportKWh', label: 'Grid bought', var: '--s-grid' },
];
let daily = [];

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

function drawDaily() {
  const el = $('daily');
  $('daily-legend').innerHTML = DAILY.map((s) => `<span><i class="sw" style="background:var(${s.var})"></i>${s.label}</span>`).join('');
  if (!daily.length) { el.innerHTML = '<p class="empty">No daily totals yet.</p>'; return; }
  const W = Math.max(320, el.clientWidth), H = 220, padL = 36, padB = 22, padT = 8;
  const max = niceMax(Math.max(...daily.flatMap((d) => DAILY.map((s) => d[s.key] || 0))));
  const n = daily.length, slot = (W - padL) / n, gap = 2;
  const bw = Math.max(3, Math.min(18, (slot - 8) / DAILY.length - gap));
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  let out = '';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    out += `<line class="${i ? 'gridline' : 'baseline'}" x1="${padL}" x2="${W}" y1="${yy}" y2="${yy}"/>`;
    out += `<text class="axis-t" x="${padL - 6}" y="${yy + 4}" text-anchor="end">${+v.toFixed(1)}</text>`;
  }
  const labelEvery = Math.ceil(n / Math.floor((W - padL) / 44));
  daily.forEach((d, i) => {
    const groupW = DAILY.length * (bw + gap) - gap;
    const x0 = padL + i * slot + (slot - groupW) / 2;
    DAILY.forEach((s, k) => {
      const v = d[s.key] || 0, top = y(v), h = Math.max(0, H - padB - top), x = x0 + k * (bw + gap), r = Math.min(4, bw / 2, h);
      // rounded data-end, square at the baseline
      const path = h <= 0 ? '' : `M${x} ${H - padB}V${top + r}Q${x} ${top} ${x + r} ${top}H${x + bw - r}Q${x + bw} ${top} ${x + bw} ${top + r}V${H - padB}Z`;
      if (path) out += `<path class="bar" fill="var(${s.var})" d="${path}"/>`;
    });
    // hit target spans the whole day group
    out += `<rect class="hit" data-i="${i}" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${H - padT - padB}" fill="transparent" tabindex="0"/>`;
    if (i % labelEvery === 0) out += `<text class="axis-t" x="${padL + i * slot + slot / 2}" y="${H - 6}" text-anchor="middle">${d.date.slice(8)}/${d.date.slice(5, 7)}</text>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily solar, home and grid energy in kWh">${out}</svg>`;
  const tip = $('tip');
  const show = (ev) => {
    const i = Number(ev.target.dataset.i);
    if (Number.isNaN(i)) return;
    const d = daily[i];
    tip.innerHTML = `<b>${new Date(d.date + 'T12:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</b>` +
      DAILY.map((s) => `<div class="row"><span><i class="sw" style="background:var(${s.var})"></i>${s.label}</span><span>${fmtKWh(d[s.key])} kWh</span></div>`).join('') +
      `<div class="row"><span>Battery in / out</span><span>${fmtKWh(d.batteryChargeKWh)} / ${fmtKWh(d.batteryDischargeKWh)}</span></div>`;
    tip.hidden = false;
    const r = ev.target.getBoundingClientRect();
    const tx = Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2));
    tip.style.left = `${tx}px`;
    tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 6)}px`;
  };
  el.querySelectorAll('.hit').forEach((h) => {
    h.addEventListener('pointerenter', show); h.addEventListener('focus', show);
    h.addEventListener('pointerleave', () => (tip.hidden = true)); h.addEventListener('blur', () => (tip.hidden = true));
  });
  $('daily-table').innerHTML = `<table><thead><tr><th>Date</th>${DAILY.map((s) => `<th>${s.label}</th>`).join('')}<th>Battery in</th><th>Battery out</th></tr></thead><tbody>` +
    [...daily].reverse().map((d) => `<tr><td>${d.date}</td>${DAILY.map((s) => `<td>${fmtKWh(d[s.key])}</td>`).join('')}<td>${fmtKWh(d.batteryChargeKWh)}</td><td>${fmtKWh(d.batteryDischargeKWh)}</td></tr>`).join('') +
    '</tbody></table>';
}

async function loadDaily() {
  try { daily = (await (await fetch('/api/energy/daily?days=30')).json()).days; } catch { daily = []; }
  drawDaily();
}

$('daily-toggle').addEventListener('click', () => {
  const t = $('daily-table'), open = t.hidden;
  t.hidden = !open;
  $('daily-toggle').setAttribute('aria-expanded', String(open));
  $('daily-toggle').textContent = open ? 'Hide table' : 'Show table';
});

/* ---------------- boot ---------------- */
let resizeT;
const redraw = () => { clearTimeout(resizeT); resizeT = setTimeout(() => { drawHistory(); drawDaily(); }, 150); };
window.addEventListener('resize', redraw);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw);

fetch('/api/live').then((r) => (r.ok ? r.json() : null)).then((s) => s && renderLive(s)).catch(() => {});
connectWs();
void loadHistory();
void loadDaily();
setInterval(() => { if (!['1h', '6h'].includes(range)) void loadHistory(); }, 5 * 60_000);
setInterval(loadDaily, 10 * 60_000);
