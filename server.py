"""Skialp CZ/SK – lokální server.

Servíruje webovou aplikaci (složka static/) a pro ni stahuje, ukládá do cache
a průběžně obnovuje data z veřejných zdrojů:

  * předpověď počasí pro skialpové oblasti a mřížku nad ČR+SR (Open-Meteo)
  * lavinové předpovědi HS ČR a HZS SR (EAWS, formát CAAML)
  * měření horských stanic ČHMÚ a SHMÚ
  * skialpové trasy z OpenStreetMap (Overpass API)
  * obrázky webkamer a výškový model pro výpočet sklonu svahů

Spuštění:  python server.py            (otevře http://127.0.0.1:8765)
           python server.py --lan      (přístup i z mobilu ve stejné Wi-Fi)
Bez externích knihoven – stačí Python 3.9+.
"""
import argparse
import datetime as dt
import gzip
import hashlib
import json
import mimetypes
import re
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = STATIC / "data"
CACHE = ROOT / "cache"
UA = "SkialpApp/1.0 (personal ski touring dashboard)"
MAPY_KEY_FILE = ROOT / "mapy_key.txt"  # klíč k API Mapy.com – jen lokálně, necommituje se


def mapy_api_key():
    """Klíč k API Mapy.com z proměnné prostředí MAPY_API_KEY nebo ze souboru mapy_key.txt."""
    import os
    key = os.environ.get("MAPY_API_KEY", "").strip()
    if not key and MAPY_KEY_FILE.exists():
        key = MAPY_KEY_FILE.read_text(encoding="utf-8").strip()
    return key if re.fullmatch(r"[A-Za-z0-9_\-]{10,200}", key or "") else ""


def config_js_with_key(text):
    """Doplní klíč do static/js/config.js (v repozitáři je prázdný)."""
    key = mapy_api_key()
    return text.replace("export const MAPY_API_KEY = '';", f"export const MAPY_API_KEY = '{key}';") if key else text

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Europe/Prague")
except Exception:  # noqa: BLE001 - Windows bez tzdata
    TZ = None


def now_local():
    if TZ:
        return dt.datetime.now(TZ)
    # Záložní výpočet středoevropského času (letní čas: poslední neděle března–října)
    utc = dt.datetime.now(dt.timezone.utc)
    y = utc.year
    last_sun = lambda m: max(d for d in range(25, 32) if dt.date(y, m, d).weekday() == 6)  # noqa: E731
    start = dt.datetime(y, 3, last_sun(3), 1, tzinfo=dt.timezone.utc)
    end = dt.datetime(y, 10, last_sun(10), 1, tzinfo=dt.timezone.utc)
    off = 2 if start <= utc < end else 1
    return utc.astimezone(dt.timezone(dt.timedelta(hours=off)))


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# --------------------------------------------------------------------------
# HTTP klient a cache
# --------------------------------------------------------------------------

