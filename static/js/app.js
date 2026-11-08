// Skialp CZ/SK – hlavní logika aplikace.
import {
  nowHourKey, addDays, dayLabel, shortDate, fmtTime, fmtDateTime, ago, num, plural, distKm,
  featureContains, featureDistanceKm, getJSON, esc, store, ASPECTS, ASPECT_CS, windDirCs, colorScale,
} from './util.js';
import { dayMetrics, nowMetrics, scoreDay, summarizeCams, buildOverview, DANGER } from './scoring.js';
import { loadImage, analyzeImage, describe, statusClass, sunElevation } from './webcam.js';
import {
  BASE_LAYERS, hikingLayer, pistesLayer, gibsLayer, SlopeLayer, SLOPE_CLASSES, MeteoGrid, METEO_VARS, meteoLegend,
} from './layers.js';
import { forecastChart } from './chart.js';
import { STATIC, dataUrl, metaUrl, regionsUrl, RADAR_URL, camThumbUrl, camFullUrls } from './api.js';
import { createPlanner } from './planner.js';

/* global L */

const LEVEL = { low: 1, moderate: 2, considerable: 3, high: 4, very_high: 5 };
const PROBLEM_CS = {
  new_snow: 'Nový sníh', wind_slab: 'Převátý sníh', persistent_weak_layers: 'Slabé vrstvy ve staré pokrývce',
  wet_snow: 'Mokrý sníh', gliding_snow: 'Klouzavý sníh', cornices: 'Převěje',
  no_distinct_avalanche_problem: 'Bez výrazného problému', favourable_situation: 'Příznivá situace',
};
PROBLEM_CS.no_distanc_avalanche_problem = PROBLEM_CS.no_distinct_avalanche_problem; // překlep v datech HS ČR
const NO_PROBLEM = new Set(['no_distinct_avalanche_problem', 'no_distanc_avalanche_problem', 'favourable_situation']);
const PERIOD_CS = { earlier: 'dopoledne', later: 'odpoledne', all_day: 'celý den' };
const DIFF_CS = {
  novice: 'velmi lehká', easy: 'lehká', intermediate: 'středně těžká', advanced: 'těžká',
  expert: 'velmi těžká', freeride: 'freeride', extreme: 'extrémní',
};
const DIFF_COLOR = {
  novice: '#2e7d32', easy: '#2e7d32', intermediate: '#1565c0', advanced: '#c62828',
  expert: '#212121', freeride: '#e65100', extreme: '#000000',
};
const LAYER_DEFS = [
  ['Skialp', [
    ['areas', 'Skialpové oblasti (hodnocení)'],
    ['routes', 'Skialpové trasy (OpenStreetMap)'],
    ['pistes', 'Sjezdovky, lanovky a skialp (OpenSnowMap)'],
    ['hiking', 'Turistické trasy'],
  ]],
  ['Laviny', [
    ['aval', 'Lavinová předpověď (regiony)'],
    ['slope', 'Sklon svahů – lavinový terén'],
  ]],
  ['Aktuální stav', [
    ['webcams', 'Webkamery'],
    ['stations', 'Meteostanice – naměřeno'],
    ['radar', 'Radar srážek'],
    ['snowsat', 'Sněhová pokrývka – družice'],
    ['truecolor', 'Družicový snímek (oblačnost)'],
  ]],
];
const DEFAULT_LAYERS = {
  areas: true, routes: true, pistes: false, hiking: false, aval: true, slope: false,
  webcams: true, stations: false, radar: false, snowsat: false, truecolor: false,
};
const REFRESH_MIN = { forecast: 10, avalanche: 10, stations: 10, radar: 5, grid: 30, routes: 360 };
const SOURCE_NAMES = {
  forecast: 'Předpověď pro oblasti (Open-Meteo)', grid: 'Meteo mapa (Open-Meteo)',
  avalanche: 'Lavinové předpovědi (HS ČR, HZS SR / EAWS)', stations: 'Měření stanic (ČHMÚ, SHMÚ)',
  radar: 'Radar srážek (RainViewer)', routes: 'Skialpové trasy (OpenStreetMap)', cams: 'Rozbor webkamer',
};

const yesterday = () => new Date(Date.now() - 864e5).toISOString().slice(0, 10);

// Režim historie: ?datum=YYYY-MM-DD ukáže, jak aplikace hodnotila podmínky v daný den (10:00).
const DEMO = (() => {
  const d = new URLSearchParams(location.search).get('datum');
  // statická verze (GitHub Pages) archivní data nemá – režim historie umí jen lokální server
  return !STATIC && d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d < nowHourKey().slice(0, 10) ? d : null;
})();
const DATED = new Set(['forecast', 'grid', 'avalanche']);
const currentKey = () => DEMO ? `${DEMO}T10:00` : nowHourKey();

const S = {
  areas: [], webcams: [], regions: null, areaRegion: {}, camsByArea: {},
  forecast: null, grid: null, aval: null, stations: [], routes: null, radar: null,
  updated: {}, fetched: {}, errors: {},
  nowKey: currentKey(), today: currentKey().slice(0, 10),
  dayIdx: 0, results: [], byId: {},
  cam: {},
  view: 'overview', areaId: null, avalDay: 0,
  layers: { ...DEFAULT_LAYERS, ...store.get('layers', {}) },
  base: store.get('base', 'topo'),
  meteo: store.get('meteo', ''),
  label: store.get('label', 'score'),
  opacity: store.get('opacity', 0.65),
  satDate: yesterday(),
  timeKey: null,
  notify: store.get('notify', false),
};
if (!BASE_LAYERS[S.base]) S.base = 'topo';
if (S.meteo && !METEO_VARS[S.meteo]) S.meteo = '';

// ============================================================================
// Mapa
// ============================================================================

const map = L.map('map', {
  zoomControl: false, minZoom: 6, maxZoom: 18, zoomSnap: 0.5, zoomDelta: 0.5,
  scrollWheelZoom: false, // kolečko obsluhujeme sami – viz níže
}).setView([49.35, 17.4], 7);

// Přibližování kolečkem myši. Leaflet každou dávku událostí zaokrouhlí nahoru na celý krok,
// takže myši s "plynulým posunem" (jeden zub = několik malých událostí) skáčou o několik
// úrovní najednou. Tady je jeden zub vždy jeden krok bez ohledu na to, co myš posílá.
const WHEEL_STEP = 0.5;      // úrovní přiblížení na jeden zub
const WHEEL_MAX = 1.5;       // nejvíc na jedno souvislé roztočení
const WHEEL_GAP_MS = 220;    // pauza, po které začíná nové roztočení
let wheelGesture = null, wheelTarget = null, wheelPoint = null, zoomAnimating = false;

function applyWheelZoom() {
  if (zoomAnimating || wheelTarget == null) return; // dokončí se po skončení animace
  if (Math.abs(wheelTarget - map.getZoom()) > 1e-6) map.setZoomAround(wheelPoint, wheelTarget);
  else wheelTarget = null;
}
map.on('zoomstart', () => { zoomAnimating = true; });
map.on('zoomend', () => { zoomAnimating = false; applyWheelZoom(); });
map.getContainer().addEventListener('wheel', e => {
  e.preventDefault();
  let px = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 600 : 1);
  if (!px) return;
  if (e.ctrlKey) px *= 2; // gesto "štípnutí" na touchpadu posílá malé hodnoty
  const now = performance.now();
  if (!wheelGesture || now - wheelGesture.last > WHEEL_GAP_MS) {
    wheelGesture = { base: wheelTarget ?? map.getZoom(), acc: 0 };
  }
  wheelGesture.last = now;
  // velká hodnota = jeden zub klasického kolečka; malé hodnoty (touchpad, plynulý posun) se sčítají
  wheelGesture.acc += Math.abs(px) >= 50 ? -Math.sign(px) * WHEEL_STEP : -px / 100 * WHEEL_STEP;
  wheelGesture.acc = Math.max(-WHEEL_MAX, Math.min(WHEEL_MAX, wheelGesture.acc));
  const z = Math.round((wheelGesture.base + wheelGesture.acc) / WHEEL_STEP) * WHEEL_STEP;
  wheelTarget = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), z));
  wheelPoint = map.mouseEventToContainerPoint(e);
  applyWheelZoom();
}, { passive: false });
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);
for (const [name, z] of [['satPane', 250], ['meteoPane', 300], ['radarPane', 320], ['avalPane', 330],
  ['slopePane', 340], ['trailPane', 360], ['routePane', 420]]) {
  map.createPane(name).style.zIndex = z;
}
map.getPane('meteoPane').style.pointerEvents = 'none';
map.getPane('slopePane').style.pointerEvents = 'none';

let baseLayer = null;
function setBase(key) {
  S.base = key; store.set('base', key);
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = BASE_LAYERS[key].make().addTo(map);
}
setBase(S.base);

const meteoGrid = new MeteoGrid(map);
meteoGrid.opacity = S.opacity;
const L_ = {
  areas: L.layerGroup(),
  webcams: L.layerGroup(),
  stations: L.layerGroup(),
  routes: null, aval: null, slope: null, hiking: null, pistes: null, radar: null, snowsat: null, truecolor: null,
};

function zoomClass() {
  const z = map.getZoom();
  map.getContainer().classList.toggle('z-names', z >= 9);
}
map.on('zoomend', zoomClass);
zoomClass();

// ============================================================================
// Načítání dat
// ============================================================================

