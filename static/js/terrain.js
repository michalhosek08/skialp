// Výška, sklon a expozice terénu z výškového modelu (dlaždice Terrarium) pro body trasy.
import { loadDem } from './layers.js';

const Z = 13;                       // ~12 m na pixel ve střední Evropě
const WORLD = 256 * 2 ** Z;
const SLOPE_RADIUS = 3;             // sklon hledáme do ~3 px (~40 m) od trasy
const RAD = 180 / Math.PI;

const toPx = (lat, lon) => {
  const s = Math.sin(lat * Math.PI / 180);
  return [(lon + 180) / 360 * WORLD, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD];
};

/**
 * Pro body [{lat, lon}] vrátí { ele: [], slope: [], aspect: [] }.
 * slope = největší sklon terénu (°) v okolí ~40 m (svahy těsně nad trasou se počítají),
 * aspect = expozice toho svahu jako index 0–7 (S, SV, V, JV, J, JZ, Z, SZ), ele = výška (m).
 */
export async function sampleTerrain(points) {
  const tiles = new Map();
  const need = new Set();
  const px = points.map(p => toPx(p.lat, p.lon));
  for (const [x, y] of px) {
    for (const dx of [-SLOPE_RADIUS - 2, SLOPE_RADIUS + 2]) for (const dy of [-SLOPE_RADIUS - 2, SLOPE_RADIUS + 2]) {
      need.add(`${Math.floor((x + dx) / 256)}/${Math.floor((y + dy) / 256)}`);
    }
  }
  await Promise.all([...need].map(async k => {
    const [tx, ty] = k.split('/').map(Number);
    try { tiles.set(k, await loadDem(Z, tx, ty)); } catch { tiles.set(k, null); }
  }));

  const get = (gx, gy) => {
    const t = tiles.get(`${Math.floor(gx / 256)}/${Math.floor(gy / 256)}`);
    if (!t) return NaN;
    return t[(gy & 255) * 256 + (gx & 255)];
  };
  const elevAt = (x, y) => {   // bilineární interpolace
    const x0 = Math.floor(x - 0.5), y0 = Math.floor(y - 0.5), tx = x - 0.5 - x0, ty = y - 0.5 - y0;
    const a = get(x0, y0), b = get(x0 + 1, y0), c = get(x0, y0 + 1), d = get(x0 + 1, y0 + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };

  const ele = [], slope = [], aspect = [];
  points.forEach((p, i) => {
    const [x, y] = px[i];
    ele.push(elevAt(x, y));
    const res = 40075016.686 * Math.cos(p.lat * Math.PI / 180) / WORLD; // m na pixel
    const cx = Math.floor(x), cy = Math.floor(y);
    let best = 0, bestAsp = null;
    for (let oy = -SLOPE_RADIUS; oy <= SLOPE_RADIUS; oy++) {
      for (let ox = -SLOPE_RADIUS; ox <= SLOPE_RADIUS; ox++) {
        if (ox * ox + oy * oy > SLOPE_RADIUS * SLOPE_RADIUS) continue;
        const gx = cx + ox, gy = cy + oy;
        const a = get(gx - 1, gy - 1), b = get(gx, gy - 1), c = get(gx + 1, gy - 1);
        const d = get(gx - 1, gy), f = get(gx + 1, gy);
        const g = get(gx - 1, gy + 1), h = get(gx, gy + 1), k = get(gx + 1, gy + 1);
        const dzdx = ((c + 2 * f + k) - (a + 2 * d + g)) / (8 * res);
        const dzdy = ((a + 2 * b + c) - (g + 2 * h + k)) / (8 * res);
        const s = Math.atan(Math.hypot(dzdx, dzdy)) * RAD;
        if (s > best) {
          best = s;
          bestAsp = Math.round(((Math.atan2(-dzdx, -dzdy) * RAD + 360) % 360) / 45) % 8;
        }
      }
    }
    slope.push(Number.isNaN(best) ? null : best);
    aspect.push(bestAsp);
  });
  return { ele, slope, aspect };
}