def http_get(url, timeout=40, data=None, headers=None):
    h = {"User-Agent": UA, "Accept-Encoding": "gzip"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        return body, r.headers.get("Content-Type", "")


def http_json(url, **kw):
    body, _ = http_get(url, **kw)
    return json.loads(body.decode("utf-8"))


class Cache:
    """Paměťová cache s dobou platnosti; vybrané klíče se ukládají i na disk."""

    def __init__(self):
        self.items = {}
        self.locks = {}
        self.glock = threading.Lock()
        CACHE.mkdir(exist_ok=True)

    def _lock(self, key):
        with self.glock:
            return self.locks.setdefault(key, threading.Lock())

    def get(self, key, ttl, producer, disk=False):
        """Vrátí (hodnota, čas_aktualizace). Při chybě vrátí poslední známá data."""
        it = self.items.get(key)
        if it and time.time() - it[1] < ttl:
            return it
        with self._lock(key):
            it = self.items.get(key)
            if it and time.time() - it[1] < ttl:
                return it
            path = CACHE / (re.sub(r"[^\w.-]", "_", key) + ".json")
            if not it and disk and path.exists():
                try:
                    stored = json.loads(path.read_text(encoding="utf-8"))
                    it = (stored["value"], stored["ts"])
                    self.items[key] = it
                    if time.time() - it[1] < ttl:
                        return it
                except Exception:  # noqa: BLE001
                    pass
            try:
                value = producer()
                it = (value, time.time())
                self.items[key] = it
                if disk:
                    path.write_text(json.dumps({"ts": it[1], "value": value}, ensure_ascii=False), encoding="utf-8")
                return it
            except Exception as e:  # noqa: BLE001
                log(f"! {key}: {e}")
                if it:
                    return it
                raise

    def peek_ts(self, key):
        it = self.items.get(key)
        return it[1] if it else None


cache = Cache()

AREAS = json.loads((DATA / "areas.json").read_text(encoding="utf-8"))


def load_webcams():
    p = DATA / "webcams.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else []


WEBCAMS = load_webcams()

# --------------------------------------------------------------------------
# Počasí – Open-Meteo
# --------------------------------------------------------------------------

OM = "https://api.open-meteo.com/v1/forecast"
OM_HIST = "https://historical-forecast-api.open-meteo.com/v1/forecast"


def om_period(date, before, after):
    """Parametry období: aktuální předpověď, nebo archiv kolem zvoleného data (režim historie)."""
    if not date:
        return OM, {"past_days": before, "forecast_days": after + 1}
    d = dt.date.fromisoformat(date)
    return OM_HIST, {"start_date": (d - dt.timedelta(days=before)).isoformat(),
                     "end_date": (d + dt.timedelta(days=after)).isoformat()}
AREA_VARS = ("temperature_2m,precipitation,snowfall,rain,snow_depth,wind_speed_10m,wind_gusts_10m,"
             "wind_direction_10m,cloud_cover,visibility,freezing_level_height,weather_code")
GRID_VARS = "temperature_2m,precipitation,snowfall,snow_depth,wind_gusts_10m"
GRID_BBOX = (47.70, 51.10, 12.00, 22.60)  # lat_min, lat_max, lon_min, lon_max
GRID_DLAT, GRID_DLON = 0.25, 0.35  # ~465 bodů – drží se v denním limitu Open-Meteo


def om_multi(lats, lons, params, elevs=None, chunk=60, base=OM):
    out = []
    for i in range(0, len(lats), chunk):
        q = dict(params)
        q["latitude"] = ",".join(f"{x:.4f}" for x in lats[i:i + chunk])
        q["longitude"] = ",".join(f"{x:.4f}" for x in lons[i:i + chunk])
        if elevs:
            q["elevation"] = ",".join(str(int(e)) for e in elevs[i:i + chunk])
        res = http_json(base + "?" + urllib.parse.urlencode(q), timeout=90)
        out.extend(res if isinstance(res, list) else [res])
    return out


def produce_forecast(date=None):
    base, period = om_period(date, 3, 3)
    res = om_multi(
        [a["lat"] for a in AREAS], [a["lon"] for a in AREAS],
        {"hourly": AREA_VARS, "timezone": "Europe/Prague", "wind_speed_unit": "kmh", **period},
        elevs=[a["elev"] for a in AREAS], base=base,
    )
    out = {}
    for a, r in zip(AREAS, res):
        out[a["id"]] = {"elevation": r.get("elevation"), "hourly": r["hourly"]}
    return {"areas": out}


def grid_points():
    lat0, lat1, lon0, lon1 = GRID_BBOX
    nlat = int(round((lat1 - lat0) / GRID_DLAT)) + 1
    nlon = int(round((lon1 - lon0) / GRID_DLON)) + 1
    lats = [lat0 + i * GRID_DLAT for i in range(nlat)]
    lons = [lon0 + j * GRID_DLON for j in range(nlon)]
    return lats, lons


def produce_grid(date=None):
    lats, lons = grid_points()
    plat = [la for la in lats for _ in lons]
    plon = [lo for _ in lats for lo in lons]
    base, period = om_period(date, 1, 2)
    res = om_multi(plat, plon, {"hourly": GRID_VARS, "timezone": "Europe/Prague", "wind_speed_unit": "kmh",
                                **period}, chunk=100, base=base)
    times = res[0]["hourly"]["time"]
    fields = {}
    for v in GRID_VARS.split(","):
        # fields[v][t] = řádkově uložená mřížka (lat od jihu, lon od západu)
        fields[v] = [[(r["hourly"][v][t] if r["hourly"][v][t] is not None else None) for r in res]
                     for t in range(len(times))]
    elev = [r.get("elevation") for r in res]
    return {"lats": lats, "lons": lons, "times": times, "fields": fields, "elevation": elev}


# --------------------------------------------------------------------------
# Lavinové předpovědi – EAWS / CAAML (HS ČR, HZS SR)
# --------------------------------------------------------------------------

EAWS = "https://static.avalanche.report/eaws_bulletins"
LEVELS = {"low": 1, "moderate": 2, "considerable": 3, "high": 4, "very_high": 5, "no_rating": 0, "no_snow": 0}


def fetch_bulletins(day):
    out = []
    for cc in ("CZ", "SK"):
        try:
            data = http_json(f"{EAWS}/{day}/{day}-{cc}.json", timeout=30)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                continue
            raise
        for b in data.get("bulletins", []):
            b["_country"] = cc
            b["_day"] = day
            out.append(b)
    return out


def produce_avalanche(date=None):
    today = dt.date.fromisoformat(date) if date else now_local().date()
    days = [today, today + dt.timedelta(days=1)]
    result = {"days": {}}
    for d in days:
        ds = d.isoformat()
        bulletins = fetch_bulletins(ds)
        ratings = {}
        for b in bulletins:
            lvl = max([LEVELS.get(r.get("mainValue"), 0) for r in b.get("dangerRatings", [])] or [0])
            for reg in b.get("regions", []):
                rid = reg.get("regionID")
                ratings[rid] = max(ratings.get(rid, 0), lvl)
        result["days"][ds] = {"bulletins": bulletins, "ratings": ratings}
    # Poslední vydaná předpověď (mimo sezónu pro informaci, kdy naposledy vyšla)
    if not date and not any(v["bulletins"] for v in result["days"].values()):
        result["lastPublished"] = cache.get("avalanche-last", 24 * 3600, find_last_bulletin_day, disk=True)[0]
    return result


def _has_czsk_rating(day):
    try:
        r = http_json(f"{EAWS}/{day.isoformat()}/{day.isoformat()}.ratings.json", timeout=20)
    except Exception:  # noqa: BLE001
        return False
    return any(k.startswith(("CZ-", "SK-")) and ":" not in k for k in r.get("maxDangerRatings", {}))


def find_last_bulletin_day():
    """Datum poslední vydané předpovědi pro CZ/SK (hrubě po týdnech, pak po dnech)."""
    d = now_local().date()
    for week in range(1, 40):
        probe = d - dt.timedelta(days=7 * week)
        if _has_czsk_rating(probe):
            last = probe
            for i in range(1, 7):
                if _has_czsk_rating(probe + dt.timedelta(days=i)):
                    last = probe + dt.timedelta(days=i)
            return last.isoformat()
    return None


# --------------------------------------------------------------------------
# Měření horských stanic (ČHMÚ, SHMÚ)
# --------------------------------------------------------------------------

CHMI_STATIONS = {
    "0-20000-0-11653": ("Sněžka", 50.735833, 15.740278, 1602),
    "0-203-0-11633": ("Luční bouda", 50.735318, 15.697859, 1413),
    "0-203-0-11640": ("Labská bouda", 50.769883, 15.544927, 1320),
    "0-203-0-10102002001": ("Richtrovy boudy", 50.712041, 15.692463, 1222),
    "0-203-0-10102004001": ("Černá hora", 50.653113, 15.741325, 1297),
    "0-203-0-10501021001": ("Dvoračky", 50.748172, 15.514525, 1115),
    "0-203-0-10201053001": ("Velká Deštná", 50.3031217, 16.3964594, 1105),
    "0-203-0-41001001001": ("Dolní Morava, Slaměnka", 50.150637, 16.832543, 1105),
    "0-203-0-11735": ("Praděd", 50.0829406, 17.2298264, 1490),
    "0-203-0-20201004002": ("Malý Děd", 50.1025847, 17.2207511, 1367),
    "0-203-0-20202012001": ("Jelení studánka", 50.0317225, 17.2007144, 1238),
    "0-20000-0-11730": ("Šerák", 50.1875, 17.108333, 1328),
    "0-20000-0-11787": ("Lysá hora", 49.546111, 18.4475, 1322),
    "0-20000-0-11457": ("Churáňov", 49.068333, 13.615278, 1118),
    "0-203-0-10801024001": ("Zlatý stoleček", 49.104444, 13.336389, 1197),
    "0-203-0-10601022001": ("Větřín", 48.978611, 13.836944, 1157),
    "0-203-0-11420": ("Klínovec", 50.3948, 12.967957, 1236),
}
SHMU_STATIONS = {
    11930: ("Lomnický štít", 49.1953, 20.2153, 2635),
    11916: ("Chopok", 48.9439, 19.5925, 2005),
}


def _chmi_station(wsi):
    for back in (0, 1):
        day = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=back)).strftime("%Y%m%d")
        url = f"https://opendata.chmi.cz/meteorology/climate/now/data/10m-{wsi}-{day}.json"
        try:
            j = http_json(url, timeout=30)
        except urllib.error.HTTPError:
            continue
        vals = j["data"]["data"]["values"]
        latest, series = {}, {}
        for _st, el, t, v, *_ in vals:
            try:
                v = float(v)  # občas přijde hodnota jako text nebo prázdná
            except (TypeError, ValueError):
                continue
            series.setdefault(el, []).append((t, v))
        for el, s in series.items():
            s.sort()
            latest[el] = s[-1]
        if not latest:
            continue
        t_last = max(t for t, _ in latest.values())
        precip_1h = None
        if "SRA10M" in series:
            cutoff = (dt.datetime.fromisoformat(t_last.replace("Z", "+00:00")) - dt.timedelta(hours=1))
            precip_1h = round(sum(v for t, v in series["SRA10M"]
                                  if dt.datetime.fromisoformat(t.replace("Z", "+00:00")) > cutoff), 1)
        g = lambda k: latest[k][1] if k in latest else None  # noqa: E731
        return {"time": t_last, "t": g("T"), "wind": g("F"), "gust": g("Fmax"), "dir": g("D"),
                "rh": g("H"), "precip1h": precip_1h, "snow": None}
    return None


