// Pomocné funkce: čas, čísla, barvy, geografie.

export const TZ = 'Europe/Prague';

const keyFmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

/** Aktuální hodina v pražském čase jako klíč Open-Meteo, např. "2026-11-07T16:00". */
export function nowHourKey(d = new Date()) {
  const s = keyFmt.format(d).replace(' ', 'T');
  return s.slice(0, 13) + ':00';
}

export function addDays(dayStr, n) {
  const t = new Date(dayStr + 'T12:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

const WD = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];
const WD_LONG = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'];

export function dayLabel(dayStr, todayStr, long = false) {
  const diff = Math.round((new Date(dayStr + 'T12:00Z') - new Date(todayStr + 'T12:00Z')) / 864e5);
  if (diff === 0) return 'Dnes';
  if (diff === 1) return 'Zítra';
  const d = new Date(dayStr + 'T12:00Z');
  const wd = (long ? WD_LONG : WD)[d.getUTCDay()];
  return `${wd.charAt(0).toUpperCase() + wd.slice(1)} ${d.getUTCDate()}. ${d.getUTCMonth() + 1}.`;
}

export function shortDate(dayStr) {
  const d = new Date(dayStr + 'T12:00Z');
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()}. ${d.getUTCMonth() + 1}.`;
}

export function fmtTime(ts) {
  if (!ts) return '–';
  const d = typeof ts === 'number' ? new Date(ts < 1e12 ? ts * 1000 : ts) : new Date(ts);
  return d.toLocaleTimeString('cs-CZ', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

export function fmtDateTime(ts) {
  const d = typeof ts === 'number' ? new Date(ts < 1e12 ? ts * 1000 : ts) : new Date(ts);
  return d.toLocaleString('cs-CZ', { timeZone: TZ, day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function ago(ts) {
  const ms = Date.now() - (typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : new Date(ts).getTime());
  const m = Math.round(ms / 60000);
  if (m < 1) return 'právě teď';
  if (m < 60) return `před ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `před ${h} h`;
  return `před ${Math.round(h / 24)} dny`;
}

/** Číslo s českou desetinnou čárkou. */
export function num(v, dec = 0) {
  if (v == null || Number.isNaN(v)) return '–';
  return Number(v).toLocaleString('cs-CZ', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

/** Český plurál: plural(3, 'oblast', 'oblasti', 'oblastí'). */
export function plural(n, one, few, many) {
  const a = Math.abs(n);
  if (a === 1) return one;
  if (a >= 2 && a <= 4) return few;
  return many;
}

export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

/** Po částech lineární interpolace přes body [[x, y], ...]. */
export function interp(x, pts) {
  if (x == null) return null;
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

export function distKm(lat1, lon1, lat2, lon2) {
  const p = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * p / 2) ** 2 +
    Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin((lon2 - lon1) * p / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

export function pointInPolygon(lon, lat, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export function featureContains(feature, lon, lat) {
  const g = feature.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.some(rings => pointInPolygon(lon, lat, rings));
}

export function featureDistanceKm(feature, lon, lat) {
  const g = feature.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let best = Infinity;
  for (const rings of polys) for (const ring of rings) for (const [x, y] of ring) {
    best = Math.min(best, distKm(lat, lon, y, x));
  }
  return best;
}

// --- barevné škály -------------------------------------------------------

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Vytvoří funkci hodnota -> [r,g,b,a] ze zarážek [[hodnota, '#hex', alfa?], ...]. */
export function colorScale(stops) {
  const s = stops.map(([v, c, a = 1]) => [v, ...hexToRgb(c), a]);
  return (v) => {
    if (v == null || Number.isNaN(v)) return null;
    if (v <= s[0][0]) return s[0].slice(1);
    for (let i = 1; i < s.length; i++) {
      if (v <= s[i][0]) {
        const t = (v - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
        return [1, 2, 3, 4].map(k => s[i - 1][k] + (s[i][k] - s[i - 1][k]) * t);
      }
    }
    return s[s.length - 1].slice(1);
  };
}

export const ASPECTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const ASPECT_CS = { N: 'S', NE: 'SV', E: 'V', SE: 'JV', S: 'J', SW: 'JZ', W: 'Z', NW: 'SZ' };

export function windDirCs(deg) {
  if (deg == null) return '';
  const names = ['S', 'SV', 'V', 'JV', 'J', 'JZ', 'Z', 'SZ'];
  return names[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

export async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const store = {
  get(k, def) {
    try { const v = localStorage.getItem('skialp.' + k); return v == null ? def : JSON.parse(v); } catch { return def; }
  },
  set(k, v) {
    try { localStorage.setItem('skialp.' + k, JSON.stringify(v)); } catch { /* soukromé okno apod. */ }
  },
};
