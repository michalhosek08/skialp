// Výpočet úseků trasy (Mapy.com, BRouter, přímá čára), převzorkování a GPX.
import { MAPY_API_KEY } from './config.js';

export const HAS_MAPY = !!MAPY_API_KEY;

export const ENGINES = {
  mapy: { label: 'Mapy.com', attribution: 'Plánování © Mapy.com' },
  brouter: { label: 'BRouter', attribution: 'Plánování BRouter · data © OpenStreetMap' },
  line: { label: 'přímo', attribution: '' },
};

const R = 6371008.8;
export function haversine(a, b) {   // a, b = [lon, lat]
  const p = Math.PI / 180;
  const s = Math.sin((b[1] - a[1]) * p / 2) ** 2 +
    Math.cos(a[1] * p) * Math.cos(b[1] * p) * Math.sin((b[0] - a[0]) * p / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function fetchJson(url, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function routeMapy(a, b) {
  const q = new URLSearchParams({
    start: `${a.lon},${a.lat}`, end: `${b.lon},${b.lat}`,
    routeType: 'foot_hiking', format: 'geojson', lang: 'cs', apikey: MAPY_API_KEY,
  });
  const j = await fetchJson(`https://api.mapy.com/v1/routing/route?${q}`);
  const g = j.geometry?.geometry ?? j.geometry;
  const coords = g?.type === 'LineString' ? g.coordinates
    : g?.type === 'MultiLineString' ? g.coordinates.flat() : null;
  if (!coords?.length) throw new Error('Mapy.com: neznámý tvar odpovědi');
  return coords.map(c => [c[0], c[1]]);
}

async function routeBrouter(a, b) {
  const url = `https://brouter.de/brouter?lonlats=${a.lon},${a.lat}|${b.lon},${b.lat}` +
    '&profile=hiking-mountain&alternativeidx=0&format=geojson';
  const j = await fetchJson(url);
  const coords = j.features?.[0]?.geometry?.coordinates;
  if (!coords?.length) throw new Error('BRouter: prázdná trasa');
  return coords.map(c => [c[0], c[1]]);
}

const cache = new Map(); // jen v paměti během úprav trasy, nic se neukládá

/**
 * Spočítá úsek z bodu a do b. mode 'route' = po cestách (preferovaný plánovač, při chybě
 * ten druhý, nakonec přímá čára), 'line' = přímo. Vrací { coords: [[lon,lat]], engine, note }.
 */
export async function computeSegment(a, b, mode, preferred) {
  if (mode === 'line') return { coords: [[a.lon, a.lat], [b.lon, b.lat]], engine: 'line' };
  const order = preferred === 'mapy' && HAS_MAPY ? ['mapy', 'brouter'] : HAS_MAPY ? ['brouter', 'mapy'] : ['brouter'];
  const errors = [];
  for (const eng of order) {
    const key = `${eng}|${a.lat},${a.lon}|${b.lat},${b.lon}`;
    try {
      if (!cache.has(key)) cache.set(key, (eng === 'mapy' ? routeMapy : routeBrouter)(a, b));
      const coords = await cache.get(key);
      // přichytí začátek a konec úseku přesně k bodům (plánovač je posune na nejbližší cestu)
      return { coords: [[a.lon, a.lat], ...coords, [b.lon, b.lat]], engine: eng,
        note: errors.length ? `${ENGINES[order[0]].label} nedostupný` : '' };
    } catch (e) {
      cache.delete(key);
      errors.push(`${ENGINES[eng].label}: ${e.message || e}`);
    }
  }
  return { coords: [[a.lon, a.lat], [b.lon, b.lat]], engine: 'line', note: 'plánovač nedostupný – úsek vede přímo', errors };
}

/** Úsek pro export do GPX – Mapy.com export nedovoluje, proto přes BRouter. */
export async function segmentForExport(seg, a, b) {
  if (seg.engine !== 'mapy') return seg.coords;
  try {
    return [[a.lon, a.lat], ...(await routeBrouter(a, b)), [b.lon, b.lat]];
  } catch {
    return [[a.lon, a.lat], [b.lon, b.lat]];
  }
}

/**
 * Převzorkuje lomenou čáru po krocích ~step metrů.
 * segments = [[lon,lat]...] po úsecích; vrací body { lon, lat, d (m od startu), seg }.
 */
export function resample(segments, step = 25) {
  const out = [];
  let d = 0;
  segments.forEach((coords, si) => {
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i + 1];
      const len = haversine(a, b);
      if (!out.length) out.push({ lon: a[0], lat: a[1], d: 0, seg: si });
      if (len === 0) continue;
      const n = Math.max(1, Math.ceil(len / step));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        out.push({ lon: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t, d: d + len * t, seg: si });
      }
      d += len;
    }
  });
  return out;
}

/** Zjednodušení čáry (Douglas–Peucker) s tolerancí v metrech – pro import GPX. */
export function simplify(coords, tol = 15) {
  if (coords.length < 3) return coords.slice();
  const lat0 = coords[0][1] * Math.PI / 180;
  const xy = coords.map(c => [c[0] * 111320 * Math.cos(lat0), c[1] * 110540]);
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let best = -1, idx = -1;
    const [x1, y1] = xy[s], [x2, y2] = xy[e];
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    for (let i = s + 1; i < e; i++) {
      const [x, y] = xy[i];
      let t = len2 ? ((x - x1) * dx + (y - y1) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const dist = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
      if (dist > best) { best = dist; idx = i; }
    }
    if (best > tol) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return coords.filter((_, i) => keep[i]);
}

const xmlEsc = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

/** GPX 1.1 s trasou (trk) a body trasy (wpt). track = [{lon, lat, ele}] */
export function buildGpx(name, track, waypoints) {
  const pt = (p, tag) => `<${tag} lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">` +
    `${p.ele != null && !Number.isNaN(p.ele) ? `<ele>${p.ele.toFixed(1)}</ele>` : ''}${p.name ? `<name>${xmlEsc(p.name)}</name>` : ''}</${tag}>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Skialp" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${xmlEsc(name)}</name><time>${new Date().toISOString()}</time></metadata>
${waypoints.map(w => pt(w, 'wpt')).join('\n')}
<trk><name>${xmlEsc(name)}</name><trkseg>
${track.map(p => pt(p, 'trkpt')).join('\n')}
</trkseg></trk>
</gpx>
`;
}

/** Načte GPX – vrátí { name, coords: [[lon,lat]] } z trasy (trk/rte), jinak z bodů (wpt). */
export function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('soubor není platné GPX');
  const pick = sel => [...doc.getElementsByTagName(sel)].map(n => [+n.getAttribute('lon'), +n.getAttribute('lat')])
    .filter(c => Number.isFinite(c[0]) && Number.isFinite(c[1]));
  let coords = pick('trkpt');
  if (coords.length < 2) coords = pick('rtept');
  if (coords.length < 2) coords = pick('wpt');
  if (coords.length < 2) throw new Error('v souboru není žádná trasa');
  const name = doc.querySelector('trk > name, rte > name, metadata > name')?.textContent?.trim() || '';
  return { name, coords };
}
