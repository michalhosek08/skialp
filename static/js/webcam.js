// Rozbor snímku z webkamery: sníh, viditelnost (mlha), obloha, noc.
// Jednoduché heuristiky nad zmenšeným obrázkem – orientační, ne měření.

const W = 160;

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('obrázek se nenačetl'));
    img.src = src;
  });
}

/** Výška Slunce nad obzorem (°) – zjednodušené astronomické vzorce, přesnost ~0,5°. */
export function sunElevation(lat, lon, date = new Date()) {
  const rad = Math.PI / 180;
  const d = date.getTime() / 864e5 - 10957.5; // dny od J2000.0
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const lam = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  const ha = (gmst * 15 + lon) * rad - ra;
  return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha)) / rad;
}

/** sunEl: výška Slunce u kamery – za soumraku a v noci snímek nehodnotíme. */
export function analyzeImage(img, sunEl = 90) {
  const h = Math.max(40, Math.round(W * img.naturalHeight / img.naturalWidth));
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, h);
  const px = ctx.getImageData(0, 0, W, h).data;

  // okraje (časové razítko, logo) vynecháme
  const y0 = Math.round(h * 0.06), y1 = Math.round(h * 0.94);
  const L = new Float32Array(W * h);
  let sumL = 0, sumL2 = 0, n = 0;
  let skyBlue = 0, skyN = 0, snow = 0, groundN = 0, bright = 0;
  const skyEnd = Math.round(h * 0.33), groundStart = Math.round(h * 0.45);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      L[y * W + x] = l;
      if (y < y0 || y > y1) continue;
      sumL += l; sumL2 += l * l; n++;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx ? (mx - mn) / mx : 0;
      if (l > 200) bright++;
      if (y < skyEnd) {
        skyN++;
        if (b > r + 18 && b >= g && l > 80) skyBlue++;
      }
      if (y >= groundStart) {
        groundN++;
        // sníh: světlý, málo sytý, spíš neutrální až namodralý
        if (l > 150 && sat < 0.2 && b >= r - 12) snow++;
      }
    }
  }
  const mean = sumL / n;
  const std = Math.sqrt(Math.max(0, sumL2 / n - mean * mean));

  // hustota hran (Sobel) – měřítko kontrastu detailů / viditelnosti
  let edge = 0, en = 0;
  for (let y = Math.max(1, y0); y < Math.min(h - 1, y1); y++) {
    for (let x = 1; x < W - 1; x++) {
      const k = y * W + x;
      const gx = -L[k - W - 1] - 2 * L[k - 1] - L[k + W - 1] + L[k - W + 1] + 2 * L[k + 1] + L[k + W + 1];
      const gy = -L[k - W - 1] - 2 * L[k - W] - L[k - W + 1] + L[k + W - 1] + 2 * L[k + W] + L[k + W + 1];
      edge += Math.sqrt(gx * gx + gy * gy); en++;
    }
  }
  edge /= en;

  const night = sunEl < 3 || (mean < 42 && bright / n < 0.05);
  let visibility = 'reduced';
  if (!night) {
    if (std < 26 && edge < 22 && mean > 85) visibility = 'fog';
    else if (std > 42 && edge > 38) visibility = 'good';
  }
  const snowFrac = groundN ? snow / groundN : null;
  return {
    ts: Date.now(),
    night,
    dusk: night && sunEl >= -6 && sunEl < 3,
    visibility: night ? 'night' : visibility,
    // v mlze je "bílá" i mlha – podíl sněhu pak nehodnotíme
    snow: night || visibility === 'fog' ? null : snowFrac,
    blueSky: skyN ? skyBlue / skyN : 0,
    mean, std, edge,
  };
}

export function describe(a) {
  if (!a) return 'zatím nevyhodnoceno';
  if (a.error) return 'snímek není k dispozici';
  if (a.dusk) return 'soumrak – snímek nehodnotím';
  if (a.night) return 'tma – noční záběr';
  const parts = [];
  parts.push({ good: 'dobrá viditelnost', reduced: 'snížená viditelnost', fog: 'mlha / v oblacích' }[a.visibility]);
  if (a.snow != null) {
    parts.push(a.snow >= 0.35 ? `sníh (~${Math.round(a.snow * 100)} % záběru)`
      : a.snow >= 0.1 ? `místy sníh (~${Math.round(a.snow * 100)} %)` : 'bez sněhu');
  }
  if (a.blueSky > 0.25) parts.push('modrá obloha');
  return parts.join(' · ');
}

export function statusClass(a) {
  if (!a || a.error) return 'cam-unknown';
  if (a.night) return 'cam-night';
  if (a.visibility === 'fog') return 'cam-fog';
  if (a.snow != null && a.snow >= 0.35) return 'cam-snow';
  return 'cam-ok';
}
