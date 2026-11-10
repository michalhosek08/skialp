// Vyhodnocení podmínek pro skialpy: metriky z předpovědi, skóre 0–100 a souhrn situace.
import { interp, clamp, num, plural, addDays, dayLabel } from './util.js';

export const DANGER = {
  0: { name: 'bez hodnocení', color: '#bdbdbd' },
  1: { name: 'nízké', color: '#ccff66' },
  2: { name: 'mírné', color: '#ffff00' },
  3: { name: 'značné', color: '#ff9900' },
  4: { name: 'vysoké', color: '#ff0000' },
  5: { name: 'velmi vysoké', color: '#7a0000' },
};

export const CATEGORIES = [
  { min: 75, key: 'ideal', label: 'Ideální', color: '#0b8f4d' },
  { min: 60, key: 'great', label: 'Velmi dobré', color: '#3fae3a' },
  { min: 45, key: 'good', label: 'Dobré', color: '#a3c614' },
  { min: 30, key: 'fair', label: 'Průměrné', color: '#f0a020' },
  { min: 0, key: 'poor', label: 'Nevhodné', color: '#d9452b' },
];
export const NO_SNOW = { key: 'nosnow', label: 'Málo sněhu', color: '#8d99a6' };

export function category(score, noSnow) {
  if (noSnow) return NO_SNOW;
  return CATEGORIES.find(c => score >= c.min);
}

// --- agregace přes hodinová data ------------------------------------------

function range(arr, a, b, fn) {
  let acc = null;
  for (let i = Math.max(0, a); i <= b && i < arr.length; i++) {
    const v = arr[i];
    if (v == null) continue;
    acc = acc == null ? v : fn(acc, v);
  }
  return acc;
}
const sum = (arr, a, b) => range(arr, a, b, (x, y) => x + y);
const max = (arr, a, b) => range(arr, a, b, Math.max);
const min = (arr, a, b) => range(arr, a, b, Math.min);
function avg(arr, a, b) {
  let s = 0, n = 0;
  for (let i = Math.max(0, a); i <= b && i < arr.length; i++) if (arr[i] != null) { s += arr[i]; n++; }
  return n ? s / n : null;
}

/** Metriky jednoho dne pro túru (okno 8–15 h). */
export function dayMetrics(hourly, dayStr) {
  const T = hourly.time;
  const i9 = T.indexOf(dayStr + 'T09:00');
  if (i9 < 0) return null;
  const w0 = i9 - 1, w1 = i9 + 6; // 8:00–15:00
  const g = k => hourly[k] || [];
  const depth = g('snow_depth')[i9];
  return {
    day: dayStr,
    depth: depth == null ? null : depth * 100,
    new24: sum(g('snowfall'), i9 - 24, i9 - 1) ?? 0,
    new72: sum(g('snowfall'), i9 - 72, i9 - 1) ?? 0,
    winSnow: sum(g('snowfall'), w0, w1) ?? 0,
    winPrecip: sum(g('precipitation'), w0, w1) ?? 0,
    winRain: sum(g('rain'), w0, w1) ?? 0,
    gust: max(g('wind_gusts_10m'), w0, w1),
    wind: avg(g('wind_speed_10m'), w0, w1),
    windDir: avg(g('wind_direction_10m'), w0, w1),
    cloud: avg(g('cloud_cover'), w0, w1),
    vis: min(g('visibility'), w0, w1),
    tMin: min(g('temperature_2m'), i9 - 9, i9),
    tMax: max(g('temperature_2m'), w0, w1),
    freezing: avg(g('freezing_level_height'), w0, w1),
    // sníh, který teprve napadne do konce dne (pro výhled)
    snowRestOfDay: sum(g('snowfall'), w1 + 1, i9 + 15) ?? 0,
  };
}

