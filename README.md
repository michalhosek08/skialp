# Skialp CZ/SK

Mapová aplikace pro skialpinisty v českých a slovenských horách. Sama stahuje
předpovědi, lavinové zprávy, měření stanic a snímky z webkamer, vyhodnocuje je
a v přehledu ukazuje, kde jsou zrovna nejlepší podmínky.

## Veřejná verze 24/7 (GitHub Pages)

Aplikace běží i bez tvého počítače jako webová stránka na GitHub Pages. O data se stará
GitHub Actions (`.github/workflows/update.yml`): zhruba každých 30 minut spustí
`tools/build_static.py`, který stáhne předpověď, lavinové zprávy, měření stanic a meteo mapu
(po 3 h), skialpové trasy (1× denně), vyhodnotí snímky webkamer a stránku znovu nasadí.
Radar se načítá živě přímo v prohlížeči. Odkaz můžeš poslat komukoli.

- Ruční aktualizace: záložka **Actions** → *Aktualizace dat* → **Run workflow**.
- Každá změna kódu nahraná do větve `main` se nasadí sama.
- Ve veřejné verzi chybí režim historie (`?datum=`) – ten umí jen lokální server.
- GitHub může plánované spuštění o pár minut zpozdit. Kdyby se úloha po dlouhé
  nečinnosti repozitáře zastavila, zapneš ji v záložce Actions tlačítkem *Enable workflow*.

## Spuštění na vlastním počítači

Potřebuješ jen **Python 3.9+** (žádné další balíčky).

- Dvakrát klikni na **`start.bat`**, nebo
- v terminálu: `python server.py`

Otevře se prohlížeč na <http://127.0.0.1:8765/>. Server nech běžet – na pozadí
průběžně obnovuje data (i když máš stránku zavřenou). Ukončení: `Ctrl+C`.

### Na mobilu odkudkoli – přes Tailscale (doporučeno)

