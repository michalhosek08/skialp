// Nastavení aplikace.

// Klíč k REST API Mapy.com (https://developer.mapy.com/) pro plánování tras.
// V repozitáři je prázdný – doplňuje se při spuštění:
//   * lokální server (server.py): ze souboru mapy_key.txt vedle server.py (necommituje se),
//   * GitHub Pages: z tajného úložiště repozitáře (Settings → Secrets → Actions → MAPY_API_KEY).
// Ve stránce je klíč vidět, proto ho v administraci Mapy.com omez na adresy aplikace.
// Prázdný klíč = trasy plánuje jen BRouter.
export const MAPY_API_KEY = '';