/** Aktuální hodnoty (hodina "teď"). */
export function nowMetrics(hourly, nowKey) {
  const i = hourly.time.indexOf(nowKey);
  if (i < 0) return null;
  const g = k => (hourly[k] || [])[i];
  return {
    t: g('temperature_2m'), wind: g('wind_speed_10m'), gust: g('wind_gusts_10m'), dir: g('wind_direction_10m'),
    depth: g('snow_depth') == null ? null : g('snow_depth') * 100, cloud: g('cloud_cover'),
    precip: g('precipitation'), snowfall: g('snowfall'), vis: g('visibility'),
    freezing: g('freezing_level_height'), code: g('weather_code'),
    snowNext24: sum(hourly.snowfall || [], i + 1, i + 24) ?? 0,
    snowNext72: sum(hourly.snowfall || [], i + 1, i + 72) ?? 0,
    snowPast24: sum(hourly.snowfall || [], i - 23, i) ?? 0,
  };
}

// --- skóre ------------------------------------------------------------------

/**
 * Ohodnotí den. ctx = { danger: 0–5 | null, cams: souhrn z webkamer | null }
 * Vrací { score, cat, noSnow, reasons: [{ t, s: +1 | 0 | -1 }] }.
 */
export function scoreDay(m, ctx = {}) {
  const reasons = [];
  const R = (t, s = 0) => reasons.push({ t, s });
  const depth = m.depth ?? 0;

  // Sníh (0–40 b.)
  const snowPts = interp(depth, [[0, 0], [10, 0], [20, 8], [50, 25], [100, 36], [160, 40]]);
  if (depth < 15) R(`jen ${num(depth)} cm sněhu`, -1);
  else if (depth < 40) R(`${num(depth)} cm sněhu – zatím slabá základna`, 0);
  else R(`${num(depth)} cm sněhu`, +1);

  // Nový sníh (0–15 b.)
  let freshPts = interp(m.new72, [[0, 0], [3, 3], [10, 10], [25, 15]]);
  if (m.tMax != null && m.tMax > 3 && m.new72 > 2) freshPts *= 0.4; // rychle těžkne
  if (m.new72 >= 3) R(`${num(m.new72)} cm nového sněhu za 3 dny`, +1);
  if (m.new24 >= 20) R(`${num(m.new24)} cm za 24 h – čerstvé převěje a deskové laviny`, -1);

  // Počasí během túry (0–35 b.)
  let w = 35;
  if (m.winRain >= 0.3) { w -= Math.min(14, 4 + m.winRain * 3); R(`déšť během dne (${num(m.winRain, 1)} mm)`, -1); }
  if (m.winSnow >= 1) { w -= Math.min(10, m.winSnow * 1.5); R(`sněžení během dne (${num(m.winSnow)} cm)`, -1); }
  else if (m.winPrecip >= 1 && m.winRain < 0.3) w -= Math.min(6, m.winPrecip * 2);
  if (m.cloud != null) {
    w -= (m.cloud / 100) * 8;
    if (m.cloud <= 30) R('převážně jasno', +1);
    else if (m.cloud >= 85) R('zataženo', -1);
  }
  if (m.vis != null && m.vis < 1000) { w -= 6; R('mlha / špatná viditelnost', -1); }
  if (m.gust != null) {
    if (m.gust > 40) w -= Math.min(22, (m.gust - 40) * 0.35);
    if (m.gust >= 70) R(`silný vítr – nárazy až ${num(m.gust)} km/h`, -1);
    else if (m.gust >= 50) R(`nárazy větru až ${num(m.gust)} km/h`, -1);
    else if (m.gust <= 25) R('slabý vítr', +1);
  }
  if (m.tMax != null) {
    if (m.tMax >= 6) { w -= Math.min(8, (m.tMax - 6) * 1.5 + 2); R(`obleva až ${num(m.tMax)} °C – těžký, mokrý sníh`, -1); }
    else if (m.tMax <= -15) { w -= 4; R(`silný mráz (${num(m.tMax)} °C)`, -1); }
  }
  if (m.tMin != null && m.tMax != null && m.tMin <= -1 && m.tMax >= 2 && m.new72 < 3 && depth >= 30) {
    w += 3; R('přes noc mrzne, přes den firn', +1);
  }
  w = clamp(w, 0, 38);

  let total = snowPts + freshPts + w;

  // Laviny
  const d = ctx.danger;
  if (d != null && d > 0) {
    total -= { 1: 0, 2: 3, 3: 18, 4: 45, 5: 70 }[d];
    R(`lavinové nebezpečí ${d} – ${DANGER[d].name}`, d >= 3 ? -1 : 0);
  } else if (m.new72 >= 40) {
    total -= 8; R('hodně nového sněhu – zvýšené lavinové riziko', -1);
  }

  // Webkamery (jen pro dnešek)
  const c = ctx.cams;
  if (c && c.n > 0) {
    if (c.fog >= c.n / 2) { total -= 4; R('kamery: mlha / nízká oblačnost', -1); }
    else if (c.clear >= c.n / 2) { total += 2; R('kamery: dobrá viditelnost', +1); }
    if (c.snowAvg != null) {
      if (c.snowAvg >= 0.35) R(`kamery: sníh potvrzen (~${num(c.snowAvg * 100)} % záběru)`, +1);
      else if (c.snowAvg < 0.08 && depth >= 20) { total -= 3; R('kamery: sníh téměř nevidět', -1); }
    }
  }

  let score = Math.round(clamp(total / 93 * 100, 0, 100));
  const noSnow = depth < 15;
  if (noSnow) score = Math.min(score, Math.round(3 + depth * 0.8)); // pořadí pak určuje hlavně sníh
  return { score, cat: category(score, noSnow), noSnow, reasons };
}

