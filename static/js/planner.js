// Plánování trasy: body na mapě, úseky po cestách / přímo, výškový profil, odhad času,
// lavinový terén na trase a počasí v čase průchodu.
import { num, esc, store, addDays, dayLabel, nowHourKey, ASPECTS, ASPECT_CS, windDirCs } from './util.js';
import {
  computeSegment, segmentForExport, resample, simplify, buildGpx, parseGpx, haversine, ENGINES, HAS_MAPY,
} from './routing.js';
import { sampleTerrain } from './terrain.js';
import { sunElevation } from './webcam.js';

/* global L */

const ROUTE_COLOR = '#e5195f';
const BANDS = [
  { min: 30, color: '#f5c400', label: '30–35°' },
  { min: 35, color: '#ff7a00', label: '35–40°' },
  { min: 40, color: '#e0201b', label: '40–45°' },
  { min: 45, color: '#8c1ea0', label: 'nad 45°' },
];
const band = s => (s == null || s < 30 ? -1 : s < 35 ? 0 : s < 40 ? 1 : s < 45 ? 2 : 3);
const PACES = [300, 350, 400, 450, 500, 600];
const MAX_POINTS = 60;

function defaultStart() {
  const d = new Date();
  if (d.getHours() < 11) { d.setHours(d.getHours() + 1, 0, 0, 0); if (d.getHours() < 6) d.setHours(7); }
  else { d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); }
  return localIso(d);
}
const p2 = n => String(n).padStart(2, '0');
const localIso = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
const hhmm = d => `${d.getHours()}:${p2(d.getMinutes())}`;
const fmtDur = h => `${Math.floor(h)} h ${p2(Math.round((h % 1) * 60) % 60)} min`;
const km = m => num(m / 1000, m < 10000 ? 1 : 0);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/**
 * ctx: { map, viewEl, isShown(), aval: { bulletinFor, bulletinLevel, regionName, regions(), DANGER, PROBLEM_CS, NO_PROBLEM },
 *        openModal, qrSvg, setView, openSidebar, featureContains }
 */