async function loadSource(name, force = false) {
  try {
    const q = {};
    if (force) q.force = '1';
    if (DEMO && DATED.has(name)) q.date = DEMO;
    // radar se ve statické verzi bere přímo z RainViewer (snímky stárnou po 10 min)
    const r = STATIC && name === 'radar'
      ? { updated: Date.now() / 1000, data: await getJSON(RADAR_URL) }
      : await getJSON(dataUrl(name, q));
    S.updated[name] = r.updated;
    S.errors[name] = null;
    S.fetched[name] = Date.now();
    return r.data;
  } catch (e) {
    S.errors[name] = String(e.message || e);
    S.fetched[name] = Date.now();
    console.warn(name, e);
    return null;
  } finally {
    renderStatus();
  }
}

const HANDLERS = {
  async forecast(force) { const d = await loadSource('forecast', force); if (d) { S.forecast = d; compute(); } },
  async avalanche(force) {
    const d = await loadSource('avalanche', force);
    if (d) { S.aval = d; compute(); styleAval(); }
  },
  async stations(force) { const d = await loadSource('stations', force); if (d) { S.stations = d; renderStations(); if (S.view === 'area') renderView(); } },
  async radar(force) { const d = await loadSource('radar', force); if (d) { S.radar = d; updateRadar(); } },
  async grid(force) {
    const d = await loadSource('grid', force);
    if (d) { S.grid = d; meteoGrid.setGrid(d); setupTimebar(); updateMeteo(); }
  },
  async routes(force) { const d = await loadSource('routes', force); if (d) { S.routes = prepRoutes(d); renderRoutes(); } },
};

async function refreshAll(force = false) {
  const jobs = Object.keys(HANDLERS).map(k => HANDLERS[k](force));
  analyzeCams(); // běží souběžně, výsledky se promítnou do hodnocení po dokončení
  await Promise.all(jobs);
}

function tick() {
  const now = Date.now();
  const nk = currentKey();
  if (nk !== S.nowKey) { S.nowKey = nk; S.today = nk.slice(0, 10); compute(); setupTimebar(); }
  if (document.hidden) return;
  for (const [k, min] of Object.entries(REFRESH_MIN)) {
    if (!S.fetched[k] || now - S.fetched[k] > min * 60e3) HANDLERS[k]();
  }
  if (!S.camRun || now - S.camRun > 15 * 60e3) analyzeCams();
}

// ============================================================================
// Výpočet hodnocení
// ============================================================================

function bulletinFor(regionId, dayStr) {
  const d = S.aval?.days?.[dayStr];
  if (!d) return null;
  const list = d.bulletins.filter(b => (b.regions || []).some(r => r.regionID === regionId));
  list.sort((a, b) => (b.publicationTime || '').localeCompare(a.publicationTime || ''));
  return list[0] || null;
}
const bulletinLevel = b => Math.max(0, ...(b.dangerRatings || []).map(r => LEVEL[r.mainValue] ?? 0));
function levelFor(regionId, dayIdx) {
  const b = regionId && bulletinFor(regionId, addDays(S.today, dayIdx));
  return b ? bulletinLevel(b) : null;
}
function regionName(id) {
  return S.regions?.features.find(f => f.properties.id === id)?.properties.name || id;
}

function compute() {
  if (!S.forecast) return;
  S.nowKey = currentKey();
  S.today = S.nowKey.slice(0, 10);
  S.results = S.areas.map(area => {
    const fc = S.forecast.areas[area.id];
    if (!fc) return null;
    const regionId = S.areaRegion[area.id];
    const camSum = DEMO ? null : summarizeCams((S.camsByArea[area.id] || []).map(c => S.cam[c.id]));
    const days = [0, 1, 2, 3].map(i => {
      const m = dayMetrics(fc.hourly, addDays(S.today, i));
      if (!m) return null;
      const danger = levelFor(regionId, i);
      return { m, danger, sc: scoreDay(m, { danger, cams: i === 0 ? camSum : null }) };
    });
    return { area, fc, days, now: nowMetrics(fc.hourly, S.nowKey), camSum, regionId };
  }).filter(r => r && r.days[0]);
  S.byId = Object.fromEntries(S.results.map(r => [r.area.id, r]));
  renderAreaMarkers();
  renderView();
  maybeNotify();
}

// ============================================================================
// Oblasti na mapě
// ============================================================================

const tempScale = colorScale(METEO_VARS.temp.stops);
const rgb = c => c ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : '#999';

function valueAt(r, key) {
  const h = r.fc.hourly, i = h.time.indexOf(key);
  if (i < 0) return null;
  switch (S.label) {
    case 'temp': return h.temperature_2m[i];
    case 'snow': return h.snow_depth[i] == null ? null : h.snow_depth[i] * 100;
    case 'new': { let s = 0; for (let k = Math.max(0, i - 23); k <= i; k++) s += h.snowfall[k] || 0; return s; }
    case 'wind': return h.wind_gusts_10m[i];
    default: return null;
  }
}

function markerHtml(r) {
  const d = r.days[S.dayIdx] || r.days[0];
  const name = `<span class="am-name">${esc(r.area.name)}</span>`;
  if (S.label === 'score') {
    return `<div class="am" style="--c:${d.sc.cat.color}" title="${esc(d.sc.cat.label)}"><b>${d.sc.score}</b></div>${name}`;
  }
  const v = valueAt(r, S.timeKey || S.nowKey);
  const conf = { temp: ['°', 0, rgb(tempScale(v))], snow: [' cm', 0, '#2f6fde'], new: [' cm', 0, '#6a3cff'], wind: ['', 0, '#e0662b'] }[S.label];
  return `<div class="am am-val" style="--c:${conf[2]}"><b>${v == null ? '–' : num(v, conf[1]) + conf[0]}</b></div>${name}`;
}

function renderAreaMarkers() {
  L_.areas.clearLayers();
  for (const r of S.results) {
    const m = L.marker([r.area.lat, r.area.lon], {
      icon: L.divIcon({ className: 'area-icon', html: markerHtml(r), iconSize: [36, 36], iconAnchor: [18, 18] }),
      riseOnHover: true, zIndexOffset: 1000,
    });
    m.bindTooltip(`<b>${esc(r.area.name)}</b><br>${esc(r.area.range)}`, { direction: 'top', offset: [0, -18] });
    m.on('click', () => selectArea(r.area.id));
    L_.areas.addLayer(m);
  }
}

function selectArea(id, fly = true) {
  S.areaId = id;
  setView('area');
  const r = S.byId[id];
  openSidebar();
  if (r && fly) {
    const z = Math.max(map.getZoom(), 12);
    let target = L.latLng(r.area.lat, r.area.lon);
    if (window.innerWidth <= 760) { // posunout nad spodní panel
      const sheet = document.getElementById('sidebar').offsetHeight;
      target = map.unproject(map.project(target, z).add([0, sheet / 2]), z);
    }
    map.flyTo(target, z, { duration: 0.8 });
  }
}

// ============================================================================
// Lavinové regiony a sklon svahů
// ============================================================================

function styleAval() {
  if (!L_.aval) return;
  L_.aval.setStyle(f => {
    const lvl = levelFor(f.properties.id, S.avalDay);
    return {
      color: lvl ? '#333' : '#777', weight: 1.2, dashArray: lvl ? null : '4 4',
      fillColor: lvl ? DANGER[lvl].color : '#bdbdbd', fillOpacity: lvl ? 0.38 : 0.08,
    };
  });
}

function buildAvalLayer() {
  L_.aval = L.geoJSON(S.regions, {
    pane: 'avalPane', bubblingMouseEvents: false,
    onEachFeature: (f, layer) => {
      layer.on('click', e => {
        if (planner.isActive()) { planner.addPoint(e.latlng); return; }
        L.popup({ maxWidth: 320 }).setLatLng(e.latlng).setContent(avalPopup(f.properties.id)).openOn(map);
      });
    },
  });
  styleAval();
}

function avalPopup(id) {
  const dayStr = addDays(S.today, S.avalDay);
  const b = bulletinFor(id, dayStr);
  let html = `<div class="pp"><div class="pp-title">${esc(regionName(id))}</div>`;
  if (!b) {
    html += `<p>Pro ${dayLabel(dayStr, S.today).toLowerCase()} není vydaná lavinová předpověď.</p>`;
  } else {
    const lvl = bulletinLevel(b);
    html += `<div class="danger-big" style="--c:${DANGER[lvl].color}"><b>${lvl}</b> ${DANGER[lvl].name} lavinové nebezpečí</div>`;
    html += problemsHtml(b, true);
  }
  html += `<button class="btn small" data-act="aval-detail" data-id="${id}">Celá předpověď</button></div>`;
  return html;
}

function aspectRose(aspects, size = 46) {
  const set = new Set(aspects || []);
  const c = size / 2, r = c - 2;
  let s = `<svg class="rose" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`;
  ASPECTS.forEach((a, i) => {
    const a0 = (i * 45 - 22.5 - 90) * Math.PI / 180, a1 = (i * 45 + 22.5 - 90) * Math.PI / 180;
    const p = `M${c},${c} L${c + r * Math.cos(a0)},${c + r * Math.sin(a0)} A${r},${r} 0 0 1 ${c + r * Math.cos(a1)},${c + r * Math.sin(a1)} Z`;
    s += `<path d="${p}" class="${set.has(a) ? 'on' : ''}"><title>${ASPECT_CS[a]}</title></path>`;
  });
  s += `<text x="${c}" y="9" text-anchor="middle">S</text></svg>`;
  return s;
}

