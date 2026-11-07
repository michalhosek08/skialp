// Jednoduchý SVG graf předpovědi pro detail oblasti (bez knihoven).
import { num } from './util.js';

const WD = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];

/**
 * hourly: Open-Meteo hourly, i0..i1: rozsah indexů, nowIdx: index "teď".
 * Horní panel: teplota (°C) + nárazy větru (km/h, tečkovaně).
 * Dolní panel: sněžení (cm/h) a déšť (mm/h) jako sloupce + výška sněhu (cm).
 */
export function forecastChart(hourly, i0, i1, nowIdx) {
  const W = 380, padL = 30, padR = 32, h1 = 112, h2 = 92, gap = 18, top = 8;
  const n = i1 - i0 + 1;
  const xw = (W - padL - padR) / (n - 1);
  const X = i => padL + (i - i0) * xw;
  const g = k => (hourly[k] || []).slice(i0, i1 + 1);
  const temp = g('temperature_2m'), gust = g('wind_gusts_10m'), sf = g('snowfall'), rain = g('rain'), depth = g('snow_depth');

  // osy
  const tv = temp.filter(v => v != null);
  let tMin = Math.floor(Math.min(...tv, 0) / 5) * 5, tMax = Math.ceil(Math.max(...tv, 0) / 5) * 5;
  if (tMax - tMin < 10) tMax = tMin + 10;
  const Yt = v => top + h1 - (v - tMin) / (tMax - tMin) * h1;
  const gMax = Math.max(60, Math.ceil(Math.max(...gust.filter(v => v != null), 0) / 20) * 20);
  const Yg = v => top + h1 - v / gMax * h1;

  const b0 = top + h1 + gap;
  const pMax = Math.max(2, Math.ceil(Math.max(...sf.map(v => v ?? 0), ...rain.map(v => v ?? 0))));
  const Yp = v => b0 + h2 - v / pMax * h2;
  const dv = depth.map(v => v == null ? null : v * 100);
  const dMax = Math.max(20, Math.ceil(Math.max(...dv.filter(v => v != null), 0) / 20) * 20);
  const Yd = v => b0 + h2 - v / dMax * h2;

  const parts = [];
  // pozadí panelů
  parts.push(`<rect x="${padL}" y="${top}" width="${W - padL - padR}" height="${h1}" class="ch-bg"/>`);
  parts.push(`<rect x="${padL}" y="${b0}" width="${W - padL - padR}" height="${h2}" class="ch-bg"/>`);

  // dny
  const T = hourly.time;
  for (let i = i0; i <= i1; i++) {
    const hh = T[i].slice(11, 13);
    if (hh === '00') parts.push(`<line x1="${X(i)}" x2="${X(i)}" y1="${top}" y2="${b0 + h2}" class="ch-day"/>`);
    if (hh === '12') {
      const d = new Date(T[i].slice(0, 10) + 'T12:00Z');
      parts.push(`<text x="${X(i)}" y="${b0 + h2 + 13}" class="ch-lbl" text-anchor="middle">${WD[d.getUTCDay()]} ${d.getUTCDate()}.</text>`);
    }
  }
  // mřížka teploty
  for (let v = tMin; v <= tMax; v += 5) {
    parts.push(`<line x1="${padL}" x2="${W - padR}" y1="${Yt(v)}" y2="${Yt(v)}" class="${v === 0 ? 'ch-zero' : 'ch-grid'}"/>`);
    parts.push(`<text x="${padL - 4}" y="${Yt(v) + 3}" class="ch-lbl" text-anchor="end">${v}°</text>`);
  }
  for (let v = 0; v <= gMax; v += gMax / 3) {
    parts.push(`<text x="${W - padR + 4}" y="${Yg(v) + 3}" class="ch-lbl ch-gust-l">${Math.round(v)}</text>`);
  }
  // čáry
  const path = (arr, Y) => {
    let d = '', pen = false;
    arr.forEach((v, k) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${X(i0 + k).toFixed(1)},${Y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  parts.push(`<path d="${path(gust, Yg)}" class="ch-gust"/>`);
  parts.push(`<path d="${path(temp, Yt)}" class="ch-temp"/>`);

  // srážky
  const bw = Math.max(1, xw * 0.9);
  sf.forEach((v, k) => {
    if (v > 0) parts.push(`<rect x="${X(i0 + k) - bw / 2}" y="${Yp(v)}" width="${bw}" height="${b0 + h2 - Yp(v)}" class="ch-snow"/>`);
  });
  rain.forEach((v, k) => {
    if (v > 0) parts.push(`<rect x="${X(i0 + k) - bw / 2}" y="${Yp(v)}" width="${bw}" height="${b0 + h2 - Yp(v)}" class="ch-rain"/>`);
  });
  parts.push(`<path d="${path(dv, Yd)}" class="ch-depth"/>`);
  parts.push(`<text x="${padL - 4}" y="${b0 + 8}" class="ch-lbl" text-anchor="end">${pMax}</text>`);
  parts.push(`<text x="${padL - 4}" y="${b0 + h2}" class="ch-lbl" text-anchor="end">0</text>`);
  parts.push(`<text x="${W - padR + 4}" y="${b0 + 8}" class="ch-lbl ch-depth-l">${dMax}</text>`);
  parts.push(`<text x="${W - padR + 4}" y="${b0 + h2}" class="ch-lbl ch-depth-l">0</text>`);

  // teď
  if (nowIdx >= i0 && nowIdx <= i1) {
    parts.push(`<line x1="${X(nowIdx)}" x2="${X(nowIdx)}" y1="${top - 4}" y2="${b0 + h2}" class="ch-now"/>`);
    parts.push(`<text x="${X(nowIdx) + 3}" y="${top + 6}" class="ch-lbl ch-now-l">teď</text>`);
  }

  const legend = `<div class="ch-legend">
    <span><i class="lg-temp"></i>teplota</span><span><i class="lg-gust"></i>nárazy km/h</span>
    <span><i class="lg-snow"></i>sněžení cm/h</span><span><i class="lg-rain"></i>déšť mm/h</span>
    <span><i class="lg-depth"></i>sníh cm</span></div>`;
  const H = b0 + h2 + 18;
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Graf předpovědi">${parts.join('')}</svg>${legend}`;
}

/** Krátká textová hodnota s jednotkou. */
export const v = (x, unit, dec = 0) => x == null ? '–' : `${num(x, dec)} ${unit}`;
