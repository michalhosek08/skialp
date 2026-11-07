// Mapové vrstvy: podklady, dlaždicové překryvy, sklon svahů z DEM a meteo mřížka.
import { colorScale, ASPECTS } from './util.js';
import { demUrl, STATIC } from './api.js';

/* global L */

export const BASE_LAYERS = {
  topo: {
    label: 'Turistická (OpenTopoMap)',
    make: () => L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17, subdomains: 'abc',
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM | styl © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    }),
  },
  osm: {
    label: 'OpenStreetMap',
    make: () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }),
  },
  esriTopo: {
    label: 'Topografická (Esri)',
    make: () => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, attribution: 'Tiles © Esri',
    }),
  },
  sat: {
    label: 'Letecká (Esri)',
    make: () => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics',
    }),
  },
};

export function hikingLayer() {
  return L.tileLayer('https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png', {
    maxZoom: 18, pane: 'trailPane', opacity: 0.85,
    attribution: 'Trasy © <a href="https://hiking.waymarkedtrails.org">Waymarked Trails</a>',
  });
}

export function pistesLayer() {
  return L.tileLayer('https://tiles.opensnowmap.org/pistes/{z}/{x}/{y}.png', {
    maxZoom: 18, pane: 'trailPane',
    attribution: 'Sjezdovky © <a href="https://www.opensnowmap.org">OpenSnowMap</a>',
  });
}