function elevText(e) {
  if (!e) return 'všechny výšky';
  const t = v => v === 'treeline' ? 'hranice lesa' : `${v} m`;
  if (e.lowerBound && e.upperBound) return `${t(e.lowerBound)} – ${t(e.upperBound)}`;
  if (e.lowerBound) return `nad ${t(e.lowerBound)}`;
  return `pod ${t(e.upperBound)}`;
}

function problemsHtml(b, compact = false) {
  const probs = b.avalancheProblems || [];
  if (!probs.length) return '';
  const seen = new Set();
  const items = probs.filter(p => {
    const k = p.problemType + (p.aspects || []).join() + JSON.stringify(p.elevation || {});
    if (seen.has(k)) return false; seen.add(k); return true;
  }).map(p => NO_PROBLEM.has(p.problemType)
    ? `<div class="prob"><b>${PROBLEM_CS[p.problemType]}</b></div>`
    : `<div class="prob">${aspectRose(p.aspects, compact ? 38 : 46)}<div>
      <b>${PROBLEM_CS[p.problemType] || esc(String(p.problemType).replace(/_/g, ' '))}</b>
      <div class="muted">${(p.aspects || []).map(a => ASPECT_CS[a]).join(', ') || 'všechny expozice'} · ${elevText(p.elevation)}${p.validTimePeriod && p.validTimePeriod !== 'all_day' ? ' · ' + PERIOD_CS[p.validTimePeriod] : ''}</div>
    </div></div>`);
  return `<div class="probs">${items.join('')}</div>`;
}

/** Nastaví filtr sklonu podle lavinových problémů a zapne vrstvu. */
function slopeFromBulletin(id) {
  const b = bulletinFor(id, addDays(S.today, S.avalDay));
  if (!b) return;
  const asp = new Set(), lows = [], highs = [];
  for (const p of (b.avalancheProblems || []).filter(x => !NO_PROBLEM.has(x.problemType))) {
    (p.aspects || ASPECTS).forEach(a => asp.add(a));
    const lo = parseInt(p.elevation?.lowerBound, 10), hi = parseInt(p.elevation?.upperBound, 10);
    lows.push(Number.isNaN(lo) ? null : lo);
    highs.push(Number.isNaN(hi) ? null : hi);
  }
  const minElev = lows.length && lows.every(v => v != null) ? Math.min(...lows) : null;
  const maxElev = highs.length && highs.every(v => v != null) ? Math.max(...highs) : null;
  setSlopeFilter({ aspects: ASPECTS.map(a => asp.size ? asp.has(a) : true), minElev, maxElev });
  setLayer('slope', true);
  const f = S.regions.features.find(x => x.properties.id === id);
  if (f) map.fitBounds(L.geoJSON(f).getBounds(), { maxZoom: 12 });
  if (map.getZoom() < 11) map.setZoom(11);
}

const slopeFilter = store.get('slopeFilter', { aspects: ASPECTS.map(() => true), minElev: null, maxElev: null });
function setSlopeFilter(f) {
  Object.assign(slopeFilter, f);
  store.set('slopeFilter', slopeFilter);
  if (L_.slope) L_.slope.setFilter(slopeFilter);
  renderLayersPanel();
}

// ============================================================================
// Webkamery
// ============================================================================

