// Adresy dat: buď lokální server (server.py), nebo statická verze na GitHub Pages,
// kde data každých ~30 min připraví GitHub Actions (tools/build_static.py).
// Všechny cesty jsou relativní, aby aplikace fungovala i v podsložce (uzivatel.github.io/skialp/).

export const STATIC = !!window.SKIALP_STATIC;

// verze pro obejití cache CDN (GitHub Pages drží soubory ~10 min)
const bust = () => Math.floor(Date.now() / 120e3);

export function dataUrl(name, params = {}) {
  if (STATIC) return `api/${name}.json?v=${bust()}`;
  const q = new URLSearchParams(params).toString();
  return `api/data/${name}${q ? '?' + q : ''}`;
}

export const metaUrl = () => STATIC ? `api/meta.json?v=${bust()}` : 'api/meta';
export const regionsUrl = () => 'data/avalanche_regions.geojson';
export const RADAR_URL = 'https://api.rainviewer.com/public/weather-maps.json';

export function demUrl(z, x, y) {
  return STATIC
    ? `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`
    : `tiles/dem/${z}/${x}/${y}.png`;
}

const ventusky = id => `https://webcams.ventusky.com/data/${id.slice(-2)}/${id}`;

/** Náhled kamery. Lokálně přes server (kvůli rozboru obrazu), staticky přímo z Ventusky. */
export function camThumbUrl(id, stamp) {
  if (!STATIC) return `api/webcam?id=${id}&t=${stamp}`;
  const t = new Date();
  const p = n => String(n).padStart(2, '0');
  const s = `${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}${p(Math.floor(t.getUTCMinutes() / 5) * 5)}`;
  return `${ventusky(id)}/latest_thumb.jpg?${s}`;
}

/** Velký snímek – seznam adres k vyzkoušení (poslední hodinové snímky, nakonec náhled). */
export function camFullUrls(id, stamp) {
  if (!STATIC) return [`api/webcam?id=${id}&full=1&t=${stamp}`, `api/webcam?id=${id}&t=${stamp}`];
  const out = [];
  for (const h of [0, 1, 2]) {
    const t = new Date(Date.now() - h * 3600e3);
    const p = n => String(n).padStart(2, '0');
    out.push(`${ventusky(id)}/hour/${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}_${p(t.getUTCHours())}00.jpg`);
  }
  out.push(camThumbUrl(id, stamp));
  return out;
}
