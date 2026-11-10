"""Sestaví mapu lavinových regionů (static/data/avalanche_regions.geojson).

Stáhne aktuálně platné mikroregiony EAWS pro Česko, Slovensko a rakouské spolkové
země z regions.avalanches.org (CC BY 4.0) a spojí je do jednoho souboru. Spouští se
jen občas – když lavinové služby změní hranice regionů (obvykle před sezónou):

    python tools/build_regions.py
"""
import datetime as dt
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "static" / "data" / "avalanche_regions.geojson"
BASE = "https://regions.avalanches.org"
UA = "SkialpApp/1.0 (personal use; avalanche regions builder)"

# skupina regionů = jeden soubor s předpověďmi (stát, v Rakousku spolková země)
GROUPS = ["CZ", "SK", "AT-02", "AT-03", "AT-04", "AT-05", "AT-06", "AT-07", "AT-08"]

# názvy, které ve zdroji nejsou česky/slovensky
NAMES = {
    "CZ-04": "Krkonoše", "CZ-06": "Jeseníky",
    "SK-01": "Vysoké Tatry – východ", "SK-02": "Vysoké Tatry – západ", "SK-03": "Západné Tatry",
    "SK-04": "Nízke Tatry – východ", "SK-05": "Nízke Tatry – západ", "SK-06": "Veľká Fatra",
    "SK-07": "Krivánska Malá Fatra", "SK-08": "Lúčanská Malá Fatra",
}


def fetch(path):
    req = urllib.request.Request(f"{BASE}/{path}", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def clean_ring(ring):
    """Zaokrouhlí na ~10 m a vyhodí opakované body (sdílené hranice zůstanou shodné)."""
    out = []
    for x, y, *_ in ring:
        p = [round(x, 4), round(y, 4)]
        if not out or out[-1] != p:
            out.append(p)
    if out[0] != out[-1]:
        out.append(out[0])
    return out if len(out) >= 4 else None


def clean_geometry(g):
    polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    res = []
    for poly in polys:
        rings = [r for r in (clean_ring(ring) for ring in poly) if r]
        if rings:
            res.append(rings)
    return {"type": "MultiPolygon", "coordinates": res} if res else None


def main():
    today = dt.date.today().isoformat()
    names_de = fetch("micro-regions_names/de.json")
    names_en = fetch("micro-regions_names/en.json")  # nové regiony bývají nejdřív jen anglicky
    feats = []
    for group in GROUPS:
        gj = fetch(f"micro-regions/{group}_micro-regions.geojson.json")
        n = 0
        for f in gj["features"]:
            p = f["properties"]
            # soubory obsahují i historické a budoucí regiony – bereme jen dnes platné
            if (p.get("start_date") or "0000") > today or (p.get("end_date") or "9999") <= today:
                continue
            geom = clean_geometry(f["geometry"])
            if not geom:
                continue
            rid = p["id"]
            feats.append({"type": "Feature", "geometry": geom, "properties": {
                "id": rid, "name": NAMES.get(rid) or names_de.get(rid) or names_en.get(rid) or rid,
                "country": group[:2], "group": group}})
            n += 1
        print(f"{group}: {n} regionů")
    out = {"type": "FeatureCollection", "built": today,
           "attribution": "EAWS regions (CC BY 4.0) – regions.avalanches.org", "features": feats}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    pts = sum(len(r) for f in feats for poly in f["geometry"]["coordinates"] for r in poly)
    print(f"Uloženo {len(feats)} regionů, {pts} bodů, {OUT.stat().st_size // 1024} kB -> {OUT}")


if __name__ == "__main__":
    sys.exit(main())
