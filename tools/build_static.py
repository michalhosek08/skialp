"""Sestaví statickou verzi aplikace pro GitHub Pages.

Stáhne aktuální data stejně jako server.py (předpověď, laviny, stanice, meteo mapa,
skialpové trasy), vyhodnotí snímky webkamer a vše uloží jako JSON soubory vedle
webové aplikace. Spouští ho GitHub Actions každých ~30 minut (.github/workflows/update.yml),
dá se pustit i ručně:

    python tools/build_static.py --out _site [--prev-url https://uzivatel.github.io/skialp/]

--prev-url = adresa již nasazené verze. Data, která se obnovují méně často (meteo mapa,
trasy), se z ní převezmou, dokud nezestárnou, a při výpadku zdroje se použije poslední
známý stav. Rozbor webkamer potřebuje knihovnu Pillow (pip install pillow); bez ní se přeskočí.
"""
import argparse
import io
import json
import math
import shutil
import sys
import time
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import server  # noqa: E402  – sdílíme stahování a zpracování dat se serverem

# zdroj: (funkce, jak dlouho lze převzít z předchozí verze [s]; 0 = stáhnout pokaždé)
SOURCES = {
    "forecast": (server.produce_forecast, 50 * 60),
    "avalanche": (server.produce_avalanche, 0),
    "stations": (server.produce_stations, 0),
    "grid": (server.produce_grid, 3 * 3600 - 600),
    "routes": (server.produce_routes, 24 * 3600 - 600),
}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def fetch_prev(prev_url, name):
    if not prev_url:
        return None
    try:
        return server.http_json(f"{prev_url.rstrip('/')}/api/{name}.json?v={int(time.time())}", timeout=30)
    except urllib.error.HTTPError as e:
        if e.code != 404:
            log(f"  předchozí {name}: HTTP {e.code}")
    except Exception as e:  # noqa: BLE001
        log(f"  předchozí {name}: {e}")
    return None


# --------------------------------------------------------------------------
# Rozbor webkamer (stejná logika jako static/js/webcam.js)
# --------------------------------------------------------------------------

def sun_elevation(lat, lon, t=None):
    rad = math.pi / 180
    d = (t or time.time()) / 86400 - 10957.5  # dny od J2000.0
    g = (357.529 + 0.98560028 * d) * rad
    q = 280.459 + 0.98564736 * d
    lam = (q + 1.915 * math.sin(g) + 0.02 * math.sin(2 * g)) * rad
    eps = (23.439 - 0.00000036 * d) * rad
    ra = math.atan2(math.cos(eps) * math.sin(lam), math.cos(lam))
    dec = math.asin(math.sin(eps) * math.sin(lam))
    gmst = (18.697374558 + 24.06570982441908 * d) % 24
    ha = (gmst * 15 + lon) * rad - ra
    return math.asin(math.sin(lat * rad) * math.sin(dec) + math.cos(lat * rad) * math.cos(dec) * math.cos(ha)) / rad


def analyze_image(data, sun_el):
    from PIL import Image
    im = Image.open(io.BytesIO(data)).convert("RGB")
    W = 160
    h = max(40, round(W * im.height / im.width))
    px = list(im.resize((W, h), Image.BILINEAR).getdata())
    L = [0.299 * r + 0.587 * g + 0.114 * b for r, g, b in px]
    y0, y1 = round(h * 0.06), round(h * 0.94)
    sky_end, ground_start = round(h * 0.33), round(h * 0.45)
    s = s2 = n = bright = sky_blue = sky_n = snow = ground_n = 0
    for y in range(y0, y1 + 1):
        for x in range(W):
            i = y * W + x
            r, g, b = px[i]
            l = L[i]
            s += l
            s2 += l * l
            n += 1
            mx, mn = max(r, g, b), min(r, g, b)
            sat = (mx - mn) / mx if mx else 0
            if l > 200:
                bright += 1
            if y < sky_end:
                sky_n += 1
                if b > r + 18 and b >= g and l > 80:
                    sky_blue += 1
            if y >= ground_start:
                ground_n += 1
                if l > 150 and sat < 0.2 and b >= r - 12:
                    snow += 1
    mean = s / n
    std = math.sqrt(max(0.0, s2 / n - mean * mean))
    edge = en = 0
    for y in range(max(1, y0), min(h - 1, y1)):
        for x in range(1, W - 1):
            k = y * W + x
            gx = -L[k - W - 1] - 2 * L[k - 1] - L[k + W - 1] + L[k - W + 1] + 2 * L[k + 1] + L[k + W + 1]
            gy = -L[k - W - 1] - 2 * L[k - W] - L[k - W + 1] + L[k + W - 1] + 2 * L[k + W] + L[k + W + 1]
            edge += math.sqrt(gx * gx + gy * gy)
            en += 1
    edge /= en
    night = sun_el < 3 or (mean < 42 and bright / n < 0.05)
    vis = "reduced"
    if not night:
        if std < 26 and edge < 22 and mean > 85:
            vis = "fog"
        elif std > 42 and edge > 38:
            vis = "good"
    return {
        "ts": int(time.time() * 1000),
        "night": night,
        "dusk": night and -6 <= sun_el < 3,
        "visibility": "night" if night else vis,
        "snow": None if night or vis == "fog" else (round(snow / ground_n, 3) if ground_n else None),
        "blueSky": round(sky_blue / sky_n, 3) if sky_n else 0,
    }


