# Cvička: synchronizační server

Cloudflare Worker plus databáze D1. Free tarif bohatě stačí, deset skupin a devět set hodin
je proti limitům zanedbatelné.

## Co na serveru leží a co ne

Na server jdou: skupiny, rozvrh, hodiny i s náplní a zápisem do ŠOL, docházka jako kódy a stavy,
zásobník činností, sliby a zápisy u žáků, tedy výkony, reprezentace a poznámky.

Na server nikdy nejde jmenný seznam. Store `zaci` se neodesílá a Worker ho navíc odmítá.
Druhé zařízení si jména natáhne z těch samých CSV ze ŠOL a spáruje je podle stabilních id.

Volný text u zápisů k žákovi se šifruje už v zařízení (AES-GCM, klíč z hesla přes PBKDF2).
Týká se to všech typů, tedy i volné poznámky a textu u reprezentace, ne jenom chování:
i do volné poznámky se dá napsat jméno. Čísla, disciplíny a názvy akcí zůstávají čitelné,
aby se z nich daly dělat přehledy. Server vidí u textu jen bajty. Dokud v Nastavení
nezadáš heslo, aplikace zápisy s textem neodesílá vůbec a čekají ve frontě.

**Kde hranice končí:** náplň hodiny, plán a zápis do ŠOL jdou na server v čitelné podobě,
protože to jsou texty o třídě, ne o konkrétním žákovi. Když do nich napíšeš jméno,
na serveru skončí. Záruka zní: jmenný seznam se neodesílá nikdy a všechno, co visí
na konkrétním žákovi, jde jen zašifrované.

## Nasazení

Potřebuješ přihlášený `wrangler`. Všechno se pouští z téhle složky.

```
cd ~/Desktop/"Claude Cowork"/"Třídní kniha"/cvicka/server

cp wrangler.toml.vzor wrangler.toml         # skutečná konfigurace, do repa nejde
npx wrangler login                          # jednou, otevře prohlížeč
npx wrangler d1 create cvicka               # vypíše database_id
```

Vypsané `database_id` opiš do `wrangler.toml` místo `SEM_PATRI_ID_Z_WRANGLER_D1_CREATE`.
V repu je jen `wrangler.toml.vzor`, skutečný soubor je v `.gitignore`. Samotné `database_id`
sice bez API tokenu nikomu k ničemu není, ale ve veřejném repu nemá co dělat.

Pak založ tabulky a nastav token:

```
npx wrangler d1 execute cvicka --remote --file=schema.sql

# token si vygeneruj a nikam ho nezapisuj do repa
openssl rand -hex 32

npx wrangler secret put SYNC_TOKEN          # vloží se vygenerovaný token
npx wrangler deploy
```

`wrangler deploy` vypíše adresu ve tvaru `https://cvicka-sync.<tvůj-účet>.workers.dev`.
Tu adresu a token zadáš v aplikaci v Nastavení do karty Synchronizace, na obou zařízeních stejně.

## Ověření, že server žije

```
curl -s -H "Authorization: Bearer <TOKEN>" https://cvicka-sync.<účet>.workers.dev/stav
```

Má vrátit `{"ok":true,"radku":0,"verze":0}`. Po první synchronizaci z telefonu poskočí
`radku` na zhruba tisíc.

## Asistent (od verze 0.12)

Endpoint `POST /asistent` přeposílá otázky z aplikace do Claude API (model Haiku 4.5).
Klíč k API je jen tady na serveru jako secret, aplikace ho nikdy nevidí.

**Co odchází do Claude:** otázka, docházka jako čísla, výkony, data omluv, plán, náplň
a zápis hodin, sliby a zásobník činností. Žáci jen jako kódy Ž1, Ž2… přidělené pro jednu
konverzaci, jména doplní až aplikace. **Nikdy neodchází:** jména, poznámky o chování,
důvody omluv a volné poznámky.

**Jednorázové nastavení:**

1. Na [platform.claude.com](https://platform.claude.com) se přihlas, v části Billing dobij
   kredit a v části Limits nastav měsíční limit útraty (třeba 5 USD).
2. V API Keys vytvoř klíč a zkopíruj ho. Nikam ho nezapisuj.
3. Ulož ho do Workeru a Worker znovu nasaď:

```
cd ~/Desktop/"Claude Cowork"/"Třídní kniha"/cvicka/server
npx wrangler secret put ANTHROPIC_API_KEY     # vloží se zkopírovaný klíč
npx wrangler deploy
```

**Ověření:**

```
curl -s -X POST -H "Authorization: Bearer <TOKEN>" -H "content-type: application/json" \
  -d '{"zpravy":[{"role":"user","content":"Ahoj, kolik je dnes?"}]}' \
  https://cvicka-sync.<účet>.workers.dev/asistent
```

Má vrátit JSON s `content` a textem odpovědi. `Na serveru chybí ANTHROPIC_API_KEY` znamená,
že secret není uložený nebo Worker nebyl po jeho uložení znovu nasazený.

Model se dá změnit bez úpravy kódu proměnnou `ASISTENT_MODEL` (`npx wrangler secret put
ASISTENT_MODEL`), výchozí je `claude-haiku-4-5-20251001`.

## Endpointy

| Endpoint | Co dělá |
|---|---|
| `GET /stav` | kolik řádků a jaké je pořadové číslo, na rychlou kontrolu |
| `POST /sync` | jedno kolo: pošle své změny a stáhne cizí |
| `POST /smazat-vse` | vymaže obsah databáze, hodí se na konci školního roku |
| `POST /asistent` | otázka pro asistenta, `{ zpravy: [...] }` ve formátu Messages API |

Všechno chce hlavičku `Authorization: Bearer <token>`.

## Protokol

```
požadavek  { "od": 0, "zmeny": [ { "store": "hodiny", "rid": "2026-09-14|rz_a1b2",
                                   "data": { ... }, "updatedAt": 1789412345678 } ] }
odpověď    { "verze": 12, "vic": false, "zmeny": [ ... stejný tvar ... ] }
```

`data: null` je náhrobek, tedy smazaný záznam. Konflikt vyhrává novější `updatedAt`.
Každý řádek dostane na serveru vlastní pořadové číslo `seq`, takže stránkování podle kurzoru
nikdy nerozsekne dávku vejpůl. Klient posílá po třech stech záznamech a stahuje po pěti stech.

## Konec školního roku

V červenci: stáhnout zálohu v aplikaci, uložit archiv na disk a teprve pak
`POST /smazat-vse`. Server je provozní kanál, ne archiv.