/** Satelitní vrstvy NASA GIBS (MODIS). date = 'YYYY-MM-DD'. */
export function gibsLayer(kind, date) {
  const conf = kind === 'snow'
    ? ['MODIS_Terra_NDSI_Snow_Cover', 'GoogleMapsCompatible_Level8', 'png', 8]
    : ['MODIS_Terra_CorrectedReflectance_TrueColor', 'GoogleMapsCompatible_Level9', 'jpg', 9];
  return L.tileLayer(
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${conf[0]}/default/${date}/${conf[1]}/{z}/{y}/{x}.${conf[2]}`,
    { maxNativeZoom: conf[3], maxZoom: 18, pane: 'satPane', opacity: kind === 'snow' ? 0.75 : 0.9,
      attribution: 'Satelit: <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>' });
}

// --- sklon svahů --------------------------------------------------------------

export const SLOPE_CLASSES = [
  { min: 27, color: [160, 210, 80, 150], label: '27–30°' },
  { min: 30, color: [255, 225, 0, 175], label: '30–35°' },
  { min: 35, color: [255, 135, 0, 190], label: '35–40°' },
  { min: 40, color: [225, 25, 25, 200], label: '40–45°' },
  { min: 45, color: [140, 30, 160, 210], label: '> 45°' },
];

const demCache = new Map();

function loadDem(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (demCache.has(key)) return demCache.get(key);
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, 256, 256).data;
      const e = new Float32Array(65536);
      for (let i = 0; i < 65536; i++) e[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
      resolve(e);
    };
    img.onerror = () => reject(new Error('DEM ' + key));
    if (STATIC) img.crossOrigin = 'anonymous'; // dlaždice z AWS – CORS povolený, jinak by šly jen zobrazit
    img.src = demUrl(z, x, y);
  });
  demCache.set(key, p);
  p.catch(() => demCache.delete(key));
  if (demCache.size > 500) demCache.delete(demCache.keys().next().value);
  return p;
}

export const SlopeLayer = L.GridLayer.extend({
  options: { minZoom: 11, maxNativeZoom: 15, maxZoom: 18, pane: 'slopePane', opacity: 0.8, tileSize: 256 },

  initialize(options) {
    L.GridLayer.prototype.initialize.call(this, options);
    // aspects: pole 8 boolean (S, SV, V, JV, J, JZ, Z, SZ); elev: [min, max] nebo null
    this.filter = { aspects: ASPECTS.map(() => true), minElev: null, maxElev: null, minSlope: 27 };
  },

  setFilter(f) {
    Object.assign(this.filter, f);
    this.redraw();
  },

  createTile(coords, done) {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 256;
    loadDem(coords.z, coords.x, coords.y)
      .then(elev => { this._draw(tile, elev, coords); done(null, tile); })
      .catch(err => done(err, tile));
    return tile;
  },

  _draw(tile, e, coords) {
    const n = 2 ** coords.z;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (coords.y + 0.5) / n)));
    const res = 40075016.686 * Math.cos(lat) / (256 * n); // m / pixel
    const ctx = tile.getContext('2d');
    const img = ctx.createImageData(256, 256);
    const o = img.data;
    const f = this.filter;
    const allAspects = f.aspects.every(Boolean);
    const RAD = 180 / Math.PI;
    for (let y = 0; y < 256; y++) {
      const ym = y > 0 ? y - 1 : y, yp = y < 255 ? y + 1 : y, sy = (yp - ym) * 4 * res;
      for (let x = 0; x < 256; x++) {
        const xm = x > 0 ? x - 1 : x, xp = x < 255 ? x + 1 : x, sx = (xp - xm) * 4 * res;
        const a = e[ym * 256 + xm], b = e[ym * 256 + x], c = e[ym * 256 + xp];
        const d = e[y * 256 + xm], ff = e[y * 256 + xp];
        const g = e[yp * 256 + xm], h = e[yp * 256 + x], i = e[yp * 256 + xp];
        const dzdx = ((c + 2 * ff + i) - (a + 2 * d + g)) / sx;  // k východu
        const dzdy = ((a + 2 * b + c) - (g + 2 * h + i)) / sy;   // k severu
        const slope = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) * RAD;
        if (slope < f.minSlope) continue;
        const elev = e[y * 256 + x];
        if (f.minElev != null && elev < f.minElev) continue;
        if (f.maxElev != null && elev > f.maxElev) continue;
        if (!allAspects) {
          const asp = (Math.atan2(-dzdx, -dzdy) * RAD + 360) % 360; // směr, kam svah "kouká"
          if (!f.aspects[Math.round(asp / 45) % 8]) continue;
        }
        let k = SLOPE_CLASSES.length - 1;
        while (k > 0 && slope < SLOPE_CLASSES[k].min) k--;
        const col = SLOPE_CLASSES[k].color, p = (y * 256 + x) * 4;
        o[p] = col[0]; o[p + 1] = col[1]; o[p + 2] = col[2]; o[p + 3] = col[3];
      }
    }
    ctx.putImageData(img, 0, 0);
  },
});

// --- meteo mřížka -------------------------------------------------------------

export const METEO_VARS = {
  temp: {
    label: 'Teplota', unit: '°C', field: 'temperature_2m', dec: 1,
    stops: [[-25, '#5e2a84'], [-15, '#2c5fb5'], [-8, '#5aa3d8'], [-3, '#bfe0f2'], [0, '#f4f4f4'],
      [3, '#fbd5bd'], [8, '#ee8a5c'], [15, '#d4351f'], [25, '#7a0d0d']],
  },
  precip: {
    label: 'Srážky', unit: 'mm/h', field: 'precipitation', dec: 1,
    stops: [[0.05, '#9fd3ff', 0], [0.1, '#9fd3ff', 0.55], [0.5, '#4aa0ff', 0.8], [2, '#1d5cff', 0.9],
      [5, '#7a2cff', 0.95], [10, '#d1007a', 1]],
  },
  snow24: {
    label: 'Nový sníh za 24 h', unit: 'cm', field: 'snowfall', accum: 24, dec: 0,
    stops: [[0.3, '#d9ecff', 0], [1, '#cfe6ff', 0.6], [5, '#7db6ff', 0.85], [10, '#3b7bff', 0.9],
      [20, '#6a3cff', 0.95], [40, '#c23cff', 1], [70, '#ff3cc6', 1]],
  },
  depth: {
    label: 'Výška sněhu', unit: 'cm', field: 'snow_depth', factor: 100, dec: 0,
    stops: [[0.5, '#eef6ff', 0], [2, '#e3f1ff', 0.55], [10, '#b0d6ff', 0.8], [30, '#62acff', 0.88],
      [60, '#1f74ff', 0.92], [100, '#5a2bd4', 0.95], [200, '#9e1fb0', 1]],
  },
  gust: {
    label: 'Nárazy větru', unit: 'km/h', field: 'wind_gusts_10m', dec: 0,
    stops: [[15, '#e0f3db', 0], [25, '#d6efc9', 0.5], [40, '#fee08b', 0.75], [60, '#fdae61', 0.85],
      [80, '#f46d43', 0.9], [100, '#d73027', 0.95], [130, '#67000d', 1]],
  },
};
for (const v of Object.values(METEO_VARS)) v.scale = colorScale(v.stops);

const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
const invMercY = y => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;

export class MeteoGrid {
  constructor(map) {
    this.map = map;
    this.grid = null;
    this.overlay = null;
    this.cache = new Map();
    this.opacity = 0.65;
  }

  setGrid(grid) {
    this.grid = grid;
    this.cache.clear();
    const { lats, lons } = grid;
    this.nlat = lats.length; this.nlon = lons.length;
    this.lat0 = lats[0]; this.lon0 = lons[0];
    this.dlat = lats[1] - lats[0]; this.dlon = lons[1] - lons[0];
    this.bounds = L.latLngBounds([lats[0], lons[0]], [lats[this.nlat - 1], lons[this.nlon - 1]]);
  }

  /** Hodnoty proměnné pro časový index (Float32Array podle bodů mřížky). */
  values(key, t) {
    const ck = key + ':' + t;
    if (this.cache.has(ck)) return this.cache.get(ck);
    const v = METEO_VARS[key], F = this.grid.fields[v.field];
    const n = this.nlat * this.nlon, out = new Float32Array(n).fill(NaN);
    if (v.accum) {
      for (let p = 0; p < n; p++) {
        let s = 0;
        for (let k = Math.max(0, t - v.accum + 1); k <= t; k++) s += F[k][p] ?? 0;
        out[p] = s;
      }
    } else {
      const row = F[t];
      for (let p = 0; p < n; p++) if (row[p] != null) out[p] = row[p] * (v.factor || 1);
    }
    if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(ck, out);
    return out;
  }

  sample(key, t, lat, lon) {
    if (!this.grid) return null;
    const fi = (lat - this.lat0) / this.dlat, fj = (lon - this.lon0) / this.dlon;
    if (fi < 0 || fj < 0 || fi > this.nlat - 1 || fj > this.nlon - 1) return null;
    const vals = this.values(key, t);
    const i0 = Math.min(this.nlat - 2, Math.floor(fi)), j0 = Math.min(this.nlon - 2, Math.floor(fj));
    const ti = fi - i0, tj = fj - j0, N = this.nlon;
    const v00 = vals[i0 * N + j0], v01 = vals[i0 * N + j0 + 1], v10 = vals[(i0 + 1) * N + j0], v11 = vals[(i0 + 1) * N + j0 + 1];
    const v = (v00 * (1 - tj) + v01 * tj) * (1 - ti) + (v10 * (1 - tj) + v11 * tj) * ti;
    return Number.isNaN(v) ? null : v;
  }

  show(key, t) {
    if (!this.grid || !key) { this.hide(); return; }
    const conf = METEO_VARS[key];
    const vals = this.values(key, t);
    const W = 520;
    const yTop = mercY(this.lat0 + this.dlat * (this.nlat - 1)), yBot = mercY(this.lat0);
    const lonSpan = this.dlon * (this.nlon - 1);
    const H = Math.round(W * (yTop - yBot) / (lonSpan * Math.PI / 180));
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(W, H), o = img.data, N = this.nlon;
    for (let r = 0; r < H; r++) {
      const lat = invMercY(yTop - (r + 0.5) / H * (yTop - yBot));
      const fi = (lat - this.lat0) / this.dlat;
      const i0 = Math.max(0, Math.min(this.nlat - 2, Math.floor(fi))), ti = Math.max(0, Math.min(1, fi - i0));
      for (let c = 0; c < W; c++) {
        const fj = (c + 0.5) / W * (this.nlon - 1);
        const j0 = Math.min(this.nlon - 2, Math.floor(fj)), tj = fj - j0;
        const v00 = vals[i0 * N + j0], v01 = vals[i0 * N + j0 + 1], v10 = vals[(i0 + 1) * N + j0], v11 = vals[(i0 + 1) * N + j0 + 1];
        const v = (v00 * (1 - tj) + v01 * tj) * (1 - ti) + (v10 * (1 - tj) + v11 * tj) * ti;
        const col = conf.scale(v);
        if (!col) continue;
        const p = (r * W + c) * 4;
        o[p] = col[0]; o[p + 1] = col[1]; o[p + 2] = col[2]; o[p + 3] = col[3] * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const url = cv.toDataURL('image/png');
    if (!this.overlay) {
      this.overlay = L.imageOverlay(url, this.bounds, { pane: 'meteoPane', opacity: this.opacity, interactive: false, className: 'meteo-img' });
      this.overlay.addTo(this.map);
    } else {
      this.overlay.setUrl(url);
      this.overlay.setBounds(this.bounds);
      if (!this.map.hasLayer(this.overlay)) this.overlay.addTo(this.map);
    }
  }

  setOpacity(o) {
    this.opacity = o;
    if (this.overlay) this.overlay.setOpacity(o);
  }

  hide() {
    if (this.overlay && this.map.hasLayer(this.overlay)) this.map.removeLayer(this.overlay);
  }
}

/** HTML legenda k meteo vrstvě. */
export function meteoLegend(key) {
  const v = METEO_VARS[key];
  const stops = v.stops.filter(s => (s[2] ?? 1) > 0);
  const lo = stops[0][0], hi = stops[stops.length - 1][0];
  const grad = stops.map(s => {
    const c = v.scale(s[0]);
    return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0.35, c[3]).toFixed(2)}) ${((s[0] - lo) / (hi - lo) * 100).toFixed(1)}%`;
  }).join(',');
  let last = -100;
  const ticks = stops.map(s => {
    const pos = (s[0] - lo) / (hi - lo) * 100;
    if (pos - last < 11 && pos < 100) return ''; // příliš blízko předchozí – vynechat
    last = pos;
    return `<span style="left:${pos.toFixed(1)}%">${s[0]}</span>`;
  }).join('');
  return `<div class="lg-title">${v.label} <small>(${v.unit})</small></div>
    <div class="lg-bar" style="background:linear-gradient(90deg,${grad})"></div><div class="lg-ticks">${ticks}</div>`;
}