def build_cams():
    try:
        import PIL  # noqa: F401
    except ImportError:
        log("  Pillow není nainstalovaný – rozbor webkamer přeskakuji")
        return None

    def one(cam):
        try:
            body = server.get_webcam_image(cam["id"], False)
            return cam["id"], analyze_image(body, sun_elevation(cam["lat"], cam["lon"]))
        except Exception as e:  # noqa: BLE001
            return cam["id"], {"ts": int(time.time() * 1000), "error": True, "msg": str(e)[:80]}

    with ThreadPoolExecutor(8) as ex:
        res = dict(ex.map(one, server.WEBCAMS))
    ok = sum(1 for v in res.values() if not v.get("error"))
    log(f"  webkamery: vyhodnoceno {ok}/{len(res)}")
    return res


# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default="_site", help="výstupní složka")
    ap.add_argument("--prev-url", default="", help="adresa nasazené verze (převzetí dat)")
    args = ap.parse_args()

    out = Path(args.out).resolve()
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(server.STATIC, out)
    index = out / "index.html"
    index.write_text(index.read_text(encoding="utf-8").replace(
        "<!--SKIALP_STATIC-->", "<script>window.SKIALP_STATIC = true;</script>"), encoding="utf-8")
    # klíč k API Mapy.com z tajného úložiště GitHubu (proměnná MAPY_API_KEY) – v repozitáři není
    cfg = out / "js" / "config.js"
    cfg_text = cfg.read_text(encoding="utf-8")
    cfg.write_text(server.config_js_with_key(cfg_text), encoding="utf-8")
    log("Mapy.com: klíč " + ("doplněn" if server.mapy_api_key() else "není nastaven – trasy jen přes BRouter"))

    now = time.time()
    status = {}

    # datum poslední vydané lavinové předpovědi se dohledává pomalu – převezmeme ho
    prev_aval = fetch_prev(args.prev_url, "avalanche")
    if prev_aval and prev_aval["data"].get("lastPublished") and prev_aval["data"].get("lastCheck"):
        server.cache.items["avalanche-last"] = (prev_aval["data"]["lastPublished"], prev_aval["data"]["lastCheck"])

    for name, (producer, reuse_s) in SOURCES.items():
        prev = prev_aval if name == "avalanche" else fetch_prev(args.prev_url, name)
        sig = server.signature(name)
        # předchozí data jiného rozsahu (méně oblastí, menší mapa) nepřebíráme – jen jako nouzi při výpadku
        same = bool(prev) and prev.get("sig", "") == sig
        if not same and prev:
            log(f"{name}: předchozí data mají jiný rozsah – stahuji znovu")
            prev = {k: v for k, v in prev.items() if k != "retryAfter"}
        if same and prev.get("retryAfter", 0) > now:  # zdroj nedávno nešel – zkusí se později
            write_json(out / "api" / f"{name}.json", prev)
            status[name] = {"updated": prev.get("updated"), "reused": True}
            log(f"{name}: převzato (zdroj nedostupný, další pokus po {time.strftime('%H:%M', time.localtime(prev['retryAfter']))})")
            continue
        if same and reuse_s and now - prev.get("updated", 0) < reuse_s:
            write_json(out / "api" / f"{name}.json", prev)
            status[name] = {"updated": prev["updated"], "reused": True}
            log(f"{name}: převzato (stáří {int((now - prev['updated']) / 60)} min)")
            continue
        try:
            t0 = time.time()
            data = producer()
            if name == "avalanche" and "lastPublished" in data:
                data["lastCheck"] = server.cache.peek_ts("avalanche-last")
            write_json(out / "api" / f"{name}.json", {"updated": time.time(), "sig": sig, "data": data})
            status[name] = {"updated": time.time()}
            log(f"{name}: staženo ({time.time() - t0:.1f} s)")
        except Exception as e:  # noqa: BLE001
            status[name] = {"error": str(e)[:200]}
            if not same and name == "routes" and server.ROUTES_FALLBACK.exists():
                # uložený snímek tras v aktuálním rozsahu (má staré datum, časem se zkusí Overpass znovu)
                prev = {**json.loads(server.ROUTES_FALLBACK.read_text(encoding="utf-8")), "sig": sig}
            if prev:
                if reuse_s:  # méně časté zdroje (trasy, mapa) při výpadku zkusit znovu až později
                    prev = {**prev, "retryAfter": now + min(6 * 3600, reuse_s / 2)}
                write_json(out / "api" / f"{name}.json", prev)
                status[name].update(updated=prev.get("updated"), reused=True)
                log(f"{name}: CHYBA ({e}) – použita předchozí data")
            else:
                log(f"{name}: CHYBA ({e}) – data nejsou k dispozici")

    cams = build_cams()
    if cams is not None:
        write_json(out / "api" / "cams.json", {"updated": time.time(), "data": cams})
        status["cams"] = {"updated": time.time()}

    write_json(out / "api" / "meta.json", {"areas": server.AREAS, "webcams": server.WEBCAMS, "access": {},
                                           "serverTime": time.time()})
    write_json(out / "api" / "status.json", {"built": time.time(), "sources": status})

    if not (out / "api" / "forecast.json").exists():
        log("Předpověď není k dispozici – verzi nenasazuji (zůstane předchozí).")
        return 1
    log(f"Hotovo -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