def produce_stations():
    out = []
    with ThreadPoolExecutor(6) as ex:
        res = list(ex.map(lambda w: (w, _safe(_chmi_station, w)), CHMI_STATIONS))
    for wsi, m in res:
        name, lat, lon, el = CHMI_STATIONS[wsi]
        if m:
            out.append({"id": wsi, "name": name, "lat": lat, "lon": lon, "elev": el, "source": "ČHMÚ", **m})
    try:
        out.extend(_shmu())
    except Exception as e:  # noqa: BLE001
        log("! SHMÚ:", e)
    return out


def _shmu():
    base = "https://opendata.shmu.sk/meteorology/climate/now/data/"
    body, _ = http_get(base, timeout=30)
    days = re.findall(r'href="(\d{8})/"', body.decode("utf-8", "replace"))
    if not days:
        return []
    day = sorted(days)[-1]
    body, _ = http_get(base + day + "/", timeout=30)
    files = re.findall(r'href="(aws1min[^"]+\.json)"', body.decode("utf-8", "replace"))
    if not files:
        return []
    data = http_json(base + day + "/" + sorted(files)[-1], timeout=60)
    last = {}
    for r in data.get("data", []):
        if r.get("ind_kli") in SHMU_STATIONS:
            last[r["ind_kli"]] = r
    out = []
    for k, r in last.items():
        name, lat, lon, el = SHMU_STATIONS[k]
        snow = r.get("sneh_pokr")
        out.append({
            "id": f"shmu-{k}", "name": name, "lat": lat, "lon": lon, "elev": el, "source": "SHMÚ",
            "time": r["minuta"] + "Z", "t": r.get("t"), "wind": r.get("vie_pr_rych"), "gust": r.get("vie_max_rych"),
            "dir": r.get("vie_pr_smer"), "rh": r.get("vlh_rel"), "precip1h": None,
            "snow": snow if snow is not None and 0 <= snow < 600 else None,
        })
    return out


