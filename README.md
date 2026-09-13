# Cvička

Třídní kniha na tělesnou výchovu. Fáze F0 a F1: rozvrh, generování hodin na celý školní rok,
zápis docházky a náplně hodiny, příprava na týden, záloha.

Data leží v prohlížeči zařízení (IndexedDB) a nikam se neodesílají. Jména žáků neopustí zařízení.

## Spuštění

Lokálně na Macu:

```
cd cvicka
python3 -m http.server 8000
```

Pak otevřít http://localhost:8000. Otevření souboru přímo (dvojklik) funguje taky,
ale bez service workeru, takže bez offline režimu.

Na iPhone: nasadit na GitHub Pages (viz níže) a v Safari dát Sdílet → Přidat na plochu.
Teprve pak jde aplikace používat offline u hřiště.

## První spuštění

1. Otevřít Nastavení
2. Vybrat `rozvrh-2026-27.csv` a `zaci-skupiny.csv` (leží ve složce projektu o úroveň výš)
3. Zkontrolovat rozsah školního roku a volné dny
4. Načíst a vygenerovat hodiny

Výsledek: 10 skupin, 273 žáků, 899 hodin do 30. 6. 2027.

## Volné dny 2026/2027

Předvyplněné podle MŠMT a jarních prázdnin pro Prahu 1 až 5:

- 28. 9. 2026 (Den české státnosti)
- 28. až 30. 10. 2026 (svátek a podzimní prázdniny)
- 17. 11. 2026
- 23. 12. 2026 až 1. 1. 2027 (vánoční prázdniny)
- 29. 1. 2027 (pololetní prázdniny)
- 22. až 26. 2. 2027 (jarní prázdniny)
- 25. a 26. 3. 2027 (velikonoční prázdniny a Velký pátek)
- 29. 3. 2027 (Velikonoční pondělí)

Termín jarních prázdnin si radši ověř ve škole. Seznam se dá kdykoli upravit v Nastavení
a přegenerovat hodiny, zapsané hodiny to nesmaže.

## Nasazení na GitHub Pages

Settings → Pages → Deploy from branch → main / root.

V repozitáři nesmí být CSV se jmény žáků ani záloha. `.gitignore` na to pamatuje.

## Struktura

- `index.html` celá aplikace (UI, datová vrstva nad IndexedDB, import, generátor hodin)
- `sw.js` service worker pro offline
- `manifest.webmanifest` ikona a název na ploše

## Datové úložiště

Object stores: `meta`, `skupiny`, `zaci`, `rozvrh`, `hodiny`, `zaznamy`.

Hodina má `plan` (co chci dělat), `napln` (co se dělalo) a `zapis` (věta do ŠOL).
Stav hodiny: `plan` → `zapsana` → `uzavrena`.
Záznam docházky: `ok`, `X` (nepřítomen), `N` (necvičí), `U` (bez úboru), plus `vedl` rozcvičku.

## Co přijde dál

F2 zásobník činností a výpočet „dlouho nebylo", F3 zápis do ŠOL ze šablon a měření výkonů,
F4 asistent s nástroji, F5 synchronizace mezi iPhonem a Macem.
