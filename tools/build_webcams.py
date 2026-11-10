"""Sestaví seznam horských webkamer v okolí skialpových oblastí.

Projde veřejné stránky Ventusky (ventusky.com) – stránku místa pro každou
oblast a stránky jednotlivých kamer – a uloží název, polohu a zdroj kamery
do static/data/webcams.json. Stahuje pomalu (s pauzou), spouští se jen
občas, když chceš seznam kamer obnovit:

    python tools/build_webcams.py                 # všechny oblasti znovu
    python tools/build_webcams.py --country AT    # jen oblasti jedné země, ostatní kamery zůstanou
    python tools/build_webcams.py --missing       # jen oblasti, které zatím žádnou kameru nemají
"""
import argparse
import html
import json
import math
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AREAS = ROOT / "static" / "data" / "areas.json"
OUT = ROOT / "static" / "data" / "webcams.json"

UA = "SkialpApp/1.0 (personal use; webcam list builder)"
DELAY_S = 0.8
KEEP_RADIUS_KM = 14
EXPLORE_RADIUS_KM = 22
MAX_PER_AREA = 8      # u velkých středisek jsou desítky kamer – bereme jen nejbližší


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def dist_km(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = (math.sin((lat2 - lat1) * p / 2) ** 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2)
    return 12742 * math.asin(math.sqrt(a))


def nearest_area(areas, lat, lon):
    best = min(areas, key=lambda a: dist_km(a["lat"], a["lon"], lat, lon))
    return best, dist_km(best["lat"], best["lon"], lat, lon)


def parse_cam(cam_id, page):
    title = re.search(r"<title>\s*Webcams?\s*-\s*(.*?)\s*\|\s*Ventusky\s*</title>", page, re.S)
    coords = re.search(r'ventusky\.com/(-?\d+\.\d+);(-?\d+\.\d+)"\s+dest="panel"', page)
    if not title or not coords:
        return None
    provider = re.search(r"Provided by\s*</td>\s*<td>\s*<a href=\"([^\"]+)\"[^>]*>([^<]+)</a>", page, re.S)
    fresh = re.search(r'quality-text-(\d)">[^<]*</span>\s*([^<]+?)\s*<', page)
    nearby = [n for n in dict.fromkeys(re.findall(r"ventusky\.com/webcam-(\d+)(?![\d/])", page)) if n != cam_id]
    return {
        "id": cam_id,
        "name": html.unescape(title.group(1)).strip(),
        "lat": float(coords.group(1)),
        "lon": float(coords.group(2)),
        "provider": html.unescape(provider.group(2)).strip() if provider else "",
        "providerUrl": html.unescape(provider.group(1)) if provider else "",
        "quality": int(fresh.group(1)) if fresh else None,
        "freshness": fresh.group(2).strip() if fresh else "",
        "nearby": nearby,
    }


def is_stale(cam):
    f = cam.get("freshness", "").lower()
    return any(w in f for w in ("day", "week", "month", "year"))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--country", help="projít jen oblasti této země (např. AT); ostatní kamery zůstanou")
    ap.add_argument("--missing", action="store_true", help="projít jen oblasti bez kamer")
    ap.add_argument("--max-pages", type=int, help="nejvyšší počet prohlédnutých stránek kamer")
    args = ap.parse_args()

    areas = json.loads(AREAS.read_text(encoding="utf-8"))
    existing = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else []
    todo = areas
    if args.country:
        todo = [a for a in todo if a["country"] == args.country.upper()]
    if args.missing:
        have = {c["area"] for c in existing}
        todo = [a for a in todo if a["id"] not in have]
    if not todo:
        print("Žádná oblast k projití.")
        return 0
    todo_ids = {a["id"] for a in todo}
    max_pages = args.max_pages or 60 + 7 * len(todo)
    queue, seen, cams = [], set(), {}

    for a in todo:
        url = f"https://www.ventusky.com/{a['lat']:.3f};{a['lon']:.3f}"
        try:
            page = fetch(url)
        except Exception as e:  # noqa: BLE001
            print(f"  ! {a['id']}: {e}")
            continue
        ids = list(dict.fromkeys(re.findall(r"webcam-(\d+)(?![\d/])", page)))
        print(f"{a['id']}: {len(ids)} kamer v okolí", flush=True)
        for i in ids:
            if i not in seen:
                seen.add(i)
                queue.append(i)
        time.sleep(DELAY_S)

    fetched = 0
    while queue and fetched < max_pages:
        cam_id = queue.pop(0)
        try:
            cam = parse_cam(cam_id, fetch(f"https://www.ventusky.com/webcam-{cam_id}"))
        except Exception as e:  # noqa: BLE001
            print(f"  ! kamera {cam_id}: {e}")
            cam = None
        fetched += 1
        time.sleep(DELAY_S)
        if not cam:
            continue
        # kamera patří k nejbližší oblasti ze všech – ne jen z těch právě procházených
        area, d = nearest_area(areas, cam["lat"], cam["lon"])
        cam["area"], cam["distKm"] = area["id"], round(d, 1)
        cams[cam_id] = cam
        print(f"  {cam['name']} ({d:.1f} km od {area['id']}) {cam['freshness']}", flush=True)
        if d <= EXPLORE_RADIUS_KM and area["id"] in todo_ids:
            for n in cam["nearby"]:
                if n not in seen:
                    seen.add(n)
                    queue.append(n)

    found = sorted(
        ({k: v for k, v in c.items() if k not in ("nearby", "quality")}
         for c in cams.values()
         if c["area"] in todo_ids and c["distKm"] <= KEEP_RADIUS_KM and not is_stale(c)),
        key=lambda c: (c["area"], c["distKm"]))
    per_area = {}
    for c in found:
        per_area.setdefault(c["area"], [])
        if len(per_area[c["area"]]) < MAX_PER_AREA:
            per_area[c["area"]].append(c)

    # kamery oblastí, které jsme neprocházeli, zůstávají beze změny
    order = {a["id"]: i for i, a in enumerate(areas)}
    keep = [c for c in existing if c["area"] not in todo_ids and c["area"] in order]
    keep += [c for cs in per_area.values() for c in cs]
    keep.sort(key=lambda c: (order[c["area"]], c["distKm"]))
    OUT.write_text(json.dumps(keep, ensure_ascii=False, indent=1), encoding="utf-8")
    without = [a["id"] for a in todo if a["id"] not in per_area]
    print(f"\nNově {sum(len(v) for v in per_area.values())} kamer pro {len(per_area)} oblastí (prohledáno {fetched} stránek), "
          f"celkem {len(keep)} -> {OUT}")
    if without:
        print("Bez kamery: " + ", ".join(without))
    return 0


if __name__ == "__main__":
    sys.exit(main())