// --- souhrn z webkamer ----------------------------------------------------

export function summarizeCams(analyses) {
  const fresh = analyses.filter(a => a && !a.night && Date.now() - a.ts < 75 * 60e3);
  if (!fresh.length) return null;
  const snow = fresh.filter(a => a.snow != null);
  return {
    n: fresh.length,
    fog: fresh.filter(a => a.visibility === 'fog').length,
    clear: fresh.filter(a => a.visibility === 'good').length,
    snowAvg: snow.length ? snow.reduce((s, a) => s + a.snow, 0) / snow.length : null,
  };
}

// --- celkový přehled --------------------------------------------------------

/**
 * results: [{ area, days: [{ m, sc }], now }], dayIdx: vybraný den,
 * aval: { today: { regionId: level }, regionsWithBulletin, lastPublished }
 */
export function buildOverview(results, dayIdx, aval, today) {
  const valid = results.filter(r => r.days[dayIdx]);
  const ranked = [...valid].sort((a, b) => b.days[dayIdx].sc.score - a.days[dayIdx].sc.score);
  const withSnow = valid.filter(r => (r.days[0].m.depth ?? 0) >= 20);
  const deepest = [...valid].sort((a, b) => (b.days[0].m.depth ?? 0) - (a.days[0].m.depth ?? 0));
  const upcoming = [...valid].sort((a, b) => (b.now?.snowNext72 ?? 0) - (a.now?.snowNext72 ?? 0));
  const windy = valid.filter(r => (r.days[dayIdx].m.gust ?? 0) >= 70);
  const dayStr = addDays(today, dayIdx);
  const dl = dayLabel(dayStr, today).toLowerCase();

  // nejlepší den z následujících tří
  const dayAvg = [0, 1, 2].map(i => {
    const s = results.map(r => r.days[i]?.sc.score).filter(v => v != null).sort((a, b) => b - a).slice(0, 5);
    return s.length ? s.reduce((x, y) => x + y, 0) / s.length : 0;
  });
  const bestDay = dayAvg.indexOf(Math.max(...dayAvg));

  const lines = [];
  let season;
  const top = deepest[0];
  const topDepth = top?.days[0].m.depth ?? 0;
  if (withSnow.length === 0) {
    season = 'off';
    lines.push(`<b>Sezóna zatím nezačala.</b> Nikde neleží souvislá vrstva sněhu – nejvíc je ${top ? `v oblasti <b>${top.area.name}</b> (${top.area.range}), asi ${num(topDepth)} cm` : 'zatím nic'}.`);
  } else if (withSnow.length < 6) {
    season = 'edge';
    lines.push(`<b>Sníh je jen v nejvyšších polohách</b> – alespoň 20 cm hlásí ${withSnow.length} ${plural(withSnow.length, 'oblast', 'oblasti', 'oblastí')}. Nejvíc: <b>${top.area.name}</b> (${num(topDepth)} cm).`);
  } else {
    season = 'on';
    const t3 = deepest.slice(0, 3).map(r => `${r.area.name} ${num(r.days[0].m.depth)} cm`).join(', ');
    lines.push(`<b>Lyžovatelných oblastí: ${withSnow.length} z ${valid.length}.</b> Nejvíc sněhu: ${t3}.`);
  }

  const up = upcoming[0];
  if (up && (up.now?.snowNext72 ?? 0) >= 5) {
    const many = upcoming.filter(r => (r.now?.snowNext72 ?? 0) >= 5).length;
    lines.push(`V příštích 3 dnech má nasněžit – nejvíc <b>${up.area.name}</b> (až ${num(up.now.snowNext72)} cm)${many > 1 ? `, celkem v ${many} ${plural(many, 'oblasti', 'oblastech', 'oblastech')}` : ''}.`);
  } else {
    lines.push('V příštích 3 dnech se nečeká výraznější sněžení.');
  }

  if (windy.length) {
    lines.push(`${dl.charAt(0).toUpperCase() + dl.slice(1)} pozor na silný vítr (nárazy přes 70 km/h) v ${windy.length} ${plural(windy.length, 'oblasti', 'oblastech', 'oblastech')}: ${windy.slice(0, 4).map(r => r.area.name).join(', ')}.`);
  }

  // laviny
  const lv = aval?.levels || {};
  const regs = Object.entries(lv).filter(([, v]) => v > 0);
  if (regs.length) {
    const maxL = Math.max(...regs.map(([, v]) => v));
    const names = regs.filter(([, v]) => v === maxL).map(([k]) => aval.names[k] || k);
    const more = names.length - 4;
    lines.push(`<b>Laviny:</b> nejvyšší stupeň ${maxL} (${DANGER[maxL].name}) – ${names.slice(0, 4).join(', ')}${
      more > 0 ? ` a ${more} ${plural(more, 'další region', 'další regiony', 'dalších regionů')}` : ''}.`);
  } else if (aval) {
    lines.push(`<b>Laviny:</b> lavinové předpovědi se ${season === 'off' ? 'mimo sezónu ' : ''}zatím nevydávají${aval.lastPublished ? ` (poslední vyšla ${new Date(aval.lastPublished).toLocaleDateString('cs-CZ')})` : ''}. Hodnoť terén sám.`);
  }

  if (bestDay !== dayIdx && dayAvg[bestDay] > dayAvg[dayIdx] + 8) {
    lines.push(`Nejlepší vyhlídky jsou <b>${dayLabel(addDays(today, bestDay), today).toLowerCase().replace(/\.$/, '')}</b>.`);
  }

  // titulek
  const best = ranked[0];
  let headline;
  if (!best || best.days[dayIdx].sc.noSnow) {
    headline = season === 'off' ? 'Na skialpy je zatím málo sněhu' : `${dl.charAt(0).toUpperCase() + dl.slice(1)} nikde dobré podmínky`;
  } else {
    const sc = best.days[dayIdx].sc;
    headline = sc.score >= 60
      ? `${dl.charAt(0).toUpperCase() + dl.slice(1)} to nejlépe vypadá: ${best.area.name}`
      : `${dl.charAt(0).toUpperCase() + dl.slice(1)} spíš průměr – nejlépe ${best.area.name}`;
  }

  return { headline, lines, ranked, season, bestDay, dayAvg };
}
