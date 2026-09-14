# Cvička

Třídní kniha na tělesnou výchovu. Rozvrh, generování hodin na celý školní rok, zápis docházky
a náplně hodiny, příprava na týden, zásobník činností, sliby třídě, karta žáka a záloha.

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

## Aktualizace (v0.3)

Service worker jede network-first pro HTML: když je signál, dostaneš vždy čerstvou verzi,
cache slouží jako záloha pro offline. Ostatní soubory jdou z cache a obnovují se na pozadí.

Aplikace kontroluje novou verzi při startu a pokaždé, když ji vrátíš do popředí. Když ji najde,
ukáže dole lištu s tlačítkem Načíst. Přenačtení spouštíš ty, aby to neskočilo uprostřed zápisu.

Registrace používá `updateViaCache: "none"`, takže se `sw.js` nebere z HTTP cache (GitHub Pages
na něj posílá `max-age=600`).

Při každém nasazení je nutné zvýšit `CACHE` v `sw.js`, jinak zařízení novou verzi nepozná.

## Datové úložiště

Object stores: `meta`, `skupiny`, `zaci`, `rozvrh`, `hodiny`, `zaznamy`, `cinnosti`, `sliby`, `pozn`.

Hodina má `plan` (co chci dělat), `napln` (co se dělalo) a `zapis` (věta do ŠOL).
Stav hodiny: `plan` → `zapsana` → `uzavrena`.
Záznam docházky: `ok`, `X` (nepřítomen), `N` (necvičí), `U` (bez úboru), plus `vedl` rozcvičku.

## Zásobník činností (v0.2)

53 činností vytěžených z historie: úvodní hry, hlavní část, gymnastika, atletika, průprava a měření.
Každá má ŠVP okruh a klíčová slova, kterými se hledá ve starých zápisech, takže „dlouho nebylo"
funguje i pro hodiny zapsané volným textem.

Řazení tipů: nejdřív to, co skupina nejdéle neměla, pak činnosti, které učíš u jiných skupin,
a nakonec ty, které jsi ještě nepoužil. Karta Dlouho nebylo skrývá všechno z posledních dvou týdnů.

Sliby se zakládají na obrazovce Hodina a visí na Dnes, dokud je neodškrtneš.

## Karta žáka (v0.4)

V docházkovém seznamu je u každého jména malé tlačítko vpravo. Tapnutí otevře kartu žáka,
tapnutí na stav dál cykluje docházku, takže se to nepoplete. Tlačítko ukazuje počet zápisů,
dokud žádný není, je v něm tužka.

Čtyři typy zápisů, všechny s datem (předvyplněné podle otevřené hodiny):

- **Výkon**: disciplína, hodnota a jednotka. Seznam disciplín je jen nápověda, dá se napsat vlastní,
  u známých disciplín se jednotka doplní sama. Desetinná čárka se ukládá jako tečka.
- **Reprezentace**: název akce a umístění nebo poznámka.
- **Chování**: text a příznak, jestli už šlo rodičům.
- **Poznámka**: cokoli dalšího.

Zápisy se řadí odshora od nejnovějšího. Mazání je dvoukrokové, první tapnutí na křížek
se zeptá, druhé smaže. Všechno leží ve store `pozn` a chodí do zálohy jako zbytek dat.

Porovnání s minulým měřením a osobní rekordy přijdou ve F3.

## Obnova ze zálohy (v0.4.1)

Obnova přepisuje jen ta úložiště, která v záloze skutečně jsou. Když načteš starší zálohu,
která ještě nezná nějaké úložiště (třeba zálohu z v0.1 bez `cinnosti`, `sliby` a `pozn`),
zůstane to úložiště beze změny místo toho, aby se promazalo. Hláška po obnově vypíše,
čeho se to týkalo.

## Stabilní id a příprava na synchronizaci (v0.5)

Do v0.4.1 mělo každé id náhodnou část, takže ten samý CSV soubor dal na iPhonu jiná id než
na MacBooku a synchronizace by neměla co párovat. Od v0.5 se id odvozují z obsahu:

- skupina z dvojice třídy a typ skupiny
- rozvrhový slot ze skupiny, dne a pořadí hodiny
- žák ze skupiny, příjmení a jména
- činnost z názvu
- hodina zůstává ve tvaru `datum|rozvrhId`, takže je stabilní také

Díky tomu dá import stejných souborů na obou zařízeních stejná id a stačí, aby si každé
zařízení natáhlo jmenný seznam z CSV samo. Jméno žáka tak nikdy nemusí opustit zařízení.

Existující data se při prvním startu v0.5 automaticky přepočítají, včetně odkazů v docházce,
slibech a poznámkách. Migrace běží jednou a zamkne se klíčem `idV5` v `meta`.

Import se tím zároveň změnil ze „smazat a založit znovu" na doplňování. Opakovaný import
nic nerozbije, hodiny ani docházka se nemažou, a žáci, kteří v novém CSV nejsou, se jen
schovají z docházky. Karta a historie jim zůstanou.

Docházkový seznam se nově řadí podle české abecedy. Dřív jel v pořadí id, tedy náhodně.

## Připomínka zálohy (v0.5)

Když je poslední stažená záloha starší než čtrnáct dní nebo žádná nebyla, ukáže se nahoře
na obrazovce Dnes karta s tlačítkem Stáhnout zálohu. Zmizí, jakmile zálohu stáhneš.
Datum poslední zálohy je v `meta` pod klíčem `zalohaKdy`.

## Co přijde dál

F5 synchronizace mezi iPhonem a MacBookem: Cloudflare Worker a D1, na server jdou jen kódy
a čísla, poznámky o chování šifrované heslem, jména zůstávají v zařízení.
Pak F3 zápis do ŠOL ze šablon, porovnání výkonů a pololetní přehledy, a F4 asistent s nástroji.
