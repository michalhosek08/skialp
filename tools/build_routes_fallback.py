"""Uloží aktuální skialpové trasy z OpenStreetMap jako záložní snímek.

Snímek (static/data/routes_fallback.json) se použije, když server Overpass
zrovna neodpovídá. Stačí ho obnovit občas, např. po rozšíření oblastí:

    python tools/build_routes_fallback.py
"""
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import server  # noqa: E402


def main():
    t0 = time.time()
    data = server.produce_routes()
    out = {"updated": time.time(), "data": data}
    server.ROUTES_FALLBACK.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    feats = data["features"]
    pts = sum(len(line) for f in feats for line in f["geometry"]["coordinates"])
    print(f"{len(feats)} tras, {pts} bodů, {server.ROUTES_FALLBACK.stat().st_size // 1024} kB, "
          f"{time.time() - t0:.0f} s -> {server.ROUTES_FALLBACK}")


if __name__ == "__main__":
    sys.exit(main())