def _safe(fn, *a):
    try:
        return fn(*a)
    except Exception as e:  # noqa: BLE001
        log(f"! {fn.__name__}{a}: {e}")
        return None


# --------------------------------------------------------------------------
# Skialpové trasy z OpenStreetMap
# --------------------------------------------------------------------------

OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
            "https://overpass.kumi.systems/api/interpreter"]
ROUTES_FALLBACK = DATA / "routes_fallback.json"  # snímek tras pro případ, že Overpass nejde


def produce_routes():
    q = ('[out:json][timeout:120];'
         '(way["piste:type"="skitour"](47.7,12.0,51.1,22.6);'
         'relation["piste:type"="skitour"](47.7,12.0,51.1,22.6););out geom;')
    data = None
    for url in OVERPASS:
        try:
            body, _ = http_get(url, timeout=60, data=urllib.parse.urlencode({"data": q}).encode())
            data = json.loads(body.decode("utf-8"))
            break
        except Exception as e:  # noqa: BLE001
            log("! Overpass", url, e)
    if data is None:
        raise RuntimeError("Overpass nedostupný")
    if len(data.get("elements", [])) < 50:
        raise RuntimeError(f"Overpass vrátil podezřele málo tras ({len(data.get('elements', []))})")
    feats = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        lines = []
        if el["type"] == "way" and el.get("geometry"):
            lines.append([[round(p["lon"], 5), round(p["lat"], 5)] for p in el["geometry"]])
        elif el["type"] == "relation":
            for m in el.get("members", []):
                if m.get("type") == "way" and m.get("geometry"):
                    lines.append([[round(p["lon"], 5), round(p["lat"], 5)] for p in m["geometry"]])
        if not lines:
            continue
        feats.append({
            "type": "Feature",
            "geometry": {"type": "MultiLineString", "coordinates": lines},
            "properties": {
                "osm": f"{el['type']}/{el['id']}",
                "name": tags.get("name") or tags.get("piste:name") or "",
                "difficulty": tags.get("piste:difficulty", ""),
                "grooming": tags.get("piste:grooming", ""),
                "description": tags.get("description", ""),
                "ref": tags.get("ref", ""),
            },
        })
    return {"type": "FeatureCollection", "features": feats}