[Tailscale](https://tailscale.com) vytvoří soukromou síť jen z tvých zařízení, takže aplikaci
na domácím počítači otevřeš z telefonu doma i na horách (přes mobilní data). Nikdo jiný se k ní nedostane.

1. Nainstaluj Tailscale **do počítače** (<https://tailscale.com/download>) a přihlas se
   (např. Google nebo Microsoft účtem).
2. Nainstaluj aplikaci Tailscale **do telefonu** (Google Play / App Store) a přihlas se **stejným účtem**.
3. Spusť **`start-tailscale.bat`**. Aplikace si přes `tailscale serve` zařídí zabezpečenou adresu
   `https://<počítač>.<síť>.ts.net/`.
   - Při prvním spuštění může Tailscale vypsat odkaz pro povolení HTTPS – otevři ho, potvrď
     a `start-tailscale.bat` spusť znovu. Bez toho aplikace použije adresu `http://100.x.y.z:8765/`
     (pak je potřeba povolit Python ve firewallu).
4. V aplikaci klikni na tlačítko **📱** v horní liště a naskenuj QR kód telefonem.
5. V prohlížeči telefonu zvol **„Přidat na plochu“** – aplikace dostane vlastní ikonu, umí posílat
   upozornění a bez signálu ukáže poslední stažená data.

Počítač musí být zapnutý (ne v režimu spánku) a okno serveru otevřené.

### Na mobilu jen doma (stejná Wi-Fi)

Spusť **`start-mobil.bat`** (nebo `python server.py --lan`). V okně serveru se vypíše adresa
pro telefon, např. `http://192.168.1.23:8765/` (QR kód je i pod tlačítkem 📱).
Při prvním spuštění se Windows zeptá na firewall – povol Python (u sítě typu „Veřejná“
je potřeba zaškrtnout i veřejné sítě, nebo síť ve Windows přepnout na „Soukromá“).

## Co aplikace umí

**Rychlý přehled** (levý panel)
- celková situace: jestli je sezóna, kde je nejvíc sněhu, kde a kolik má
  nasněžit, varování před větrem, lavinová situace a nejlepší den,
- žebříček oblastí pro dnes / zítra / pozítří se skóre 0–100 a důvody
  (sníh, nový sníh, srážky, vítr, oblačnost, mlha, obleva, lavinový stupeň,
  rozbor webkamer),
- volitelné upozornění v prohlížeči, když bude někde „Ideální“ (skóre ≥ 75).

**Detail oblasti** – 28 skialpových oblastí (Krkonoše, Jizerky, Orlické hory,
Králický Sněžník, Jeseníky, Beskydy, Šumava, Krušné hory, Vysoké, Západné
a Nízke Tatry, Malá a Veľká Fatra, Choč, Babia hora): hodnocení na 3 dny, aktuální
stav, naměřené hodnoty nejbližší stanice, graf předpovědi na 4 dny, lavinová
předpověď regionu, webkamery a skialpové trasy v okolí.

**Mapa – vrstvy lze zapínat a vypínat** (tlačítko *Vrstvy*)
| Skupina | Vrstva |
|---|---|
| Podklad | turistická (OpenTopoMap), OSM, topografická a letecká (Esri) |
| Skialp | oblasti s hodnocením (popisek: skóre / teplota / sníh / nový sníh / vítr), skialpové trasy z OSM, sjezdovky a lanovky (OpenSnowMap), turistické trasy |
| Laviny | lavinové regiony obarvené stupněm nebezpečí, **sklon svahů** (27–30°, 30–35°, 35–40°, 40–45°, > 45°) s filtrem expozic a nadmořské výšky; tlačítko „Ukázat kritické svahy“ nastaví filtr podle lavinové předpovědi |
| Aktuální stav | webkamery (barva = výsledek rozboru), meteostanice (naměřeno), radar srážek, sněhová pokrývka z družice, družicový snímek |
| Předpověď | teplota, srážky, nový sníh za 24 h, výška sněhu, nárazy větru – s časovou osou (−24 h až +72 h) a přehráváním; klik do mapy ukáže hodnoty v bodě |

**Plánování trasy** (záložka *Trasa*)
- klikáním do mapy přidáváš body (start, mezibody, cíl), body jde přetahovat, mazat a přeřazovat,
  kliknutím na trasu vložíš bod mezi; trasu lze obrátit,
- úseky **po cestách** (plánovač Mapy.com, při výpadku BRouter) nebo **přímo** – pro výstupy a sjezdy mimo cesty,
- **výškový profil** propojený s mapou, délka, stoupání, klesání, nejvyšší bod a **odhad času** podle
  skialpového tempa (výstup 300–600 m/h, sjezd, přepnutí pásů),
- **lavinový terén na trase**: úseky přes svahy nad 30/35/40/45° (do ~40 m od trasy), barevně v profilu
  i na mapě, lavinový stupeň regionu a délka trasy v kritických expozicích z lavinové předpovědi,
- **počasí na trase v čase průchodu** (teplota, vítr, srážky, oblačnost, mlha, nulová izoterma)
  a porovnání s východem a západem slunce,
- sdílení odkazem (i s časem startu), uložení tras v prohlížeči, export a import **GPX**.
  Export GPX počítá trasu přes BRouter – podmínky Mapy.com export výsledků nedovolují.
- V detailu oblasti je tlačítko *Naplánovat trasu odsud*.

**Rozbor webkamer** – každých 15 minut se stáhnou snímky ze 140 kamer a z obrazu
se odhadne sníh v záběru, viditelnost (mlha / v oblacích) a modrá obloha.
Za soumraku a v noci (podle výšky Slunce) se snímky nehodnotí.

**Režim historie** – `http://127.0.0.1:8765/?datum=2026-02-14` ukáže, jak by
aplikace hodnotila podmínky v daný den (archivní předpověď a lavinové zprávy).

## Zdroje dat a obnovování

| Data | Zdroj | Obnova |
|---|---|---|
| Předpověď pro oblasti | [Open-Meteo](https://open-meteo.com) (výška oblasti) | 30 min |
| Meteo mapa (mřížka ~25 km) | Open-Meteo | 3 h |
| Lavinové předpovědi | HS ČR, SLP HZS přes [EAWS](https://avalanches.org) (CAAML) | 20 min |
| Měření stanic | [ČHMÚ](https://opendata.chmi.cz), [SHMÚ](https://opendata.shmu.sk) open data | 10 min |
| Radar | [RainViewer](https://www.rainviewer.com) | 5 min |
| Skialpové trasy | OpenStreetMap / Overpass (`piste:type=skitour`) | 24 h |
| Webkamery | [Ventusky](https://www.ventusky.com) (původní zdroj je uveden u kamery) | 15 min |
| Sklon svahů | AWS Terrain Tiles (výškový model), počítá se v prohlížeči | – |
| Družice | NASA GIBS (MODIS) | denně |

Data se ukládají do složky `cache/` – při výpadku zdroje se ukáže poslední známý stav.
Stav jednotlivých zdrojů zobrazíš kliknutím na „Aktualizováno …“ v horní liště.

## Klíč k Mapy.com (plánování tras)

Plánovač Mapy.com potřebuje klíč z <https://developer.mapy.com/> (zdarma, 250 000 kreditů měsíčně,
jedna trasa = 4 kredity). Bez klíče plánuje BRouter. Klíč **není v repozitáři**:

- **Veřejná verze:** GitHub → repozitář → *Settings → Secrets and variables → Actions →
  New repository secret*, název `MAPY_API_KEY`, hodnota = klíč. Projeví se při další aktualizaci.
- **Lokální server:** soubor `mapy_key.txt` vedle `server.py` s klíčem na prvním řádku
  (soubor je v `.gitignore`).
- Klíč je ve stránce vidět, proto ho v administraci Mapy.com (*API klíče → Zabezpečení*) omez na HTTP
  referery `michalhosek08.github.io`, `localhost:*` a `127.0.0.1:*`. Placené čerpání nezapínej –
  po vyčerpání kreditů se plánování jen přepne na BRouter.

## Úpravy

- **Oblasti**: `static/data/areas.json` (název, souřadnice, výška pro předpověď, poznámka).
- **Webkamery**: `python tools/build_webcams.py` znovu sestaví seznam kamer
  v okolí oblastí (`static/data/webcams.json`) – spusť po přidání oblastí.
- **Hodnocení**: váhy a prahy jsou v `static/js/scoring.js`.

## Omezení

- Výška sněhu je **modelový odhad** (Open-Meteo), ne měření; v úzkých dolinách
  a na hřebenech může být realita jiná. Měřený sníh mají jen některé stanice SHMÚ.
- Lavinové předpovědi vychází jen pro Krkonoše, Jeseníky a slovenská pohoří
  (obvykle prosinec–duben). Pro ostatní oblasti hodnoť terén sám.
- Rozbor webkamer je heuristický (barvy a kontrast obrazu) – ber ho jako orientační.
- Aplikace nenahrazuje vlastní úsudek, oficiální lavinovou předpověď ani pravidla
  národních parků (KRNAP, TANAP, NAPANT…).