function camIcon(c) {
  return L.divIcon({ className: 'cam-icon', html: `<div class="cam ${statusClass(S.cam[c.id])}" title="${esc(c.name)}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
}

const camMarkers = {};
function renderWebcams() {
  L_.webcams.clearLayers();
  for (const c of S.webcams) {
    const m = L.marker([c.lat, c.lon], { icon: camIcon(c) });
    m.bindPopup(() => camPopup(c), { maxWidth: 330, minWidth: 300 });
    camMarkers[c.id] = m;
    L_.webcams.addLayer(m);
  }
}

const camStamp = () => Math.floor(Date.now() / 300e3);
function camPopup(c) {
  const a = S.cam[c.id];
  return `<div class="pp"><div class="pp-title">📷 ${esc(c.name)}</div>
    <img class="cam-img" src="${camThumbUrl(c.id, camStamp())}" alt="${esc(c.name)}" data-act="cam-full" data-id="${c.id}">
    <div class="muted">${esc(describe(a))}${a && !a.error ? ` · ${fmtTime(a.ts)}` : ''}</div>
    <div class="pp-links"><a href="#" data-act="cam-full" data-id="${c.id}">Zvětšit</a>
    <a href="https://www.ventusky.com/webcam-${c.id}" target="_blank" rel="noopener">Ventusky (časosběr)</a>
    ${c.providerUrl ? `<a href="${esc(c.providerUrl)}" target="_blank" rel="noopener">${esc(c.provider || 'zdroj')}</a>` : ''}</div></div>`;
}

let camBusy = false;
async function analyzeCams() {
  if (camBusy || !S.webcams.length) return;
  camBusy = true;
  S.camRun = Date.now();
  if (STATIC) {
    // ve statické verzi snímky rozebírá GitHub Actions – prohlížeč je kvůli CORS číst nesmí
    const d = await loadSource('cams');
    if (d) {
      S.cam = d;
      for (const c of S.webcams) camMarkers[c.id]?.setIcon(camIcon(c));
    }
    camBusy = false;
    compute();
    return;
  }
  const queue = [...S.webcams], stamp = camStamp();
  const worker = async () => {
    while (queue.length) {
      const c = queue.shift();
      try {
        const img = await loadImage(camThumbUrl(c.id, stamp));
        S.cam[c.id] = analyzeImage(img, sunElevation(c.lat, c.lon));
      } catch {
        S.cam[c.id] = { ts: Date.now(), error: true };
      }
      camMarkers[c.id]?.setIcon(camIcon(c));
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  S.updated.cams = Date.now() / 1000;
  S.errors.cams = null;
  camBusy = false;
  renderStatus();
  compute();
}

function openCamModal(id) {
  const c = S.webcams.find(x => x.id === id);
  if (!c) return;
  const a = S.cam[id];
  openModal(`<h3>📷 ${esc(c.name)}</h3>
    <img class="cam-full" alt="">
    <p class="muted">${esc(describe(a))} · <a href="https://www.ventusky.com/webcam-${id}" target="_blank" rel="noopener">časosběr na Ventusky</a>
    ${c.providerUrl ? ` · <a href="${esc(c.providerUrl)}" target="_blank" rel="noopener">${esc(c.provider)}</a>` : ''}</p>`);
  // zkouší postupně nejnovější hodinové snímky, nakonec náhled
  const img = document.querySelector('#modal-content .cam-full');
  const urls = camFullUrls(id, camStamp());
  let i = 0;
  img.onerror = () => { if (++i < urls.length) img.src = urls[i]; };
  img.src = urls[0];
}

// ============================================================================
// Stanice, trasy, radar, družice
// ============================================================================

function renderStations() {
  L_.stations.clearLayers();
  for (const s of S.stations) {
    if (s.t == null) continue;
    const icon = L.divIcon({ className: 'st-icon', html: `<div class="st" style="--c:${rgb(tempScale(s.t))}">${num(s.t, 1)}°</div>`, iconSize: [46, 20], iconAnchor: [23, 10] });
    const m = L.marker([s.lat, s.lon], { icon });
    m.bindPopup(`<div class="pp"><div class="pp-title">🌡 ${esc(s.name)} <small>${s.elev} m</small></div>
      <table class="kv">
      <tr><td>Teplota</td><td><b>${num(s.t, 1)} °C</b></td></tr>
      ${s.wind != null ? `<tr><td>Vítr</td><td>${num(s.wind * 3.6)} km/h ${windDirCs(s.dir)}${s.gust != null ? `, nárazy ${num(s.gust * 3.6)} km/h` : ''}</td></tr>` : ''}
      ${s.rh != null ? `<tr><td>Vlhkost</td><td>${num(s.rh)} %</td></tr>` : ''}
      ${s.precip1h != null ? `<tr><td>Srážky (1 h)</td><td>${num(s.precip1h, 1)} mm</td></tr>` : ''}
      ${s.snow != null ? `<tr><td>Sníh</td><td>${num(s.snow)} cm</td></tr>` : ''}
      </table><div class="muted">${s.source} · měřeno ${fmtDateTime(s.time)}</div></div>`);
    L_.stations.addLayer(m);
  }
}

function lineLengthKm(coords) {
  let s = 0;
  for (let i = 1; i < coords.length; i++) s += distKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  return s;
}

function prepRoutes(gj) {
  for (const f of gj.features) {
    const lines = f.geometry.coordinates;
    f.properties.km = lines.reduce((s, l) => s + lineLengthKm(l), 0);
    let la = 0, lo = 0, n = 0;
    for (const l of lines) for (const [x, y] of l) { lo += x; la += y; n++; }
    f.properties.c = [la / n, lo / n];
  }
  return gj;
}

function routePopup(p) {
  return `<div class="pp"><div class="pp-title">🎿 ${esc(p.name || 'Skialpová trasa')}</div>
    <table class="kv">
      ${p.difficulty ? `<tr><td>Obtížnost</td><td>${DIFF_CS[p.difficulty] || esc(p.difficulty)}</td></tr>` : ''}
      <tr><td>Délka</td><td>${num(p.km, 1)} km</td></tr>
      ${p.description ? `<tr><td>Popis</td><td>${esc(p.description)}</td></tr>` : ''}
    </table>
    <div class="pp-links"><a href="https://www.openstreetmap.org/${p.osm}" target="_blank" rel="noopener">OpenStreetMap</a>
    <a href="https://mapy.cz/turisticka?x=${p.c[1]}&y=${p.c[0]}&z=14" target="_blank" rel="noopener">Mapy.cz</a></div></div>`;
}

function renderRoutes() {
  const was = L_.routes && map.hasLayer(L_.routes);
  if (L_.routes) map.removeLayer(L_.routes);
  L_.routes = L.geoJSON(S.routes, {
    pane: 'routePane', bubblingMouseEvents: false,
    style: f => ({ color: DIFF_COLOR[f.properties.difficulty] || '#8e24aa', weight: 3.5, opacity: 0.9, dashArray: '7 5' }),
    onEachFeature: (f, layer) => {
      layer.on('click', e => {
        if (planner.isActive()) { planner.addPoint(e.latlng); return; }
        L.popup().setLatLng(e.latlng).setContent(routePopup(f.properties)).openOn(map);
      });
      layer.on('mouseover', () => layer.setStyle({ weight: 6 }));
      layer.on('mouseout', () => layer.setStyle({ weight: 3.5 }));
    },
  });
  if (was || S.layers.routes) L_.routes.addTo(map);
}

function updateRadar() {
  const frames = S.radar?.radar?.past;
  if (!frames?.length) return;
  const f = frames[frames.length - 1];
  const url = `${S.radar.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`;
  S.radarTime = f.time;
  if (!L_.radar) {
    L_.radar = L.tileLayer(url, { pane: 'radarPane', opacity: 0.7, maxNativeZoom: 7, maxZoom: 18,
      attribution: 'Radar © <a href="https://www.rainviewer.com">RainViewer</a>' });
    if (S.layers.radar) L_.radar.addTo(map);
  } else {
    L_.radar.setUrl(url);
  }
  if (document.getElementById('layers').classList.contains('open')) renderLayersPanel();
}

function makeSat(kind) {
  return gibsLayer(kind === 'snowsat' ? 'snow' : 'true', S.satDate);
}

// ============================================================================
// Přepínání vrstev
// ============================================================================

function layerObj(id) {
  switch (id) {
    case 'routes': return L_.routes;
    case 'aval': if (!L_.aval && S.regions) buildAvalLayer(); return L_.aval;
    case 'slope': if (!L_.slope) { L_.slope = new SlopeLayer(); L_.slope.filter = { ...L_.slope.filter, ...slopeFilter }; } return L_.slope;
    case 'hiking': return (L_.hiking ||= hikingLayer());
    case 'pistes': return (L_.pistes ||= pistesLayer());
    case 'radar': return L_.radar;
    case 'snowsat': case 'truecolor': return (L_[id] ||= makeSat(id));
    default: return L_[id];
  }
}

function setLayer(id, on) {
  S.layers[id] = on;
  store.set('layers', S.layers);
  const l = layerObj(id);
  if (l) {
    if (on && !map.hasLayer(l)) l.addTo(map);
    if (!on && map.hasLayer(l)) map.removeLayer(l);
  }
  if (id === 'slope') updateSlopeHint();
  renderLayersPanel();
}

function applyLayers() {
  for (const id of Object.keys(DEFAULT_LAYERS)) {
    const l = layerObj(id);
    if (l && S.layers[id] && !map.hasLayer(l)) l.addTo(map);
  }
  updateSlopeHint();
}

function updateSlopeHint() {
  const hint = document.getElementById('slope-hint');
  hint.classList.toggle('hidden', !(S.layers.slope && map.getZoom() < 11));
}
map.on('zoomend', updateSlopeHint);

function setMeteo(key) {
  S.meteo = key;
  store.set('meteo', key);
  updateMeteo();
  renderLayersPanel();
}

function updateMeteo() {
  const tb = document.getElementById('timebar');
  const legend = document.getElementById('legend');
  const showTime = !!S.meteo || S.label !== 'score';
  tb.classList.toggle('hidden', !showTime || !S.grid);
  if (!S.meteo || !S.grid) {
    meteoGrid.hide();
    legend.classList.add('hidden');
    return;
  }
  const t = timeIdx();
  meteoGrid.show(S.meteo, t);
  legend.innerHTML = meteoLegend(S.meteo);
  legend.classList.remove('hidden');
}

function timeIdx() {
  if (!S.grid) return 0;
  const k = S.timeKey || S.nowKey;
  const i = S.grid.times.indexOf(k);
  return i < 0 ? 0 : i;
}

// ============================================================================
// Časová osa
// ============================================================================

let playTimer = null;
function setupTimebar() {
  if (!S.grid) return;
  const range = document.getElementById('tb-range');
  range.max = S.grid.times.length - 1;
  range.value = timeIdx();
  updateTimeLabel();
}

function updateTimeLabel() {
  const k = S.timeKey || S.nowKey;
  const isNow = !S.timeKey || S.timeKey === S.nowKey;
  document.getElementById('tb-label').innerHTML =
    `${shortDate(k.slice(0, 10))} <b>${k.slice(11, 16)}</b>${isNow ? ' <span class="tag">teď</span>' : ''}`;
}

function onTimeChange(i) {
  S.timeKey = S.grid.times[i];
  if (S.timeKey === S.nowKey) S.timeKey = null;
  updateTimeLabel();
  updateMeteo();
  if (S.label !== 'score') renderAreaMarkers();
}

// ============================================================================
// Postranní panel – přehled, oblast, laviny, kamery
// ============================================================================

const viewEl = document.getElementById('view');

function setView(v) {
  const was = S.view;
  S.view = v;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  if (was === 'route' && v !== 'route') planner.onHide();
  if (v === 'route') { viewEl.scrollTop = 0; planner.onShow(); return; }
  renderView();
}

function renderView() {
  if (S.view === 'route') { planner.onDataUpdate(); return; }
  const scroll = viewEl.scrollTop;
  if (S.view === 'overview') viewEl.innerHTML = overviewHtml();
  else if (S.view === 'area') viewEl.innerHTML = areaHtml();
  else if (S.view === 'aval') viewEl.innerHTML = avalHtml();
  else if (S.view === 'cams') viewEl.innerHTML = camsHtml();
  viewEl.scrollTop = scroll;
}

function chip(r) {
  return `<span class="chip ${r.s > 0 ? 'pos' : r.s < 0 ? 'neg' : ''}">${esc(r.t)}</span>`;
}

function dayTabs(cur, act, count = 3) {
  return `<div class="seg">${[...Array(count).keys()].map(i =>
    `<button data-act="${act}" data-i="${i}" class="${i === cur ? 'on' : ''}">${dayLabel(addDays(S.today, i), S.today)}</button>`).join('')}</div>`;
}

function avalInfo(dayIdx) {
  const levels = {}, names = {};
  for (const f of S.regions?.features || []) {
    names[f.properties.id] = f.properties.name;
    const l = levelFor(f.properties.id, dayIdx) ?? levelFor(f.properties.id, 0);
    if (l) levels[f.properties.id] = l;
  }
  return S.aval ? { levels, names, lastPublished: S.aval.lastPublished } : null;
}

function overviewHtml() {
  if (!S.results.length) {
    return `<div class="loading"><div class="spinner"></div>Načítám předpověď a hodnotím podmínky…</div>`;
  }
  const ov = buildOverview(S.results, S.dayIdx, avalInfo(S.dayIdx), S.today);
  const top = ov.ranked.slice(0, 8);
  const rank = top.map((r, k) => {
    const d = r.days[S.dayIdx];
    const reasons = [...d.sc.reasons].sort((a, b) => Math.abs(b.s) - Math.abs(a.s)).slice(0, 4);
    return `<li class="rk" data-act="area" data-id="${r.area.id}">
      <div class="rk-score" style="--c:${d.sc.cat.color}">${d.sc.score}</div>
      <div class="rk-main">
        <div class="rk-name">${k + 1}. ${esc(r.area.name)} <small>${esc(r.area.range)} · ${r.area.country}</small></div>
        <div class="rk-cat" style="color:${d.sc.cat.color}">${d.sc.cat.label}${d.danger ? ` <span class="dg" style="--c:${DANGER[d.danger].color}">laviny ${d.danger}</span>` : ''}</div>
        <div class="chips">${reasons.map(chip).join('')}</div>
      </div></li>`;
  }).join('');

  const rows = [...S.results].sort((a, b) => b.days[S.dayIdx].sc.score - a.days[S.dayIdx].sc.score).map(r => `
    <tr data-act="area" data-id="${r.area.id}">
      <td><b>${esc(r.area.name)}</b><br><small>${esc(r.area.range)}</small></td>
      ${[0, 1, 2].map(i => `<td><span class="sc" style="--c:${r.days[i]?.sc.cat.color}">${r.days[i]?.sc.score ?? '–'}</span></td>`).join('')}
      <td>${num(r.days[0].m.depth)}</td><td>${num(r.days[0].m.new72)}</td><td>${num(r.now?.snowNext72)}</td>
    </tr>`).join('');

  const legend = ['Ideální', 'Velmi dobré', 'Dobré', 'Průměrné', 'Nevhodné', 'Málo sněhu'];
  const colors = ['#0b8f4d', '#3fae3a', '#a3c614', '#f0a020', '#d9452b', '#8d99a6'];

  return `
    <section class="ov-hero season-${ov.season}">
      <div class="ov-kicker">Rychlý přehled · ${DEMO ? `${new Date(DEMO + 'T12:00Z').toLocaleDateString('cs-CZ')} (historie)` : fmtDateTime(Date.now())}</div>
      <h2>${esc(ov.headline)}</h2>
      ${dayTabs(S.dayIdx, 'day')}
      <div class="ov-lines">${ov.lines.map(l => `<p>${l}</p>`).join('')}</div>
    </section>
    <section>
      <h3>Kde je to ${dayLabel(addDays(S.today, S.dayIdx), S.today).toLowerCase()} nejlepší</h3>
      <ol class="rank">${rank}</ol>
      <div class="cat-legend">${legend.map((l, i) => `<span><i style="background:${colors[i]}"></i>${l}</span>`).join('')}</div>
    </section>
    <section>
      <details class="all-areas"><summary>Všechny oblasti (${S.results.length})</summary>
        <table class="tbl">
          <thead><tr><th>Oblast</th><th>${dayLabel(S.today, S.today)}</th><th>${dayLabel(addDays(S.today, 1), S.today)}</th><th>${dayLabel(addDays(S.today, 2), S.today)}</th>
          <th title="Výška sněhu (model), cm">Sníh</th><th title="Nový sníh za 3 dny, cm">Nový</th><th title="Sněžení v příštích 72 h, cm">+72 h</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </details>
    </section>
    <section class="opts">
      <label class="check"><input type="checkbox" data-act="notify" ${S.notify ? 'checked' : ''}> 🔔 Upozornit mě, když bude někde ideálně (dnes / zítra)</label>
    </section>
    <section class="disclaimer">
      Hodnocení je orientační – kombinuje modelovou předpověď (výška sněhu je modelový odhad),
      lavinové předpovědi a rozbor webkamer. Před túrou si vždy přečti oficiální lavinovou předpověď
      (<a href="https://www.horskasluzba.cz/cz/pocasi-na-horach/lavinova-predpoved" target="_blank" rel="noopener">HS ČR</a>,
      <a href="https://www.laviny.sk/" target="_blank" rel="noopener">SLP HZS</a>) a pravidla národních parků.
    </section>`;
}

function stationNear(area) {
  let best = null;
  for (const s of S.stations) {
    const d = distKm(area.lat, area.lon, s.lat, s.lon);
    if (d <= 12 && (!best || d < best.d)) best = { ...s, d };
  }
  return best;
}

/** Trasy do km od oblasti; úseky se stejným názvem sloučí (délky sečte). */
function routesNear(area, km = 8) {
  if (!S.routes) return [];
  const byName = new Map();
  const near = S.routes.features
    .map(f => ({ f, d: distKm(area.lat, area.lon, f.properties.c[0], f.properties.c[1]) }))
    .filter(x => x.d <= km)
    .sort((a, b) => a.d - b.d);
  for (const x of near) {
    const p = x.f.properties, key = p.name || '#' + p.osm;
    const cur = byName.get(key);
    if (cur) cur.km += p.km;
    else byName.set(key, { name: p.name, km: p.km, osm: p.osm, difficulty: p.difficulty, d: x.d });
  }
  return [...byName.values()].sort((a, b) => (b.name ? 1 : 0) - (a.name ? 1 : 0) || a.d - b.d);
}

function dailyRows(h) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const ds = addDays(S.today, i);
    const i0 = h.time.indexOf(ds + 'T00:00');
    if (i0 < 0) continue;
    const sl = k => h[k].slice(i0, i0 + 24).filter(v => v != null);
    const win = k => h[k].slice(i0 + 8, i0 + 16).filter(v => v != null);
    const s = a => a.reduce((x, y) => x + y, 0);
    const t = sl('temperature_2m');
    out.push(`<tr><td>${dayLabel(ds, S.today)}</td>
      <td>${num(Math.min(...t))} / <b>${num(Math.max(...t))}</b> °C</td>
      <td>${num(s(sl('snowfall')))} cm</td><td>${num(s(sl('precipitation')), 1)} mm</td>
      <td>${num(Math.max(...sl('wind_gusts_10m')))} km/h</td>
      <td>${num(s(win('cloud_cover')) / Math.max(1, win('cloud_cover').length))} %</td></tr>`);
  }
  return out.join('');
}

function areaHtml() {
  const r = S.byId[S.areaId];
  if (!r) {
    return `<div class="empty">Vyber oblast na mapě nebo v přehledu.<br><br>${S.results.map(x =>
      `<button class="btn ghost" data-act="area" data-id="${x.area.id}">${esc(x.area.name)}</button>`).join(' ')}</div>`;
  }
  const a = r.area, d = r.days[S.dayIdx], n = r.now;
  const st = DEMO ? null : stationNear(a); // měření jsou jen aktuální
  const h = r.fc.hourly;
  const nowIdx = h.time.indexOf(S.nowKey);
  const chart = nowIdx >= 0 ? forecastChart(h, Math.max(0, nowIdx - 24), Math.min(h.time.length - 1, nowIdx + 72), nowIdx) : '';
  const b = r.regionId ? bulletinFor(r.regionId, addDays(S.today, Math.min(S.dayIdx, 1))) : null;
  const cams = S.camsByArea[a.id] || [];
  const routes = routesNear(a);

  const days = r.days.slice(0, 3).map((x, i) => x ? `
    <button class="day-card ${i === S.dayIdx ? 'on' : ''}" data-act="day" data-i="${i}" style="--c:${x.sc.cat.color}">
      <span>${dayLabel(addDays(S.today, i), S.today)}</span><b>${x.sc.score}</b><small>${x.sc.cat.label}</small>
    </button>` : '').join('');

  return `
    <section class="ar-head">
      <button class="back" data-act="view" data-v="overview">← Přehled</button>
      <h2>${esc(a.name)}</h2>
      <div class="muted">${esc(a.range)} · ${a.country === 'CZ' ? 'Česko' : 'Slovensko'} · hodnoceno pro ~${a.elev} m n. m.</div>
    </section>
    <section><div class="days3">${days}</div>
      <div class="chips big">${d.sc.reasons.map(chip).join('')}</div></section>
    <section>
      <h3>Teď <small>(model pro ${a.elev} m)</small></h3>
      <div class="metrics">
        <div><span>Teplota</span><b>${num(n?.t, 1)} °C</b></div>
        <div><span>Vítr</span><b>${num(n?.wind)} km/h</b><small>${windDirCs(n?.dir)}, nárazy ${num(n?.gust)}</small></div>
        <div><span>Sníh</span><b>${num(n?.depth)} cm</b><small>za 24 h +${num(n?.snowPast24)} cm</small></div>
        <div><span>Sněžení</span><b>+${num(n?.snowNext24)} cm</b><small>za 72 h +${num(n?.snowNext72)} cm</small></div>
        <div><span>Oblačnost</span><b>${num(n?.cloud)} %</b></div>
        <div><span>Nulová izoterma</span><b>${n?.freezing != null ? num(Math.round(n.freezing / 50) * 50) + ' m' : '–'}</b></div>
      </div>
      ${st ? `<div class="station">📍 <b>Naměřeno – ${esc(st.name)}</b> (${st.elev} m, ${num(st.d, 1)} km): ${num(st.t, 1)} °C${st.wind != null ? `, vítr ${num(st.wind * 3.6)} km/h${st.gust != null ? ` (nárazy ${num(st.gust * 3.6)})` : ''}` : ''}${st.snow != null ? `, sníh ${num(st.snow)} cm` : ''} <span class="muted">· ${fmtTime(st.time)}</span></div>` : ''}
    </section>
    <section>
      <h3>Předpověď</h3>
      ${chart}
      <table class="tbl daily"><thead><tr><th></th><th>Teplota</th><th>Sníh</th><th>Srážky</th><th>Nárazy</th><th>Oblačn.</th></tr></thead>
      <tbody>${dailyRows(h)}</tbody></table>
    </section>
    <section>
      <h3>Laviny ${r.regionId ? `<small>· ${esc(regionName(r.regionId))}</small>` : ''}</h3>
      ${!r.regionId ? '<p class="muted">Pro tuto oblast se lavinová předpověď nevydává – hodnoť terén sám (sklon svahů najdeš ve vrstvách mapy).</p>'
    : b ? `<div class="danger-big" style="--c:${DANGER[bulletinLevel(b)].color}"><b>${bulletinLevel(b)}</b> ${DANGER[bulletinLevel(b)].name}</div>${problemsHtml(b)}
        <button class="btn small" data-act="aval-detail" data-id="${r.regionId}">Celá předpověď</button>
        <button class="btn small ghost" data-act="slope-from" data-id="${r.regionId}">Ukázat kritické svahy</button>`
      : '<p class="muted">Lavinová předpověď zatím nevyšla.</p>'}
    </section>
    <section>
      <h3>Webkamery <small>(${cams.length})</small></h3>
      ${cams.length ? `<div class="cam-grid">${cams.map(camTile).join('')}</div>` : '<p class="muted">V okolí nemám žádnou kameru.</p>'}
    </section>
    <section>
      <h3>Skialpové trasy v okolí <small>(OSM, do 8 km)</small></h3>
      ${routes.length ? `<ul class="routes">${routes.slice(0, 12).map(x => `<li data-act="route" data-osm="${x.osm}">
        <i style="background:${DIFF_COLOR[x.difficulty] || '#8e24aa'}"></i>
        ${esc(x.name || 'Trasa bez názvu')} <small>${num(x.km, 1)} km${x.difficulty ? ' · ' + (DIFF_CS[x.difficulty] || '') : ''}</small></li>`).join('')}</ul>
        ${routes.length > 12 ? `<div class="muted small">… a dalších ${routes.length - 12} na mapě</div>` : ''}`
      : `<p class="muted">${S.routes ? 'V OpenStreetMap tu nejsou zakreslené žádné skialpové trasy.' : 'Načítám trasy…'}</p>`}
    </section>
    <section class="note">ℹ ${esc(a.note || '')}</section>
    <section class="pp-links">
      <button class="btn small" data-act="plan-from" data-id="${a.id}">🧭 Naplánovat trasu odsud</button>
      <a href="https://mapy.cz/turisticka?x=${a.lon}&y=${a.lat}&z=13" target="_blank" rel="noopener">Mapy.cz</a>
      <a href="https://www.windy.com/${a.lat}/${a.lon}?${a.lat},${a.lon},12" target="_blank" rel="noopener">Windy</a>
      <a href="https://www.yr.no/en/forecast/daily-table/${a.lat.toFixed(4)},${a.lon.toFixed(4)}" target="_blank" rel="noopener">yr.no</a>
    </section>`;
}

function camTile(c) {
  const a = S.cam[c.id];
  return `<figure class="cam-tile ${statusClass(a)}" data-act="cam-full" data-id="${c.id}">
    <img loading="lazy" src="${camThumbUrl(c.id, camStamp())}" alt="">
    <figcaption><b>${esc(c.name)}</b><span>${esc(describe(a))}</span></figcaption></figure>`;
}

function avalHtml() {
  if (!S.aval) return `<div class="loading"><div class="spinner"></div>Načítám lavinové předpovědi…</div>`;
  const dayStr = addDays(S.today, S.avalDay);
  const tomorrowHas = (S.aval.days[addDays(S.today, 1)]?.bulletins || []).length > 0;
  const feats = S.regions?.features || [];
  const any = feats.some(f => bulletinFor(f.properties.id, dayStr));
  let html = `<section><h2>Lavinové předpovědi</h2>
    ${tomorrowHas ? dayTabs(S.avalDay, 'aval-day', 2) : ''}
    <p class="muted">Zdroj: Horská služba ČR (Krkonoše, Jeseníky) a Stredisko lavínovej prevencie HZS (Slovensko) přes EAWS. Aktualizace každých 20 minut.</p></section>`;
  if (!any) {
    html += `<section class="ov-hero season-off"><p><b>Pro ${dayLabel(dayStr, S.today).toLowerCase()} není vydaná žádná lavinová předpověď.</b>
      Předpovědi vychází obvykle od prosince do dubna${S.aval.lastPublished ? `; naposledy vyšla ${new Date(S.aval.lastPublished).toLocaleDateString('cs-CZ')}` : ''}.</p>
      <p>I mimo sezónu může na horách napadnout sníh a laviny hrozí – sleduj vrstvu <b>Sklon svahů</b> a čerstvý sníh.</p></section>`;
  }
  for (const f of feats) {
    const id = f.properties.id, b = bulletinFor(id, dayStr);
    const lvl = b ? bulletinLevel(b) : 0;
    const texts = b ? [
      ['Lavinová aktivita', b.avalancheActivity?.comment],
      ['Sněhová pokrývka', b.snowpackStructure?.comment],
      ['Počasí', b.weatherForecast?.comment],
      ['Tendence', [].concat(b.tendency || []).map(t => t?.comment).filter(Boolean).join(' ')],
    ].filter(x => x[1]) : [];
    const ratings = b ? (b.dangerRatings || []).map(r => `${PERIOD_CS[r.validTimePeriod] || ''}: ${LEVEL[r.mainValue] ?? '–'}`).join(' · ') : '';
    html += `<section class="av-card" id="av-${id}">
      <div class="av-head"><span class="lvl" style="--c:${DANGER[lvl].color}">${lvl || '–'}</span>
        <div><b>${esc(f.properties.name)}</b><div class="muted">${f.properties.country === 'CZ' ? 'Česko' : 'Slovensko'}${b ? ` · ${DANGER[lvl].name}` : ' · bez předpovědi'}</div></div>
      </div>
      ${b ? `${(b.dangerRatings || []).length > 1 ? `<div class="muted">${ratings}</div>` : ''}
        ${problemsHtml(b)}
        ${texts.map(([t, v]) => `<details><summary>${t}</summary><p>${esc(v).replace(/\n/g, '<br>')}</p></details>`).join('')}
        <div class="muted small">Platí ${fmtDateTime(b.validTime?.startTime)} – ${fmtDateTime(b.validTime?.endTime)} · vydal ${esc(b.source?.provider?.name || '')}</div>
        <div class="row"><button class="btn small" data-act="slope-from" data-id="${id}">Ukázat kritické svahy</button>
        ${b.source?.provider?.website ? `<a class="btn small ghost" href="${esc(b.source.provider.website)}" target="_blank" rel="noopener">Originál</a>` : ''}</div>` : ''}
    </section>`;
  }
  return html;
}

function camsHtml() {
  if (!S.webcams.length) return '<div class="empty">Seznam webkamer je prázdný (spusť tools/build_webcams.py).</div>';
  const groups = {};
  for (const c of S.webcams) (groups[c.area] ||= []).push(c);
  const order = S.areas.filter(a => groups[a.id]);
  const done = Object.keys(S.cam).length;
  return `<section><h2>Webkamery</h2>
    <p class="muted">${S.webcams.length} kamer · vyhodnoceno ${done}${S.updated.cams ? ` · ${fmtTime(S.updated.cams)}` : ''}.
    Rozbor snímku odhaduje sníh, viditelnost (mlha) a modrou oblohu – je orientační.
    ${STATIC ? 'Snímky se vyhodnocují automaticky každých ~30 minut.' : ''}</p>
    ${STATIC ? '' : `<button class="btn small" data-act="cams-run">${camBusy ? 'Vyhodnocuji…' : 'Vyhodnotit znovu'}</button>`}</section>
    ${order.map(a => `<section><h3>${esc(a.name)} <small>${esc(a.range)}</small></h3>
      <div class="cam-grid">${groups[a.id].map(camTile).join('')}</div></section>`).join('')}`;
}

// ============================================================================
// Panel vrstev
// ============================================================================

function renderLayersPanel() {
  const p = document.getElementById('layers');
  const opts = (id) => {
    if (id === 'areas' && S.layers.areas) {
      return `<select data-act="label">${[['score', 'Popisek: hodnocení'], ['temp', 'Popisek: teplota'], ['snow', 'Popisek: výška sněhu'],
        ['new', 'Popisek: nový sníh 24 h'], ['wind', 'Popisek: nárazy větru']].map(([k, l]) => `<option value="${k}" ${S.label === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    }
    if (id === 'aval' && S.layers.aval) {
      return `<div class="aval-legend">${[1, 2, 3, 4, 5].map(l => `<span style="--c:${DANGER[l].color}">${l}</span>`).join('')}</div>`;
    }
    if (id === 'slope' && S.layers.slope) {
      return `<div class="slope-legend">${SLOPE_CLASSES.map(c => `<span><i style="background:rgba(${c.color.slice(0, 3)},${c.color[3] / 255})"></i>${c.label}</span>`).join('')}</div>
        <div class="slope-filter"><div>${aspectButtons()}</div>
        <div class="elev"><label>Výška od <input type="number" step="100" data-act="elev-min" value="${slopeFilter.minElev ?? ''}" placeholder="–"></label>
        <label>do <input type="number" step="100" data-act="elev-max" value="${slopeFilter.maxElev ?? ''}" placeholder="–"></label>
        <button class="btn small ghost" data-act="slope-reset">Vše</button></div>
        <div class="muted small">Zobrazuje se od přiblížení 11. Kliknutím na expozice vyfiltruješ svahy, nebo v lavinové předpovědi zvol „Ukázat kritické svahy".</div></div>`;
    }
    if (id === 'radar' && S.layers.radar && S.radarTime) return `<div class="muted small">Snímek ${fmtTime(S.radarTime)}</div>`;
    if ((id === 'snowsat' || id === 'truecolor') && S.layers[id]) {
      return `<label class="small">Datum <input type="date" data-act="sat-date" value="${S.satDate}" max="${new Date().toISOString().slice(0, 10)}"></label>
        <div class="muted small">${id === 'snowsat' ? 'MODIS – sníh modře/bíle; v oblačnosti je bez dat.' : 'MODIS Terra – skutečné barvy, ukazuje oblačnost a zasněžené plochy.'}</div>`;
    }
    return '';
  };
  p.innerHTML = `
    <div class="lp-head"><b>Vrstvy mapy</b><button class="icon-btn" data-act="close-layers" aria-label="Zavřít">✕</button></div>
    <h4>Podkladová mapa</h4>
    <div class="radios">${Object.entries(BASE_LAYERS).map(([k, b]) =>
      `<label><input type="radio" name="base" data-act="base" value="${k}" ${S.base === k ? 'checked' : ''}> ${b.label}</label>`).join('')}</div>
    ${LAYER_DEFS.map(([g, items]) => `<h4>${g}</h4>${items.map(([id, label]) => `
      <label class="lp-item"><input type="checkbox" data-act="layer" value="${id}" ${S.layers[id] ? 'checked' : ''}> ${label}</label>
      <div class="lp-opts">${opts(id)}</div>`).join('')}`).join('')}
    <h4>Předpověď na mapě</h4>
    <div class="radios">
      <label><input type="radio" name="meteo" data-act="meteo" value="" ${!S.meteo ? 'checked' : ''}> Nic</label>
      ${Object.entries(METEO_VARS).map(([k, v]) => `<label><input type="radio" name="meteo" data-act="meteo" value="${k}" ${S.meteo === k ? 'checked' : ''}> ${v.label}</label>`).join('')}
    </div>
    ${S.meteo ? `<label class="small">Průhlednost <input type="range" min="0.2" max="1" step="0.05" value="${S.opacity}" data-act="opacity"></label>
      <div class="muted small">Čas vyber na časové ose dole. Kliknutím do mapy zobrazíš hodnoty v bodě.</div>` : ''}
    ${S.grid ? '' : '<div class="muted small">Meteo mapa se načítá…</div>'}`;
}

function aspectButtons() {
  return `<div class="aspect-pick">${ASPECTS.map((a, i) =>
    `<button class="${slopeFilter.aspects[i] ? 'on' : ''}" data-act="aspect" data-i="${i}" style="--r:${i * 45}deg">${ASPECT_CS[a]}</button>`).join('')}</div>`;
}

// ============================================================================
// Stav aktualizace
// ============================================================================

function renderStatus() {
  const ts = Object.values(S.updated).filter(Boolean);
  const errs = Object.entries(S.errors).filter(([, v]) => v);
  const chipEl = document.getElementById('status');
  // bez spojení vrací service worker data z cache – poznáme to podle stáří předpovědi
  const stale = !DEMO && S.updated.forecast && Date.now() / 1000 - S.updated.forecast > (STATIC ? 3 : 2) * 3600;
  const offline = !navigator.onLine || stale || (errs.length > 0 && errs.length >= Object.keys(HANDLERS).length);
  chipEl.classList.toggle('warn', errs.length > 0);
  chipEl.classList.toggle('offline', offline);
  document.getElementById('status-text').textContent = offline
    ? (S.updated.forecast ? `Offline – data z ${fmtDateTime(Math.max(...ts))}` : 'Offline')
    : S.updated.forecast ? `Aktualizováno ${fmtTime(Math.max(...ts))}` : 'Načítám data…';
  document.getElementById('status-pop').innerHTML = `<b>Zdroje dat</b><table class="kv">${Object.entries(SOURCE_NAMES).map(([k, name]) => `
    <tr><td>${name}</td><td>${S.errors[k] ? '<span class="neg">chyba</span>' : S.updated[k] ? `${fmtTime(S.updated[k])} <small>(${ago(S.updated[k])})</small>` : '…'}</td></tr>`).join('')}</table>
    <div class="muted small">${STATIC
    ? 'Data automaticky stahuje GitHub zhruba každých 30 minut (meteo mapa po 3 h, trasy jednou denně), radar je živý.'
    : 'Data se obnovují automaticky (radar 5 min, předpověď a laviny 10–30 min, mapa 3 h). Server je stahuje i když máš aplikaci zavřenou.'}</div>`;
}

// ============================================================================
// Upozornění
// ============================================================================

/** Upozornění – na Androidu jde jen přes service worker, jinde i přímo. */
async function showNotification(title, opts) {
  try {
    const reg = 'serviceWorker' in navigator && await navigator.serviceWorker.getRegistration();
    if (reg) return await reg.showNotification(title, { icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', ...opts });
    return new Notification(title, opts);
  } catch (e) {
    console.warn('upozornění nelze zobrazit', e);
  }
}

function maybeNotify() {
  if (!S.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  const sent = store.get('notified', {});
  for (const i of [0, 1]) {
    const ds = addDays(S.today, i);
    for (const r of S.results) {
      const d = r.days[i];
      const key = `${r.area.id}:${ds}`;
      if (d && d.sc.score >= 75 && !sent[key]) {
        sent[key] = Date.now();
        showNotification(`Skialpy ${dayLabel(ds, S.today).toLowerCase()}: ${r.area.name} – ideální podmínky`, {
          body: d.sc.reasons.filter(x => x.s > 0).map(x => x.t).slice(0, 3).join(', '), tag: key,
        });
      }
    }
  }
  for (const [k, t] of Object.entries(sent)) if (Date.now() - t > 5 * 864e5) delete sent[k];
  store.set('notified', sent);
}

// ============================================================================
// Ovládání, modální okno, sidebar
// ============================================================================

// ============================================================================
// Otevření na mobilu (QR kód)
// ============================================================================

function qrSvg(url) {
  if (typeof qrcode !== 'function') return '';
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  return `<div class="qr">${qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true })}</div>`;
}

async function openMobileModal() {
  if (STATIC) {
    // veřejná verze na GitHub Pages – stačí poslat odkaz
    const url = location.origin + location.pathname.replace(/index\.html$/, '');
    openModal(`<h3>📱 Otevřít na mobilu / poslat kamarádům</h3>
      <div class="qr-card">${qrSvg(url)}<div><b>Veřejná adresa aplikace</b>
      <p class="muted">Funguje odkudkoli, stačí prohlížeč. Pošli ji klidně kamarádům.</p>
      <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></div></div>
      <p class="muted small">Naskenuj kód fotoaparátem telefonu. Pak v menu prohlížeče zvol <b>„Přidat na plochu“</b> –
      aplikace bude mít vlastní ikonu a bez signálu ukáže poslední stažená data.</p>`);
    return;
  }
  openModal('<h3>📱 Otevřít na mobilu</h3><div class="loading"><div class="spinner"></div>Zjišťuji adresu pro telefon…</div>');
  let ts = null;
  try {
    const r = await getJSON('api/access'); // server případně znovu zkusí Tailscale
    S.access = r.access;
    ts = r.tailscale;
  } catch { /* starší server – použijeme adresy z /api/meta */ }
  if (document.getElementById('modal').classList.contains('hidden')) return; // mezitím zavřeno
  const linkify = s => esc(s).replace(/https:\/\/\S+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  const tsProblem = ts?.wanted && !S.access?.tailscale && (ts.error || ts.note)
    ? `<div class="ts-problem"><b>Tailscale zatím nejde:</b> ${linkify(ts.error || '')} ${ts.note ? linkify(ts.note) : ''}
       <div class="muted small">Až to opravíš, klikni na 📱 znovu – server se k Tailscale připojí sám, bez restartu.</div></div>` : '';
  const acc = S.access || {};
  const here = location.hostname !== '127.0.0.1' && location.hostname !== 'localhost' ? location.origin + '/' : null;
  const cards = [];
  if (acc.tailscale) {
    cards.push(`<div class="qr-card">${qrSvg(acc.tailscale)}<div><b>Přes Tailscale – doma i venku</b>
      <p class="muted">Na telefonu musí běžet aplikace Tailscale přihlášená stejným účtem.</p>
      <a href="${esc(acc.tailscale)}" target="_blank" rel="noopener">${esc(acc.tailscale)}</a></div></div>`);
  }
  if (acc.lan) {
    cards.push(`<div class="qr-card">${qrSvg(acc.lan)}<div><b>Stejná Wi-Fi</b>
      <p class="muted">Funguje jen doma, telefon musí být na stejné síti jako počítač.</p>
      <a href="${esc(acc.lan)}" target="_blank" rel="noopener">${esc(acc.lan)}</a></div></div>`);
  }
  if (!cards.length && here) {
    cards.push(`<div class="qr-card">${qrSvg(here)}<div><b>Tato adresa</b><p><a href="${esc(here)}">${esc(here)}</a></p></div></div>`);
  }
  openModal(`<h3>📱 Otevřít na mobilu</h3>${tsProblem}
    ${cards.length ? cards.join('') + `<p class="muted small">Naskenuj kód fotoaparátem telefonu. Pak v menu prohlížeče zvol <b>„Přidat na plochu“</b> –
      aplikace bude mít vlastní ikonu a bez signálu ukáže poslední stažená data.</p>`
    : tsProblem ? '' : `<p>Aplikace teď běží jen na tomto počítači. Aby šla otevřít z telefonu:</p>
      <ol class="steps">
        <li>Nainstaluj <a href="https://tailscale.com/download" target="_blank" rel="noopener">Tailscale</a> do počítače i do telefonu a v obou se přihlas <b>stejným účtem</b>.</li>
        <li>Zavři okno serveru a spusť <b>start-tailscale.bat</b>.</li>
        <li>Klikni znovu na tlačítko 📱 – objeví se QR kód pro telefon.</li>
      </ol>
      <p class="muted small">Jen pro domácí Wi-Fi stačí spustit <b>start-mobil.bat</b>.</p>`}`);
}

function openModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal').classList.remove('hidden');
}
function closeModal() { document.getElementById('modal').classList.add('hidden'); }

function openSidebar() { document.body.classList.add('side-open'); }
function toggleSidebar() { document.body.classList.toggle('side-open'); }

function focusRoute(osm) {
  if (!L_.routes) return;
  if (!S.layers.routes) setLayer('routes', true);
  L_.routes.eachLayer(l => {
    if (l.feature.properties.osm === osm) {
      map.fitBounds(l.getBounds(), { maxZoom: 14, padding: [40, 40] });
      L.popup().setLatLng(l.getBounds().getCenter()).setContent(routePopup(l.feature.properties)).openOn(map);
    }
  });
}

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  if (['layer', 'base', 'meteo', 'notify'].includes(act)) return; // řeší 'change'
  switch (act) {
    case 'area': selectArea(t.dataset.id); break;
    case 'plan-from': {
      const a = S.areas.find(x => x.id === t.dataset.id);
      if (a) { planner.startFrom(a.lat, a.lon); setView('route'); openSidebar(); }
      break;
    }
    case 'day': S.dayIdx = +t.dataset.i; renderAreaMarkers(); renderView(); break;
    case 'view': setView(t.dataset.v); break;
    case 'aval-day': S.avalDay = +t.dataset.i; styleAval(); renderView(); break;
    case 'aval-detail':
      map.closePopup(); setView('aval'); openSidebar();
      setTimeout(() => document.getElementById('av-' + t.dataset.id)?.scrollIntoView({ behavior: 'smooth' }), 50);
      break;
    case 'slope-from': map.closePopup(); slopeFromBulletin(t.dataset.id); break;
    case 'cam-full': e.preventDefault(); openCamModal(t.dataset.id); break;
    case 'cams-run': S.camRun = 0; analyzeCams(); renderView(); break;
    case 'route': focusRoute(t.dataset.osm); break;
    case 'aspect': {
      const a = [...slopeFilter.aspects]; a[+t.dataset.i] = !a[+t.dataset.i];
      setSlopeFilter({ aspects: a }); break;
    }
    case 'slope-reset': setSlopeFilter({ aspects: ASPECTS.map(() => true), minElev: null, maxElev: null }); break;
    case 'close-layers': document.getElementById('layers').classList.remove('open'); break;
    default: break;
  }
});

document.addEventListener('change', async e => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  switch (t.dataset.act) {
    case 'layer': setLayer(t.value, t.checked); break;
    case 'base': setBase(t.value); break;
    case 'meteo': setMeteo(t.value); break;
    case 'label': S.label = t.value; store.set('label', S.label); renderAreaMarkers(); updateMeteo(); break;
    case 'opacity': S.opacity = +t.value; store.set('opacity', S.opacity); meteoGrid.setOpacity(S.opacity); break;
    case 'elev-min': setSlopeFilter({ minElev: t.value === '' ? null : +t.value }); break;
    case 'elev-max': setSlopeFilter({ maxElev: t.value === '' ? null : +t.value }); break;
    case 'sat-date':
      S.satDate = t.value || yesterday();
      for (const id of ['snowsat', 'truecolor']) {
        if (L_[id]) { map.removeLayer(L_[id]); L_[id] = null; }
        if (S.layers[id]) layerObj(id).addTo(map);
      }
      break;
    case 'notify':
      S.notify = t.checked; store.set('notify', S.notify);
      if (S.notify && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
      maybeNotify();
      break;
    default: break;
  }
});

document.addEventListener('input', e => {
  if (e.target.dataset.act === 'opacity') meteoGrid.setOpacity(+e.target.value);
});

document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
document.getElementById('btn-side').addEventListener('click', toggleSidebar);
document.getElementById('btn-layers').addEventListener('click', () => {
  const p = document.getElementById('layers');
  p.classList.toggle('open');
  if (p.classList.contains('open')) renderLayersPanel();
});
document.getElementById('btn-refresh').addEventListener('click', async ev => {
  const b = ev.currentTarget;
  b.classList.add('spin');
  S.camRun = 0;
  await refreshAll(true);
  b.classList.remove('spin');
});
document.getElementById('status').addEventListener('click', () => document.getElementById('status-pop').classList.toggle('hidden'));
document.getElementById('btn-mobile').addEventListener('click', openMobileModal);
window.addEventListener('online', renderStatus);
window.addEventListener('offline', renderStatus);
document.getElementById('modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.closest('.close')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// časová osa
document.getElementById('tb-range').addEventListener('input', e => onTimeChange(+e.target.value));
document.getElementById('tb-now').addEventListener('click', () => {
  S.timeKey = null; setupTimebar(); updateMeteo(); if (S.label !== 'score') renderAreaMarkers();
});
document.getElementById('tb-play').addEventListener('click', e => {
  const btn = e.currentTarget;
  if (playTimer) { clearInterval(playTimer); playTimer = null; btn.textContent = '▶'; return; }
  btn.textContent = '❚❚';
  playTimer = setInterval(() => {
    const r = document.getElementById('tb-range');
    let i = +r.value + 1;
    if (i > +r.max) i = 0;
    r.value = i;
    onTimeChange(i);
  }, 700);
});

// plánování trasy
const planner = createPlanner({
  map, viewEl, isShown: () => S.view === 'route', featureContains, openModal, qrSvg,
  aval: { bulletinFor, bulletinLevel, regionName, regions: () => S.regions, DANGER, PROBLEM_CS, NO_PROBLEM },
});

// hodnota pod kurzorem a bodová předpověď
const hoverEl = document.getElementById('hover');
map.on('mousemove', e => {
  if (!S.meteo || !S.grid) { hoverEl.classList.add('hidden'); return; }
  const v = meteoGrid.sample(S.meteo, timeIdx(), e.latlng.lat, e.latlng.lng);
  const conf = METEO_VARS[S.meteo];
  if (v == null) { hoverEl.classList.add('hidden'); return; }
  hoverEl.textContent = `${conf.label}: ${num(v, conf.dec)} ${conf.unit}`;
  hoverEl.classList.remove('hidden');
});
map.on('mouseout', () => hoverEl.classList.add('hidden'));
map.on('click', e => {
  if (planner.isActive()) { planner.addPoint(e.latlng); return; }
  if (!S.meteo || !S.grid) return;
  const t = timeIdx(), k = S.grid.times[t];
  const rows = Object.entries(METEO_VARS).map(([key, c]) => {
    const v = meteoGrid.sample(key, t, e.latlng.lat, e.latlng.lng);
    return `<tr><td>${c.label}</td><td><b>${num(v, c.dec)}</b> ${c.unit}</td></tr>`;
  }).join('');
  L.popup().setLatLng(e.latlng).setContent(`<div class="pp"><div class="pp-title">Předpověď v bodě</div>
    <div class="muted">${shortDate(k.slice(0, 10))} ${k.slice(11, 16)} · mřížka ~25 km, výška terénu modelu</div>
    <table class="kv">${rows}</table></div>`).openOn(map);
});

// ============================================================================
// Start
// ============================================================================

async function init() {
  renderStatus();
  renderView();
  const [meta, regions] = await Promise.all([getJSON(metaUrl()), getJSON(regionsUrl())]);
  S.areas = meta.areas;
  S.webcams = meta.webcams;
  S.access = meta.access;
  S.regions = regions;
  // přidání na plochu a záložní data bez signálu (jen na https nebo localhost)
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('service worker', e));
  }
  for (const c of S.webcams) (S.camsByArea[c.area] ||= []).push(c);
  for (const a of S.areas) {
    let f = regions.features.find(x => featureContains(x, a.lon, a.lat));
    if (!f) {
      const near = regions.features.map(x => [x, featureDistanceKm(x, a.lon, a.lat)]).sort((x, y) => x[1] - y[1])[0];
      if (near && near[1] <= 6) f = near[0];
    }
    if (f) S.areaRegion[a.id] = f.properties.id;
  }
  // po 16. hodině je zajímavější zítřek
  if (+S.nowKey.slice(11, 13) >= 16) S.dayIdx = 1;
  if (DEMO) {
    const b = document.getElementById('demo-banner');
    b.innerHTML = `Režim historie: ${new Date(DEMO + 'T12:00Z').toLocaleDateString('cs-CZ')} – archivní data, webkamery a stanice jsou živé. <a href="./">Zpět na aktuální stav</a>`;
    b.classList.remove('hidden');
  }

  renderWebcams();
  applyLayers();
  const routeFromLink = planner.loadFromHash();
  if (routeFromLink) { setView('route'); openSidebar(); }
  document.body.classList.add('side-open');
  // Výřez na všechny oblasti. Na kartě otevřené na pozadí může mít mapa nulovou velikost –
  // pak se výřez nastaví až ve chvíli, kdy mapa skutečně dostane rozměry.
  let fitted = false;
  const fitAreas = () => {
    map.invalidateSize({ pan: false });
    const size = map.getSize();
    if (size.x < 100 || size.y < 100) return;
    // na mobilu zakrývá spodek mapy panel – oblasti umístíme nad něj
    const sheet = window.innerWidth <= 760 ? document.getElementById('sidebar').offsetHeight : 0;
    if (routeFromLink) planner.fit(); // otevřený odkaz na trasu – ukázat trasu, ne všechny oblasti
    else {
      map.fitBounds(L.latLngBounds(S.areas.map(a => [a.lat, a.lon])),
        { paddingTopLeft: [20, 20], paddingBottomRight: [20, 20 + sheet], maxZoom: 9 });
    }
    fitted = true;
  };
  // velikost mapy se mění s panelem (i během animace) – Leaflet o tom musí vědět
  new ResizeObserver(() => {
    map.invalidateSize({ pan: false });
    if (!fitted) fitAreas();
  }).observe(document.getElementById('map'));
  fitAreas();
  setTimeout(() => { fitted = false; fitAreas(); }, 450);

  await refreshAll();
  setInterval(tick, 60e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}

init().catch(err => {
  console.error(err);
  viewEl.innerHTML = `<div class="empty neg">Aplikaci se nepodařilo spustit: ${esc(err.message)}.<br>Běží server (python server.py)?</div>`;
});