def produce_routes_or_fallback():
    """Trasy z Overpass; když nejde, uložený snímek (zkusí se znovu při další obnově)."""
    try:
        return produce_routes()
    except Exception as e:  # noqa: BLE001
        if not ROUTES_FALLBACK.exists():
            raise
        log(f"! trasy: {e} – používám uložený snímek")
        return json.loads(ROUTES_FALLBACK.read_text(encoding="utf-8"))["data"]


# --------------------------------------------------------------------------
# Webkamery a výškový model (binární proxy s diskovou cache)
# --------------------------------------------------------------------------

BIN_CACHE = CACHE / "bin"
BIN_CACHE.mkdir(parents=True, exist_ok=True)
WEBCAM_IDS = {c["id"] for c in WEBCAMS}


def cached_binary(url, ttl, sub):
    key = hashlib.sha1(url.encode()).hexdigest()
    folder = BIN_CACHE / sub
    folder.mkdir(exist_ok=True)
    path = folder / key
    if path.exists() and (ttl is None or time.time() - path.stat().st_mtime < ttl):
        return path.read_bytes()
    try:
        body, ctype = http_get(url, timeout=30)
        if not ctype.startswith("image/"):
            raise ValueError(f"neočekávaný typ {ctype}")
        path.write_bytes(body)
        return body
    except Exception:
        if path.exists():
            return path.read_bytes()
        raise


def webcam_url(cam_id, full=False):
    last2 = cam_id[-2:]
    if full:
        t = dt.datetime.now(dt.timezone.utc)
        return [f"https://webcams.ventusky.com/data/{last2}/{cam_id}/hour/{(t - dt.timedelta(hours=h)).strftime('%Y%m%d_%H')}00.jpg"
                for h in (0, 1, 2)]
    # parametr v URL obchází CDN cache (bez něj se vrací i několik dní starý snímek)
    t = dt.datetime.now(dt.timezone.utc)
    stamp = t.strftime("%m%d%H") + f"{t.minute // 5 * 5:02d}"
    return [f"https://webcams.ventusky.com/data/{last2}/{cam_id}/latest_thumb.jpg?{stamp}"]


def get_webcam_image(cam_id, full):
    err = None
    for url in webcam_url(cam_id, full):
        try:
            return cached_binary(url, 600 if not full else 1800, "cam")
        except Exception as e:  # noqa: BLE001
            err = e
    raise err or RuntimeError("bez obrázku")


