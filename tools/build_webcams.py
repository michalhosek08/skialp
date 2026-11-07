"""Sestaví seznam horských webkamer v okolí skialpových oblastí.

Projde veřejné stránky Ventusky (ventusky.com) – stránku místa pro každou
oblast a stránky jednotlivých kamer – a uloží název, polohu a zdroj kamery
do static/data/webcams.json. Stahuje pomalu (s pauzou), spouští se jen
občas, když chceš seznam kamer obnovit:

    python tools/build_webcams.py
"""
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
MAX_CAM_PAGES = 170
KEEP_RADIUS_KM = 14
EXPLORE_RADIUS_KM = 22


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
    areas = json.loads(AREAS.read_text(encoding="utf-8"))
    queue, seen, cams = [], set(), {}

    for a in areas:
        url = f"https://www.ventusky.com/{a['lat']:.3f};{a['lon']:.3f}"
        try:
            page = fetch(url)
        except Exception as e:  # noqa: BLE001
            print(f"  ! {a['id']}: {e}")
            continue
        ids = list(dict.fromkeys(re.findall(r"webcam-(\d+)(?![\d/])", page)))
        print(f"{a['id']}: {len(ids)} kamer v okolí")
        for i in ids:
            if i not in seen:
                seen.add(i)
                queue.append(i)
        time.sleep(DELAY_S)

    fetched = 0
    while queue and fetched < MAX_CAM_PAGES:
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
        area, d = nearest_area(areas, cam["lat"], cam["lon"])
        cam["area"], cam["distKm"] = area["id"], round(d, 1)
        cams[cam_id] = cam
        print(f"  {cam['name']} ({d:.1f} km od {area['id']}) {cam['freshness']}")
        if d <= EXPLORE_RADIUS_KM:
            for n in cam["nearby"]:
                if n not in seen:
                    seen.add(n)
                    queue.append(n)

    keep = [
        {k: v for k, v in c.items() if k not in ("nearby", "quality")}
        for c in cams.values()
        if c["distKm"] <= KEEP_RADIUS_KM and not is_stale(c)
    ]
    keep.sort(key=lambda c: (c["area"], c["distKm"]))
    OUT.write_text(json.dumps(keep, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nUloženo {len(keep)} kamer (prohledáno {fetched}) -> {OUT}")


if __name__ == "__main__":
    sys.exit(main())