export function createPlanner(ctx) {
  const { map } = ctx;
  map.createPane('plannerPane').style.zIndex = 450;

  const P = {
    points: [], segs: [], analysis: null,
    engine: store.get('rt.engine', HAS_MAPY ? 'mapy' : 'brouter'),
    newMode: store.get('rt.mode', 'route'),
    pace: store.get('rt.pace', 400),
    colorBySlope: store.get('rt.colorSlope', true),
    adding: true, start: defaultStart(), name: '',
    busy: false, version: 0, error: null,
    weather: null, weatherKey: '', weatherBusy: false, weatherErr: null,
  };
  if (P.engine === 'mapy' && !HAS_MAPY) P.engine = 'brouter';

  const lineLayer = L.layerGroup().addTo(map);
  const markerLayer = L.layerGroup().addTo(map);
  const hoverMarker = L.circleMarker([0, 0], {
    pane: 'plannerPane', radius: 7, color: '#fff', weight: 3, fillColor: ROUTE_COLOR, fillOpacity: 1, interactive: false,
  });

  // ---------------------------------------------------------------- body
  function isActive() { return ctx.isShown() && P.adding; }

  function addPoint(latlng) {
    if (P.points.length >= MAX_POINTS) return;
    P.points.push({ lat: +latlng.lat.toFixed(6), lon: +latlng.lng.toFixed(6), mode: P.newMode });
    changed();
  }

  function insertPoint(idx, latlng) {
    const mode = P.points[idx]?.mode || P.newMode;
    P.points.splice(idx, 0, { lat: +latlng.lat.toFixed(6), lon: +latlng.lng.toFixed(6), mode });
    changed();
  }

  function removePoint(i) { P.points.splice(i, 1); map.closePopup(); changed(); }

  function movePoint(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= P.points.length) return;
    [P.points[i], P.points[j]] = [P.points[j], P.points[i]];
    changed();
  }

  function reverse() {
    const modes = P.points.map(p => p.mode);
    P.points.reverse();
    // režim patří k úseku – po otočení se posune o jeden bod
    P.points.forEach((p, i) => { p.mode = i === 0 ? P.newMode : modes[modes.length - i]; });
    changed();
  }

  function clear() {
    P.points = []; P.segs = []; P.analysis = null; P.weather = null; P.weatherKey = ''; P.name = '';
    changed();
  }

  function setPoints(pts, opts = {}) {
    P.points = pts.slice(0, MAX_POINTS);
    if (opts.name != null) P.name = opts.name;
    if (opts.start) P.start = opts.start;
    changed({ fit: true });
  }

  function startFrom(lat, lon) {
    P.points = [{ lat, lon, mode: P.newMode }];
    P.adding = true;
    changed();
  }

  let fitPending = false;
  function changed(opts = {}) {
    if (opts.fit) fitPending = true;
    renderMarkers();
    renderPanel();
    recompute();
  }

  // ---------------------------------------------------------------- výpočet
  async function recompute() {
    const v = ++P.version;
    P.error = null;
    if (P.points.length < 2) {
      P.segs = []; P.analysis = null; P.busy = false;
      renderLines(); renderResults(); updateHash();
      return;
    }
    P.busy = true;
    renderResults();
    const pairs = P.points.slice(1).map((b, i) => [P.points[i], b]);
    const segs = await mapLimit(pairs, 4, ([a, b]) => computeSegment(a, b, b.mode, P.engine));
    if (v !== P.version) return;
    P.segs = segs;
    renderLines();
    try {
      const samples = resample(segs.map(s => s.coords), 25);
      const terr = await sampleTerrain(samples);
      if (v !== P.version) return;
      P.analysis = analyze(samples, terr);
    } catch (e) {
      console.warn(e);
      P.error = 'Výškový profil se nepodařilo spočítat (výškový model je nedostupný).';
      P.analysis = null;
    }
    P.busy = false;
    renderLines();
    renderResults();
    updateHash();
    if (fitPending) { fitPending = false; fit(); }
    scheduleWeather();
  }

  function smooth(arr, r) {
    return arr.map((_, i) => {
      let s = 0, n = 0;
      for (let k = Math.max(0, i - r); k <= Math.min(arr.length - 1, i + r); k++) if (Number.isFinite(arr[k])) { s += arr[k]; n++; }
      return n ? s / n : null;
    });
  }

  const bboxCache = new WeakMap();
  function regionAt(lon, lat) {
    for (const f of ctx.aval.regions()?.features || []) {
      let bb = bboxCache.get(f);
      if (!bb) {
        bb = [Infinity, Infinity, -Infinity, -Infinity];
        const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        for (const rings of polys) for (const [x, y] of rings[0]) {
          bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], y); bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], y);
        }
        bboxCache.set(f, bb);
      }
      if (lon < bb[0] || lon > bb[2] || lat < bb[1] || lat > bb[3]) continue;
      if (ctx.featureContains(f, lon, lat)) return f.properties.id;
    }
    return null;
  }

  function analyze(samples, terr) {
    const n = samples.length;
    const ele = smooth(terr.ele.map(e => (Number.isFinite(e) ? e : null)), 2);
    let up = 0, down = 0, ref = ele[0], maxE = -Infinity, minE = Infinity, maxI = 0;
    for (let i = 0; i < n; i++) {
      const e = ele[i];
      if (e == null) continue;
      if (ref == null) ref = e;
      if (e > maxE) { maxE = e; maxI = i; }
      minE = Math.min(minE, e);
      if (e - ref >= 4) { up += e - ref; ref = e; } else if (ref - e >= 4) { down += ref - e; ref = e; }
    }
    // body trasy (indexy vzorků)
    const wpIdx = [0];
    for (let i = 1; i < n; i++) if (samples[i].seg !== samples[i - 1].seg) wpIdx.push(i - 1);
    wpIdx.push(n - 1);
    // délky přes strmý terén a souvislé strmé úseky
    const bandLen = [0, 0, 0, 0];
    const runs = [];
    let run = null;
    for (let i = 1; i < n; i++) {
      const b = band(terr.slope[i]);
      const dd = samples[i].d - samples[i - 1].d;
      if (b >= 0) bandLen[b] += dd;
      if (b >= 0) {
        if (run && samples[i].d - samples[run.end].d <= 60) run.end = i;
        else { run = { start: i, end: i }; runs.push(run); }
      }
    }
    for (const r of runs) {
      let mx = 0, asp = new Array(8).fill(0), e0 = Infinity, e1 = -Infinity;
      for (let i = r.start; i <= r.end; i++) {
        if (terr.slope[i] > mx) mx = terr.slope[i];
        if (terr.aspect[i] != null && terr.slope[i] >= 30) asp[terr.aspect[i]]++;
        if (ele[i] != null) { e0 = Math.min(e0, ele[i]); e1 = Math.max(e1, ele[i]); }
      }
      r.max = mx; r.aspect = asp.indexOf(Math.max(...asp)); r.e0 = e0; r.e1 = e1;
      r.len = samples[r.end].d - samples[r.start].d + 25;
    }
    const region = samples.map(s => regionAt(s.lon, s.lat));
    const A = { samples, ele, slope: terr.slope, aspect: terr.aspect, up, down, maxE, minE, maxI,
      dist: samples[n - 1].d, wpIdx, bandLen, runs: runs.filter(r => r.len >= 40), region };
    computeTimes(A);
    return A;
  }

  /** Odhad času: výstup podle tempa (m/h), rovina 4 km/h, sjezd ~12 km/h, přepnutí pásů. */
  function computeTimes(A) {
    const { samples, ele } = A;
    const t = [0];
    let dir = 0, extreme = ele[0] ?? 0, total = 0, lastSwitchI = 0;
    for (let i = 1; i < samples.length; i++) {
      const dist = samples[i].d - samples[i - 1].d;
      const dh = (ele[i] ?? 0) - (ele[i - 1] ?? 0);
      const grade = dist ? dh / dist : 0;
      let dt;
      if (grade > -0.05) {
        const hor = dist / 4000, ver = Math.max(dh, 0) / P.pace;
        dt = Math.max(hor, ver) + Math.min(hor, ver) / 2;
      } else if (grade < -0.1) {
        dt = Math.max(dist / 12000, -dh / 2500);
      } else {
        dt = dist / 5000;
      }
      total += dt;
      // změna stoupání ↔ klesání o víc než 60 m = sundat / nalepit pásy
      const e = ele[i] ?? extreme;
      if (dir >= 0 && e < extreme - 60) { if (dir > 0 && i - lastSwitchI > 2) total += 0.25; dir = -1; extreme = e; lastSwitchI = i; }
      else if (dir <= 0 && e > extreme + 60) { if (dir < 0 && i - lastSwitchI > 2) total += 0.15; dir = 1; extreme = e; lastSwitchI = i; }
      else if ((dir >= 0 && e > extreme) || (dir < 0 && e < extreme)) extreme = e;
      t.push(total);
    }
    A.time = t;
    A.total = total;
  }

  const startDate = () => new Date(P.start);
  const etaAt = i => new Date(startDate().getTime() + (P.analysis?.time[i] || 0) * 3600e3);

  // ---------------------------------------------------------------- počasí
  let weatherTimer = null;
  function scheduleWeather() {
    clearTimeout(weatherTimer);
    weatherTimer = setTimeout(loadWeather, 400);
  }

  function weatherSamples(A) {
    const n = A.samples.length, step = Math.max(1500, A.dist / 10);
    const idx = new Set([0, n - 1, A.maxI]);
    let next = step;
    for (let i = 0; i < n; i++) if (A.samples[i].d >= next) { idx.add(i); next += step; }
    return [...idx].sort((a, b) => a - b).slice(0, 14);
  }

  async function loadWeather() {
    const A = P.analysis;
    if (!A) return;
    const idx = weatherSamples(A);
    const first = etaAt(0), last = etaAt(A.samples.length - 1);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if ((first - today) / 864e5 > 15) { P.weather = null; P.weatherErr = 'Předpověď počasí je jen na 16 dní dopředu.'; renderResults(); return; }
    const key = JSON.stringify([idx.map(i => [A.samples[i].lat.toFixed(4), A.samples[i].lon.toFixed(4)]), P.start, P.pace]);
    if (key === P.weatherKey && P.weather) return;
    P.weatherBusy = true; P.weatherErr = null;
    renderResults();
    const day = d => localIso(d).slice(0, 10);
    const q = new URLSearchParams({
      latitude: idx.map(i => A.samples[i].lat.toFixed(4)).join(','),
      longitude: idx.map(i => A.samples[i].lon.toFixed(4)).join(','),
      elevation: idx.map(i => Math.round(A.ele[i] ?? 0)).join(','),
      hourly: 'temperature_2m,precipitation,snowfall,rain,wind_speed_10m,wind_gusts_10m,wind_direction_10m,cloud_cover,visibility,freezing_level_height',
      timezone: 'Europe/Prague', wind_speed_unit: 'kmh', start_date: day(first), end_date: day(last),
    });
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      let j = await r.json();
      if (!Array.isArray(j)) j = [j];
      P.weather = idx.map((i, k) => {
        const h = j[k].hourly;
        const eta = etaAt(i);
        const hk = nowHourKey(new Date(eta.getTime() + 30 * 60e3)); // nejbližší celá hodina
        const t = h.time.indexOf(hk);
        const g = name => (t >= 0 ? h[name][t] : null);
        return {
          i, eta, d: A.samples[i].d, ele: A.ele[i], top: i === A.maxI,
          temp: g('temperature_2m'), wind: g('wind_speed_10m'), gust: g('wind_gusts_10m'), dir: g('wind_direction_10m'),
          precip: g('precipitation'), snow: g('snowfall'), rain: g('rain'), cloud: g('cloud_cover'),
          vis: g('visibility'), freezing: g('freezing_level_height'),
        };
      });
      P.weatherKey = key;
    } catch (e) {
      P.weather = null;
      P.weatherErr = `Počasí se nepodařilo načíst (${e.message || e}).`;
    }
    P.weatherBusy = false;
    renderResults();
  }

  function sunTimes(lat, lon, dateStr) {
    let rise = null, set = null, prev = null;
    const d0 = new Date(`${dateStr}T00:00`);
    for (let m = 0; m <= 1440; m += 2) {
      const t = new Date(d0.getTime() + m * 60e3);
      const e = sunElevation(lat, lon, t);
      if (prev != null) {
        if (prev < -0.833 && e >= -0.833 && !rise) rise = t;
        if (prev >= -0.833 && e < -0.833) set = t;
      }
      prev = e;
    }
    return { rise, set };
  }

  // ---------------------------------------------------------------- mapa
  function pointIcon(i) {
    const n = P.points.length;
    const cls = i === 0 ? 'rp-start' : i === n - 1 && n > 1 ? 'rp-end' : 'rp-mid';
    const label = i === 0 ? 'A' : i === n - 1 && n > 1 ? 'B' : String(i);
    return L.divIcon({ className: 'rp-icon', html: `<div class="rp ${cls}">${label}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
  }

  function pointPopup(i) {
    const p = P.points[i];
    const ele = P.analysis ? P.analysis.ele[P.analysis.wpIdx[i]] : null;
    return `<div class="pp"><div class="pp-title">${i === 0 ? 'Start' : i === P.points.length - 1 ? 'Cíl' : `Bod ${i}`}</div>
      <div class="muted">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}${ele != null ? ` · ${num(ele)} m` : ''}</div>
      ${i > 0 ? `<div class="pp-row">Úsek sem: <span class="seg small">
        <button data-act="rt-mode" data-i="${i}" data-m="route" class="${p.mode === 'route' ? 'on' : ''}">po cestách</button>
        <button data-act="rt-mode" data-i="${i}" data-m="line" class="${p.mode === 'line' ? 'on' : ''}">přímo</button></span></div>` : ''}
      <div class="row"><button class="btn small ghost" data-act="rt-del" data-i="${i}">Smazat bod</button></div></div>`;
  }

  function renderMarkers() {
    markerLayer.clearLayers();
    P.points.forEach((p, i) => {
      const m = L.marker([p.lat, p.lon], { icon: pointIcon(i), draggable: true, pane: 'markerPane', zIndexOffset: 2000, autoPan: true });
      m.on('dragend', () => {
        const ll = m.getLatLng();
        p.lat = +ll.lat.toFixed(6); p.lon = +ll.lng.toFixed(6);
        changed();
      });
      m.bindPopup(() => pointPopup(i), { minWidth: 220 });
      markerLayer.addLayer(m);
    });
  }

  function renderLines() {
    lineLayer.clearLayers();
    P.segs.forEach((s, i) => {
      const ll = s.coords.map(c => [c[1], c[0]]);
      const dash = s.engine === 'line' ? '8 8' : null;
      L.polyline(ll, { pane: 'plannerPane', color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(lineLayer);
      const line = L.polyline(ll, { pane: 'plannerPane', color: ROUTE_COLOR, weight: 5, opacity: 0.95, dashArray: dash, bubblingMouseEvents: false });
      // klik na trasu vloží mezi body nový bod
      line.on('click', e => { if (isActive()) insertPoint(i + 1, e.latlng); });
      line.addTo(lineLayer);
    });
    const A = P.analysis;
    if (A && P.colorBySlope) {
      // strmé úseky trasy obarvené podle sklonu terénu
      let cur = null;
      const flush = () => { if (cur && cur.pts.length > 1) L.polyline(cur.pts, { pane: 'plannerPane', color: BANDS[cur.b].color, weight: 5, opacity: 1, interactive: false }).addTo(lineLayer); };
      A.samples.forEach((s, i) => {
        const b = band(A.slope[i]);
        if (cur && b === cur.b) { cur.pts.push([s.lat, s.lon]); return; }
        if (cur) { cur.pts.push([s.lat, s.lon]); flush(); }
        cur = b >= 0 ? { b, pts: [[s.lat, s.lon]] } : null;
      });
      flush();
    }
  }

  function fit() {
    const size = map.getSize();
    if (size.x < 100 || size.y < 100) return; // karta na pozadí – mapa ještě nemá rozměry
    const pts = P.segs.length ? P.segs.flatMap(s => s.coords.map(c => [c[1], c[0]])) : P.points.map(p => [p.lat, p.lon]);
    // na mobilu zakrývá spodek mapy panel – trasu umístíme nad něj
    const sheet = window.innerWidth <= 760 ? (document.getElementById('sidebar')?.offsetHeight || 0) : 0;
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [40, 40], paddingBottomRight: [40, 40 + sheet], maxZoom: 15 });
  }

  // ---------------------------------------------------------------- odkaz a uložení
  function encode() {
    return P.points.map(p => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}${p.mode === 'line' ? 'p' : ''}`).join(';');
  }

  function updateHash() {
    const h = P.points.length ? `#trasa=${encode()}&start=${P.start}` : '';
    if (location.hash !== h) history.replaceState(null, '', location.pathname + location.search + h);
  }

  function loadFromHash() {
    const m = location.hash.match(/trasa=([^&]+)/);
    if (!m) return false;
    const pts = decodeURIComponent(m[1]).split(';').map(s => {
      const line = s.endsWith('p');
      const [lat, lon] = s.replace(/p$/, '').split(',').map(Number);
      return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon, mode: line ? 'line' : 'route' } : null;
    }).filter(Boolean);
    const st = location.hash.match(/start=([\d\-T:]+)/);
    if (pts.length) setPoints(pts, { start: st ? st[1] : undefined });
    return pts.length > 0;
  }

  function shareUrl() {
    return `${location.origin}${location.pathname}#trasa=${encode()}&start=${P.start}`;
  }

  const saved = () => store.get('rt.saved', []);
  function save() {
    const name = (P.name || '').trim() || `Trasa ${new Date().toLocaleDateString('cs-CZ')}`;
    P.name = name;
    const list = saved().filter(r => r.name !== name);
    list.unshift({ name, points: P.points, savedAt: Date.now(), dist: P.analysis?.dist, up: P.analysis?.up });
    store.set('rt.saved', list.slice(0, 30));
    renderPanel();
  }

  async function exportGpx() {
    if (P.segs.length === 0) return;
    const btn = document.querySelector('[data-act="rt-gpx"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Připravuji GPX…'; }
    try {
      const parts = await mapLimit(P.segs, 3, (s, i) => segmentForExport(s, P.points[i], P.points[i + 1]));
      const coords = [];
      for (const part of parts) for (const c of part) {
        const last = coords[coords.length - 1];
        if (!last || haversine(last, c) > 0.5) coords.push(c);
      }
      const pts = coords.map(c => ({ lon: c[0], lat: c[1] }));
      try { (await sampleTerrain(pts)).ele.forEach((e, i) => { pts[i].ele = e; }); } catch { /* bez výšek */ }
      const wps = P.points.map((p, i) => ({ lat: p.lat, lon: p.lon, name: i === 0 ? 'Start' : i === P.points.length - 1 ? 'Cíl' : `Bod ${i}` }));
      const name = P.name || 'Skialp trasa';
      const blob = new Blob([buildGpx(name, pts, wps)], { type: 'application/gpx+xml' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '-') || 'trasa'}.gpx`;
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Stáhnout GPX'; }
    }
  }

  async function importGpx(file) {
    try {
      const { name, coords } = parseGpx(await file.text());
      let tol = 12, s = simplify(coords, tol);
      while (s.length > MAX_POINTS && tol < 400) { tol *= 1.6; s = simplify(coords, tol); }
      setPoints(s.map(c => ({ lat: +c[1].toFixed(6), lon: +c[0].toFixed(6), mode: 'line' })),
        { name: name || file.name.replace(/\.gpx$/i, '') });
      P.adding = false;
      renderPanel();
    } catch (e) {
      alert(`GPX se nepodařilo načíst: ${e.message || e}`);
    }
  }

  // ---------------------------------------------------------------- panel
  function renderPanel() {
    if (!ctx.isShown()) return;
    const el = ctx.viewEl;
    const scroll = el.scrollTop;
    el.innerHTML = panelHtml();
    el.scrollTop = scroll;
    bindProfile();
    updateHint();
  }

  function renderResults() {
    if (!ctx.isShown()) return;
    const r = document.getElementById('rt-results');
    if (!r) return renderPanel();
    r.innerHTML = resultsHtml();
    const pts = document.getElementById('rt-points');
    if (pts) pts.innerHTML = pointsHtml();
    bindProfile();
  }

  function updateHint() {
    const hint = document.getElementById('plan-hint');
    if (hint) hint.classList.toggle('hidden', !isActive());
    map.getContainer().classList.toggle('planning', isActive());
  }

  function panelHtml() {
    const engines = `<div class="seg small">
      <button data-act="rt-engine" data-e="mapy" class="${P.engine === 'mapy' ? 'on' : ''}" ${HAS_MAPY ? '' : 'disabled title="Potřebuje klíč k API Mapy.com"'}>Mapy.com</button>
      <button data-act="rt-engine" data-e="brouter" class="${P.engine === 'brouter' ? 'on' : ''}">BRouter</button></div>`;
    return `
      <section class="rt-head">
        <h2>Plánování trasy</h2>
        <label class="check"><input type="checkbox" data-act="rt-adding" ${P.adding ? 'checked' : ''}> Přidávat body kliknutím do mapy</label>
        <div class="rt-opts">
          <div><span class="muted small">Nové úseky</span>
            <div class="seg small">
              <button data-act="rt-newmode" data-m="route" class="${P.newMode === 'route' ? 'on' : ''}">🥾 po cestách</button>
              <button data-act="rt-newmode" data-m="line" class="${P.newMode === 'line' ? 'on' : ''}">📏 přímo</button></div></div>
          <div><span class="muted small">Plánovač</span>${engines}</div>
        </div>
        ${HAS_MAPY ? '' : '<div class="muted small">Plánovač Mapy.com se zapne po doplnění klíče do <code>static/js/config.js</code>.</div>'}
      </section>
      <section><h3>Body trasy</h3><div id="rt-points">${pointsHtml()}</div></section>
      <div id="rt-results">${resultsHtml()}</div>
      <section>
        <h3>Uložit a sdílet</h3>
        <input class="rt-name" data-act="rt-name" placeholder="Název trasy" value="${esc(P.name)}">
        <div class="row">
          <button class="btn small" data-act="rt-share" ${P.points.length < 2 ? 'disabled' : ''}>Sdílet odkaz</button>
          <button class="btn small" data-act="rt-save" ${P.points.length < 2 ? 'disabled' : ''}>Uložit</button>
          <button class="btn small" data-act="rt-gpx" ${P.points.length < 2 ? 'disabled' : ''}>Stáhnout GPX</button>
          <label class="btn small ghost">Nahrát GPX<input type="file" accept=".gpx,application/gpx+xml" data-act="rt-import" hidden></label>
        </div>
        ${savedHtml()}
      </section>`;
  }

  function pointsHtml() {
    if (!P.points.length) {
      return `<p class="muted">Klikni do mapy na místo startu, pak na další body a cíl. Body jde přetahovat,
        kliknutím na trasu vložíš bod mezi, kliknutím na bod ho smažeš nebo změníš typ úseku.</p>
        <p class="muted small">„Po cestách“ vede trasu po značených cestách a pěšinách, „přímo“ rovnou čarou – hodí se pro výstupy a sjezdy mimo cesty.</p>`;
    }
    const A = P.analysis;
    const items = P.points.map((p, i) => {
      const s = i > 0 ? P.segs[i - 1] : null;
      const ele = A ? A.ele[A.wpIdx[i]] : null;
      const eta = A ? etaAt(A.wpIdx[i]) : null;
      const label = i === 0 ? 'A' : i === P.points.length - 1 && P.points.length > 1 ? 'B' : i;
      const cls = i === 0 ? 'rp-start' : i === P.points.length - 1 && P.points.length > 1 ? 'rp-end' : 'rp-mid';
      return `<li>
        <span class="rp ${cls}">${label}</span>
        <div class="rt-pt">
          <div>${ele != null ? `<b>${num(ele)} m</b>` : `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`}${eta ? ` <span class="muted">· ${hhmm(eta)}</span>` : ''}</div>
          ${i > 0 ? `<button class="rt-modebtn" data-act="rt-mode" data-i="${i}" data-m="${p.mode === 'route' ? 'line' : 'route'}" title="Přepnout typ úseku">
            ${p.mode === 'route' ? '🥾 po cestách' : '📏 přímo'}</button>
            <span class="muted small">${s ? (s.engine === 'line' && p.mode === 'route' ? '⚠ ' : '') + esc(s.note || (s.engine !== 'line' ? ENGINES[s.engine].label : '')) : '…'}</span>` : ''}
        </div>
        <span class="rt-btns">
          <button data-act="rt-up" data-i="${i}" title="Posunout výš" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button data-act="rt-down" data-i="${i}" title="Posunout níž" ${i === P.points.length - 1 ? 'disabled' : ''}>↓</button>
          <button data-act="rt-del" data-i="${i}" title="Smazat">✕</button>
        </span></li>`;
    }).join('');
    return `<ol class="rt-list">${items}</ol>
      <div class="row"><button class="btn small ghost" data-act="rt-reverse" ${P.points.length < 2 ? 'disabled' : ''}>⇅ Obrátit</button>
      <button class="btn small ghost" data-act="rt-fit">Zobrazit celou</button>
      <button class="btn small ghost" data-act="rt-clear">Smazat trasu</button></div>`;
  }

  function resultsHtml() {
    if (P.points.length < 2) return '';
    if (P.busy && !P.analysis) return '<section><div class="loading"><div class="spinner"></div>Počítám trasu…</div></section>';
    if (P.error) return `<section><p class="neg">${esc(P.error)}</p></section>`;
    const A = P.analysis;
    if (!A) return '';
    const end = etaAt(A.samples.length - 1);
    const used = [...new Set(P.segs.map(s => s.engine))].filter(e => e !== 'line');
    return `
      <section>
        <h3>Trasa ${P.busy ? '<small>· přepočítávám…</small>' : ''}</h3>
        <div class="metrics rt-metrics">
          <div><span>Délka</span><b>${km(A.dist)} km</b></div>
          <div><span>Stoupání</span><b>↑ ${num(A.up)} m</b></div>
          <div><span>Klesání</span><b>↓ ${num(A.down)} m</b></div>
          <div><span>Nejvýš</span><b>${num(A.maxE)} m</b><small>km ${km(A.samples[A.maxI].d)}</small></div>
          <div><span>Čas</span><b>${fmtDur(A.total)}</b><small>výstup ${P.pace} m/h</small></div>
          <div><span>Cíl</span><b>${hhmm(end)}</b><small>${dayLabel(localIso(end).slice(0, 10), localIso(new Date()).slice(0, 10))}</small></div>
        </div>
        <div class="rt-time">
          <label>Start <input type="datetime-local" data-act="rt-start" value="${P.start}"></label>
          <label>Tempo výstupu <select data-act="rt-pace">${PACES.map(v => `<option value="${v}" ${v === P.pace ? 'selected' : ''}>${v} m/h</option>`).join('')}</select></label>
        </div>
        <div class="profile-wrap">${profileSvg(A)}<div class="profile-tip hidden"></div></div>
        <label class="check small"><input type="checkbox" data-act="rt-colorslope" ${P.colorBySlope ? 'checked' : ''}> Obarvit strmé úseky na mapě</label>
        <div class="muted small">Výšky z modelu terénu (~30 m). Čas je odhad bez přestávek: výstup ${P.pace} m/h, sjezd ~12 km/h, přepnutí pásů 10–15 min.
          ${used.length ? `<br>${used.map(e => e === 'mapy'
    ? '<a href="https://mapy.com/" target="_blank" rel="noopener" class="mapy-attr"><img src="https://api.mapy.com/img/api/logo.svg" alt="Mapy.com" height="14"></a> Plánování © Mapy.com'
    : esc(ENGINES[e].attribution)).join(' · ')}` : ''}</div>
      </section>
      ${terrainHtml(A)}
      ${weatherHtml(A)}`;
  }

  function terrainHtml(A) {
    const total = A.bandLen.reduce((a, b) => a + b, 0);
    const dateStr = P.start.slice(0, 10);
    // lavinové regiony na trase
    const regs = [...new Set(A.region.filter(Boolean))];
    const regRows = regs.map(id => {
      const b = ctx.aval.bulletinFor(id, dateStr);
      const lvl = b ? ctx.aval.bulletinLevel(b) : null;
      // kritické: strmý terén v expozici a výšce z lavinových problémů
      let crit = 0;
      if (b) {
        const probs = (b.avalancheProblems || []).filter(p => !ctx.aval.NO_PROBLEM.has(p.problemType));
        for (let i = 1; i < A.samples.length; i++) {
          if (A.region[i] !== id || !(A.slope[i] >= 30) || A.aspect[i] == null) continue;
          const asp = ASPECTS[A.aspect[i]], e = A.ele[i];
          const hit = probs.some(p => {
            const lo = parseInt(p.elevation?.lowerBound, 10), hi = parseInt(p.elevation?.upperBound, 10);
            return (!p.aspects?.length || p.aspects.includes(asp)) &&
              (Number.isNaN(lo) || e >= lo) && (Number.isNaN(hi) || e <= hi);
          });
          if (hit) crit += A.samples[i].d - A.samples[i - 1].d;
        }
      }
      return `<div class="rt-reg"><span class="lvl small" style="--c:${ctx.aval.DANGER[lvl || 0].color}">${lvl || '–'}</span>
        <div><b>${esc(ctx.aval.regionName(id))}</b><div class="muted small">${b
          ? `${ctx.aval.DANGER[lvl].name} lavinové nebezpečí${crit > 0 ? ` · <span class="neg">${km(crit)} km trasy v kritických expozicích</span>` : ' · trasa nevede kritickými expozicemi'}`
          : `lavinová předpověď na ${dayLabel(dateStr, localIso(new Date()).slice(0, 10)).toLowerCase()} zatím není`}</div></div></div>`;
    }).join('');
    const runs = A.runs.slice().sort((a, b) => b.max - a.max).slice(0, 6).sort((a, b) => a.start - b.start);
    return `<section>
      <h3>Lavinový terén na trase</h3>
      ${total < 20 ? '<p class="pos">Trasa nevede přes svahy strmější než 30°.</p>' : `
        <div class="band-bars">${BANDS.map((b, k) => A.bandLen[k] > 0 ? `<span><i style="background:${b.color}"></i>${b.label}: <b>${km(A.bandLen[k])} km</b></span>` : '').join('')}</div>
        <ul class="rt-runs">${runs.map(r => `<li data-act="rt-run" data-s="${r.start}" data-e="${r.end}">
          <i style="background:${BANDS[band(r.max)].color}"></i>km ${km(A.samples[r.start].d)}–${km(A.samples[r.end].d)} ·
          až <b>${num(r.max)}°</b> · ${ASPECT_CS[ASPECTS[r.aspect]] || ''} · ${num(r.e0)}–${num(r.e1)} m</li>`).join('')}</ul>
        <div class="muted small">Sklon terénu do ~40 m od trasy. Svahy nad 30° jsou lavinový terén – zvaž je podle aktuální lavinové situace.</div>`}
      ${regRows ? `<div class="rt-regs">${regRows}</div>` : '<div class="muted small">Trasa nevede regionem s lavinovou předpovědí.</div>'}
    </section>`;
  }

  function weatherHtml(A) {
    const mid = A.samples[Math.floor(A.samples.length / 2)];
    const sun = sunTimes(mid.lat, mid.lon, P.start.slice(0, 10));
    const st = startDate(), end = etaAt(A.samples.length - 1);
    const sunLine = sun.set ? `<div class="rt-sun">☀ východ ${sun.rise ? hhmm(sun.rise) : '–'}, západ ${hhmm(sun.set)} ·
      ${end > sun.set ? `<span class="neg">do cíle dorazíš asi ${Math.round((end - sun.set) / 60e3)} min po západu slunce</span>`
        : `rezerva do západu ${fmtDur((sun.set - end) / 3600e3)}`}${sun.rise && st < sun.rise ? ' · start před východem slunce' : ''}</div>` : '';
    let body;
    if (P.weatherBusy) body = '<div class="loading small"><div class="spinner"></div>Načítám počasí na trase…</div>';
    else if (P.weatherErr) body = `<p class="muted">${esc(P.weatherErr)}</p>`;
    else if (!P.weather) body = '';
    else {
      const W = P.weather;
      const warn = [];
      const mg = W.reduce((a, w) => ((w.gust ?? 0) > (a?.gust ?? -1) ? w : a), null);
      if (mg && mg.gust >= 50) warn.push(`${mg.gust >= 70 ? '<b class="neg">silný vítr</b>' : 'nárazy větru'} až ${num(mg.gust)} km/h (km ${km(mg.d)}, ${hhmm(mg.eta)})`);
      if (W.some(w => (w.rain ?? 0) >= 0.3)) warn.push('<span class="neg">déšť na trase</span>');
      const sn = W.reduce((s, w) => s + (w.snow ?? 0), 0);
      if (sn >= 0.5) warn.push('sněžení během túry');
      if (W.some(w => w.vis != null && w.vis < 1000)) warn.push('místy mlha');
      const tmin = Math.min(...W.map(w => w.temp ?? 99)), tmax = Math.max(...W.map(w => w.temp ?? -99));
      body = `<div class="muted small">Teploty ${num(tmin)} až ${num(tmax)} °C${W[0].freezing != null ? ` · nulová izoterma kolem ${num(Math.round(W[Math.floor(W.length / 2)].freezing / 50) * 50)} m` : ''}${warn.length ? ` · ${warn.join(' · ')}` : ''}</div>
        <table class="tbl rt-wx"><thead><tr><th>Čas</th><th>km</th><th>m</th><th>°C</th><th>Vítr</th><th>Srážky</th><th>Obl.</th></tr></thead><tbody>
        ${W.map(w => `<tr class="${w.top ? 'top' : ''}">
          <td>${hhmm(w.eta)}</td><td>${km(w.d)}</td><td>${num(w.ele)}${w.top ? ' ▲' : ''}</td>
          <td class="${(w.temp ?? 0) <= -15 ? 'neg' : ''}">${num(w.temp)}</td>
          <td class="${(w.gust ?? 0) >= 70 ? 'neg' : (w.gust ?? 0) >= 50 ? 'warn' : ''}">${num(w.wind)}<small>/${num(w.gust)}</small> ${windDirCs(w.dir)}</td>
          <td class="${(w.rain ?? 0) >= 0.3 ? 'neg' : ''}">${(w.snow ?? 0) >= 0.1 ? `❄ ${num(w.snow, 1)} cm` : (w.precip ?? 0) >= 0.1 ? `${num(w.precip, 1)} mm` : '–'}</td>
          <td>${w.vis != null && w.vis < 1000 ? '🌫' : `${num(w.cloud)} %`}</td></tr>`).join('')}
        </tbody></table>
        <div class="muted small">Počasí v čase, kdy na místo podle odhadu dorazíš (Open-Meteo, model pro danou výšku). Vítr = průměr/nárazy km/h.</div>`;
    }
    return `<section><h3>Počasí na trase</h3>${sunLine}${body}</section>`;
  }

  function savedHtml() {
    const list = saved();
    if (!list.length) return '';
    return `<div class="rt-saved"><div class="muted small">Uložené trasy</div><ul>${list.map((r, k) => `<li>
      <a href="#" data-act="rt-load" data-k="${k}">${esc(r.name)}</a>
      <span class="muted small">${r.dist ? `${km(r.dist)} km` : ''}${r.up ? ` · ↑ ${num(r.up)} m` : ''}</span>
      <button data-act="rt-unsave" data-k="${k}" title="Smazat">✕</button></li>`).join('')}</ul></div>`;
  }

  // ---------------------------------------------------------------- výškový profil
  const PW = 380, PH = 170, PL = 38, PR = 10, PT = 10, PB = 34;
  function profileScales(A) {
    let lo = Math.floor((A.minE - 10) / 50) * 50, hi = Math.ceil((A.maxE + 10) / 50) * 50;
    if (hi - lo < 100) hi = lo + 100;
    const X = d => PL + (d / A.dist) * (PW - PL - PR);
    const Y = e => PT + (1 - (e - lo) / (hi - lo)) * (PH - PT - PB);
    return { lo, hi, X, Y };
  }

  function profileSvg(A) {
    const { lo, hi, X, Y } = profileScales(A);
    const S = A.samples;
    let line = '';
    S.forEach((s, i) => { if (A.ele[i] != null) line += `${line ? 'L' : 'M'}${X(s.d).toFixed(1)},${Y(A.ele[i]).toFixed(1)}`; });
    const base = PH - PB;
    const parts = [`<path d="${line}L${X(A.dist).toFixed(1)},${base}L${X(0)},${base}Z" class="pf-area"/>`, `<path d="${line}" class="pf-line"/>`];
    const estep = (hi - lo) / 4 >= 150 ? 200 : (hi - lo) / 4 >= 75 ? 100 : 50;
    for (let e = Math.ceil(lo / estep) * estep; e <= hi; e += estep) {
      parts.push(`<line x1="${PL}" x2="${PW - PR}" y1="${Y(e)}" y2="${Y(e)}" class="pf-grid"/><text x="${PL - 4}" y="${Y(e) + 3}" text-anchor="end" class="pf-lbl">${e}</text>`);
    }
    const kmTot = A.dist / 1000;
    const kstep = [0.5, 1, 2, 5, 10, 20].find(s => kmTot / s <= 6) || 50;
    for (let k = 0; k <= kmTot + 1e-6; k += kstep) {
      parts.push(`<text x="${X(k * 1000)}" y="${PH - 6}" text-anchor="middle" class="pf-lbl">${num(k, kstep < 1 ? 1 : 0)}</text>`);
    }
    // pruh se sklonem terénu pod profilem
    let cur = null;
    const flush = end => { if (cur) parts.push(`<rect x="${X(S[cur.i].d).toFixed(1)}" y="${base + 3}" width="${Math.max(1, X(S[end].d) - X(S[cur.i].d)).toFixed(1)}" height="7" fill="${BANDS[cur.b].color}"/>`); };
    S.forEach((s, i) => {
      const b = band(A.slope[i]);
      if (cur && b === cur.b) return;
      flush(i);
      cur = b >= 0 ? { b, i } : null;
    });
    flush(S.length - 1);
    // body trasy
    A.wpIdx.forEach((wi, k) => {
      const x = X(S[wi].d);
      const label = k === 0 ? 'A' : k === A.wpIdx.length - 1 ? 'B' : k;
      parts.push(`<line x1="${x}" x2="${x}" y1="${PT}" y2="${base}" class="pf-wp"/><text x="${x}" y="${PT + 8}" text-anchor="middle" class="pf-wpl">${label}</text>`);
    });
    parts.push(`<line class="pf-cur hidden" x1="0" x2="0" y1="${PT}" y2="${base}"/>`);
    parts.push(`<rect class="pf-hit" x="${PL}" y="0" width="${PW - PL - PR}" height="${PH}"/>`);
    return `<svg viewBox="0 0 ${PW} ${PH}" class="rt-profile" role="img" aria-label="Výškový profil trasy">${parts.join('')}</svg>`;
  }

  function bindProfile() {
    const svg = document.querySelector('.rt-profile');
    const A = P.analysis;
    if (!svg || !A) return;
    const tip = svg.parentElement.querySelector('.profile-tip');
    const cur = svg.querySelector('.pf-cur');
    const { X } = profileScales(A);
    const move = ev => {
      const pt = ev.touches ? ev.touches[0] : ev;
      const r = svg.getBoundingClientRect();
      const x = (pt.clientX - r.left) / r.width * PW;
      const d = Math.max(0, Math.min(A.dist, (x - PL) / (PW - PL - PR) * A.dist));
      let lo = 0, hi = A.samples.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (A.samples[m].d < d) lo = m + 1; else hi = m; }
      const i = lo, s = A.samples[i];
      cur.setAttribute('x1', X(s.d)); cur.setAttribute('x2', X(s.d)); cur.classList.remove('hidden');
      tip.innerHTML = `km ${km(s.d)} · <b>${num(A.ele[i])} m</b> · ${hhmm(etaAt(i))}${A.slope[i] >= 25 ? ` · sklon ${num(A.slope[i])}° ${ASPECT_CS[ASPECTS[A.aspect[i]]] || ''}` : ''}`;
      tip.classList.remove('hidden');
      tip.style.left = `${Math.min(r.width - 150, Math.max(0, X(s.d) / PW * r.width - 75))}px`;
      hoverMarker.setLatLng([s.lat, s.lon]);
      if (!map.hasLayer(hoverMarker)) hoverMarker.addTo(map);
      if (ev.touches) ev.preventDefault();
    };
    const leave = () => { cur.classList.add('hidden'); tip.classList.add('hidden'); hoverMarker.remove(); };
    svg.addEventListener('mousemove', move);
    svg.addEventListener('touchstart', move, { passive: false });
    svg.addEventListener('touchmove', move, { passive: false });
    svg.addEventListener('mouseleave', leave);
    svg.addEventListener('touchend', leave);
  }

  // ---------------------------------------------------------------- události
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-act^="rt-"]');
    if (!t) return;
    const i = +t.dataset.i;
    switch (t.dataset.act) {
      case 'rt-del': removePoint(i); break;
      case 'rt-up': movePoint(i, -1); break;
      case 'rt-down': movePoint(i, 1); break;
      case 'rt-mode': P.points[i].mode = t.dataset.m; map.closePopup(); changed(); break;
      case 'rt-newmode': P.newMode = t.dataset.m; store.set('rt.mode', P.newMode); renderPanel(); break;
      case 'rt-engine':
        if (t.disabled) break;
        P.engine = t.dataset.e; store.set('rt.engine', P.engine); changed(); break;
      case 'rt-reverse': reverse(); break;
      case 'rt-clear': if (confirm('Smazat celou trasu?')) clear(); break;
      case 'rt-fit': fit(); break;
      case 'rt-save': save(); break;
      case 'rt-gpx': exportGpx(); break;
      case 'rt-share': {
        const url = shareUrl();
        navigator.clipboard?.writeText(url).catch(() => {});
        ctx.openModal(`<h3>Sdílet trasu</h3><div class="qr-card">${ctx.qrSvg(url)}<div>
          <p>Odkaz je zkopírovaný ve schránce. Kdo ho otevře, uvidí stejnou trasu včetně času startu.</p>
          <input class="rt-name" readonly value="${esc(url)}" onclick="this.select()"></div></div>`);
        break;
      }
      case 'rt-load': {
        e.preventDefault();
        const r = saved()[+t.dataset.k];
        if (r) setPoints(r.points, { name: r.name });
        break;
      }
      case 'rt-unsave': {
        const list = saved();
        list.splice(+t.dataset.k, 1);
        store.set('rt.saved', list);
        renderPanel();
        break;
      }
      case 'rt-run': {
        const A = P.analysis;
        if (!A) break;
        const pts = A.samples.slice(+t.dataset.s, +t.dataset.e + 1).map(s => [s.lat, s.lon]);
        map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 16 });
        break;
      }
      case 'rt-done': P.adding = false; renderPanel(); break;
      default: break;
    }
  });

  document.addEventListener('change', e => {
    const t = e.target.closest('[data-act^="rt-"]');
    if (!t) return;
    switch (t.dataset.act) {
      case 'rt-adding': P.adding = t.checked; updateHint(); break;
      case 'rt-start': if (t.value) { P.start = t.value; renderResults(); updateHash(); scheduleWeather(); } break;
      case 'rt-pace':
        P.pace = +t.value; store.set('rt.pace', P.pace);
        if (P.analysis) computeTimes(P.analysis);
        renderResults(); scheduleWeather();
        break;
      case 'rt-colorslope': P.colorBySlope = t.checked; store.set('rt.colorSlope', P.colorBySlope); renderLines(); break;
      case 'rt-import': if (t.files?.[0]) importGpx(t.files[0]); break;
      default: break;
    }
  });

  document.addEventListener('input', e => {
    if (e.target.dataset?.act === 'rt-name') P.name = e.target.value;
  });

  return {
    isActive, addPoint, startFrom, loadFromHash, fit,
    render: renderPanel,
    onShow() { renderPanel(); },
    onHide() { hoverMarker.remove(); updateHint(); },
    onDataUpdate() { renderResults(); },
  };
}