DEM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

# --------------------------------------------------------------------------
# Obnova na pozadí
# --------------------------------------------------------------------------

TTL = {
    "forecast": 30 * 60,
    "grid": 3 * 3600,
    "avalanche": 20 * 60,
    "stations": 10 * 60,
    "routes": 24 * 3600,
    "radar": 5 * 60,
}
PRODUCERS = {
    "forecast": (produce_forecast, True),
    "grid": (produce_grid, True),
    "avalanche": (produce_avalanche, True),
    "stations": (produce_stations, False),
    "routes": (produce_routes_or_fallback, True),
    "radar": (lambda: http_json("https://api.rainviewer.com/public/weather-maps.json"), False),
}


DATED = {"forecast", "grid", "avalanche"}  # zdroje, které umí režim historie


def get_data(name, force=False, date=None):
    fn, disk = PRODUCERS[name]
    if date and name in DATED:
        return cache.get(f"{name}@{date}", 7 * 86400, lambda: fn(date), disk=True)
    # ruční obnovení: data starší než 2 minuty se stáhnou znovu (trasy max. 1× za hodinu)
    ttl = (3600 if name == "routes" else 120) if force else TTL[name]
    return cache.get(name, ttl, fn, disk=disk)


def background_loop():
    while True:
        for name in PRODUCERS:
            try:
                get_data(name)
            except Exception as e:  # noqa: BLE001
                log(f"! obnova {name}: {e}")
        retry_tailscale(min_interval=55, quiet=True)
        time.sleep(60)


# --------------------------------------------------------------------------
# HTTP server
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "SkialpApp/1.0"

    def log_message(self, fmt, *args):  # tišší výpis
        if args and str(args[1]).startswith(("4", "5")):
            log("HTTP", self.address_string(), fmt % args)

    def send_bytes(self, body, ctype, status=200, cache_s=0):
        gz = "gzip" in self.headers.get("Accept-Encoding", "") and (
            ctype.startswith(("application/json", "text/", "application/javascript")) and len(body) > 1024)
        if gz:
            body = gzip.compress(body, 5)
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Cache-Control", f"max-age={cache_s}" if cache_s else "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, status=200):
        self.send_bytes(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
                        "application/json; charset=utf-8", status)

    def do_GET(self):  # noqa: N802
        try:
            self.route()
        except BrokenPipeError:
            pass
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            try:
                self.send_json({"error": str(e)}, 502)
            except Exception:  # noqa: BLE001
                pass

    def route(self):
        u = urllib.parse.urlparse(self.path)
        p, qs = u.path, urllib.parse.parse_qs(u.query)

        if p.startswith("/api/data/"):
            name = p.rsplit("/", 1)[-1]
            if name not in PRODUCERS:
                return self.send_json({"error": "neznámý zdroj"}, 404)
            date = qs.get("date", [""])[0]
            if date and not (re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) and "2022-01-01" <= date < now_local().date().isoformat()):
                return self.send_json({"error": "neplatné datum (YYYY-MM-DD, v minulosti od 2022)"}, 400)
            value, ts = get_data(name, force=qs.get("force", ["0"])[0] == "1", date=date or None)
            return self.send_json({"updated": ts, "data": value})

        if p == "/api/meta":
            return self.send_json({
                "areas": AREAS, "webcams": WEBCAMS, "serverTime": time.time(),
                "updated": {k: cache.peek_ts(k) for k in PRODUCERS},
                "access": ACCESS,
            })

        if p == "/api/access":  # adresy pro telefon; případně znovu zkusí nastavit Tailscale
            retry_tailscale(min_interval=5, quiet=True)
            return self.send_json({"access": ACCESS, "tailscale": {k: TS[k] for k in ("wanted", "error", "note")}})

        if p == "/api/webcam":
            cam = qs.get("id", [""])[0]
            if cam not in WEBCAM_IDS:
                return self.send_json({"error": "neznámá kamera"}, 404)
            body = get_webcam_image(cam, qs.get("full", ["0"])[0] == "1")
            return self.send_bytes(body, "image/jpeg", cache_s=120)

        m = re.fullmatch(r"/tiles/dem/(\d+)/(\d+)/(\d+)\.png", p)
        if m:
            z, x, y = map(int, m.groups())
            if not (0 <= z <= 15 and 0 <= x < 2 ** z and 0 <= y < 2 ** z):
                return self.send_json({"error": "mimo rozsah"}, 404)
            body = cached_binary(DEM_URL.format(z=z, x=x, y=y), None, "dem")
            return self.send_bytes(body, "image/png", cache_s=30 * 86400)

        if p == "/favicon.ico":  # ikona je přímo v index.html
            self.send_response(204)
            self.end_headers()
            return None

        if p == "/js/config.js":
            text = config_js_with_key((STATIC / "js" / "config.js").read_text(encoding="utf-8"))
            return self.send_bytes(text.encode("utf-8"), "application/javascript; charset=utf-8")

        # statické soubory
        if p in ("", "/"):
            p = "/index.html"
        f = (STATIC / urllib.parse.unquote(p).lstrip("/")).resolve()
        if STATIC.resolve() not in f.parents or not f.is_file():
            return self.send_json({"error": "nenalezeno"}, 404)
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        if f.suffix == ".geojson":
            ctype = "application/json; charset=utf-8"
        self.send_bytes(f.read_bytes(), ctype, cache_s=0)


ACCESS = {"local": None, "lan": None, "tailscale": None}  # adresy aplikace (pro QR kód v aplikaci)
# Stav Tailscale: zda je požadovaný (--tailscale), proč zatím nejde a kdy se naposledy zkoušel
TS = {"wanted": False, "error": None, "note": None, "tried": 0.0, "port": None, "host": None}
TS_LOCK = threading.Lock()


def retry_tailscale(min_interval=10, quiet=False):
    """Když Tailscale při startu nešel (např. nebyl přihlášený), zkusí ho nastavit znovu."""
    if not TS["wanted"] or ACCESS["tailscale"] or time.time() - TS["tried"] < min_interval:
        return
    if not TS_LOCK.acquire(blocking=False):
        return
    try:
        TS["tried"] = time.time()
        host, url, note = setup_tailscale(TS["port"], serve_timeout=12)
        if host != TS["host"] and TS["host"] == "127.0.0.1":
            # HTTPS (tailscale serve) nejde a přímá IP by vyžadovala restart serveru
            TS["error"], TS["note"] = "Tailscale běží, ale HTTPS adresa není povolená.", note
            return
        ACCESS["tailscale"], TS["error"], TS["note"] = url, None, note or None
        log(f"Tailscale je připravený – na telefonu otevři:  {url}")
    except RuntimeError as e:
        TS["error"] = str(e)
        if not quiet:
            log("Tailscale: " + str(e))
    finally:
        TS_LOCK.release()


def find_tailscale():
    import shutil
    exe = shutil.which("tailscale")
    if exe:
        return exe
    for p in (r"C:\Program Files\Tailscale\tailscale.exe", r"C:\Program Files (x86)\Tailscale\tailscale.exe",
              "/Applications/Tailscale.app/Contents/MacOS/Tailscale"):
        if Path(p).exists():
            return p
    return None


def _out(x):
    return (x.decode("utf-8", "replace") if isinstance(x, bytes) else x) or ""


def setup_tailscale(port, serve_timeout=25):
    """Zpřístupní aplikaci v síti Tailscale (jen pro zařízení přihlášená k tvému účtu).

    Nejdřív zkusí `tailscale serve` – HTTPS adresa https://<počítač>.<síť>.ts.net/, server přitom
    dál poslouchá jen lokálně. Když to nejde (HTTPS v síti není povolené), použije přímo IP adresu
    Tailscale (http://100.x.y.z:port/). Vrací (adresa_pro_bind, url, poznámka).
    """
    import subprocess
    exe = find_tailscale()
    if not exe:
        raise RuntimeError("Tailscale není nainstalovaný – stáhni ho z https://tailscale.com/download "
                           "(do počítače i telefonu) a přihlas se v obou stejným účtem.")
    try:
        st = json.loads(subprocess.run([exe, "status", "--json"], capture_output=True, text=True,
                                       timeout=15).stdout or "{}")
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"nepodařilo se zjistit stav Tailscale ({e})") from e
    state = st.get("BackendState")
    if state == "NeedsMachineAuth":
        raise RuntimeError("Tailscale čeká na schválení počítače – schval ho na https://login.tailscale.com/admin/machines.")
    if state != "Running":
        raise RuntimeError("Tailscale na tomto počítači není přihlášený nebo je vypnutý – klikni na ikonu "
                           "Tailscale vedle hodin (případně pod šipkou ^), zvol „Log in“ a potvrď v prohlížeči.")
    me = st.get("Self") or {}
    dns = (me.get("DNSName") or "").rstrip(".")
    ips = [ip for ip in me.get("TailscaleIPs") or [] if "." in ip]

    note = ""
    if dns:
        try:
            r = subprocess.run([exe, "serve", "--bg", str(port)], capture_output=True, text=True,
                               timeout=serve_timeout)
            if r.returncode == 0:
                return "127.0.0.1", f"https://{dns}/", ""
            note = _out(r.stdout) + _out(r.stderr)
        except subprocess.TimeoutExpired as e:  # čeká na povolení HTTPS v administraci Tailscale
            note = _out(e.stdout) + _out(e.stderr)
    if not ips:
        raise RuntimeError("Tailscale nemá přidělenou IP adresu.")
    link = re.search(r"https://login\.tailscale\.com/\S+", note)
    note = ("Pro HTTPS adresu (doporučeno) povol v Tailscale funkci Serve/HTTPS: "
            + (link.group(0) if link else "https://login.tailscale.com/admin/dns → HTTPS Certificates")
            + " a spusť znovu.")
    return "0.0.0.0", f"http://{ips[0]}:{port}/", note


def lan_ip():
    """IP adresa počítače v místní síti (UDP 'spojení' nic neodesílá, jen vybere rozhraní)."""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "<IP-tohoto-počítače>"
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser(description="Skialp CZ/SK – lokální server")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--lan", action="store_true", help="naslouchat i v místní síti (mobil)")
    ap.add_argument("--tailscale", action="store_true", help="zpřístupnit přes Tailscale (mobil i mimo domov)")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("application/manifest+json", ".webmanifest")
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    url = f"http://127.0.0.1:{args.port}/"
    ACCESS["local"] = url
    if args.lan:
        ACCESS["lan"] = f"http://{lan_ip()}:{args.port}/"
    if args.tailscale:
        TS.update(wanted=True, port=args.port, tried=time.time())
        try:
            ts_host, ACCESS["tailscale"], note = setup_tailscale(args.port)
            if ts_host == "0.0.0.0":
                host = ts_host
            if note:
                log("Tailscale: " + note)
                TS["note"] = note
        except RuntimeError as e:
            TS["error"] = str(e)
            log("Tailscale: " + str(e))
            log("Aplikace zatím poběží jen na tomto počítači. Po přihlášení k Tailscale stačí v aplikaci")
            log("kliknout na tlačítko 📱 (nebo počkat minutu) – restart není potřeba.")
        TS["host"] = host

    def print_access():
        if ACCESS["tailscale"]:
            log(f"Na telefonu (Tailscale – doma i venku) otevři:  {ACCESS['tailscale']}")
            log("   (nebo v aplikaci klikni na tlačítko „Mobil“ a naskenuj QR kód)")
        if ACCESS["lan"]:
            log(f"Na telefonu (stejná Wi-Fi) otevři:  {ACCESS['lan']}")

    # Na Windows by SO_REUSEADDR dovolil dvěma serverům sdílet port – chceme jasnou chybu.
    ThreadingHTTPServer.allow_reuse_address = sys.platform != "win32"
    try:
        srv = ThreadingHTTPServer((host, args.port), Handler)
    except OSError as e:
        log(f"Port {args.port} je obsazený ({e.strerror or e}).")
        log("Aplikace už nejspíš běží v jiném okně – otevírám ji v prohlížeči.")
        log(f"Pokud ne, zavři ostatní okna serveru, nebo spusť s jiným portem: python server.py --port 8770")
        print_access()
        if not args.no_browser:
            webbrowser.open(url)
        return 1
    threading.Thread(target=background_loop, daemon=True).start()
    log(f"Skialp CZ/SK běží na {url}  (ukončení: Ctrl+C)")
    print_access()
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("Ukončuji…")


if __name__ == "__main__":
    sys.exit(main())
