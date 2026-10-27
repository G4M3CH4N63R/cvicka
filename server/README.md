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

## Návrh zápisu do ŠOL (od verze 0.15, dřív asistent)

Endpoint `POST /zapis` napíše z náplně hodiny dva návrhy zápisu do Školy OnLine přes
Claude API (model Haiku 4.5). Pravidla pro zápis (aktivní sloveso z Bloomova seznamu
vedení školy, jednotné číslo, jedna věta, bez názvů pohybových her, srozumitelně pro
daný ročník) jsou v `zapisPokyny()` tady ve Workeru. Klíč k API je jen na serveru jako
secret, aplikace ho nikdy nevidí. Asistent s konverzací (`/asistent`) ve verzi 0.15 skončil.

**Co odchází do Claude:** text okének náplně (Úvodní část, Hlavní část, Závěr), ročník a nejvýš tři Karlovy dřívější zápisy jako ukázka stylu. Jména žáků aplikace
z textu předem vymaže. **Nikdy neodchází:** jména, docházka, poznámky, omluvy.

**Jednorázové nastavení** (klíč už je uložený od verze 0.12, stačí znovu nasadit):

1. Na [platform.claude.com](https://platform.claude.com) v části Billing dobij kredit
   a v části Limits nastav měsíční limit útraty.
2. V API Keys vytvoř klíč a ulož ho do Workeru:

```
cd ~/Desktop/"Claude Cowork"/"Třídní kniha"/cvicka/server
npx wrangler secret put ANTHROPIC_API_KEY     # jen když klíč ještě není uložený
npx wrangler deploy
```

**Ověření:**

```
curl -s -X POST -H "Authorization: Bearer <TOKEN>" -H "content-type: application/json" \
  -d '{"rocnik":3,"casti":{"hlavni":"Fotbal, přihrávky ve dvojicích"}}' \
  https://cvicka-sync.<účet>.workers.dev/zapis
```

Má vrátit `{"navrhy":["…","…"]}`. `Na serveru chybí ANTHROPIC_API_KEY` znamená, že secret
není uložený nebo Worker nebyl po jeho uložení znovu nasazený.

Model se dá změnit bez úpravy kódu proměnnou `ZAPIS_MODEL` (`npx wrangler secret put
ZAPIS_MODEL`), výchozí je `claude-haiku-4-5-20251001`. Starší `ASISTENT_MODEL` platí taky.

## Endpointy

| Endpoint | Co dělá |
|---|---|
| `GET /stav` | kolik řádků a jaké je pořadové číslo, na rychlou kontrolu |
| `POST /sync` | jedno kolo: pošle své změny a stáhne cizí |
| `POST /smazat-vse` | vymaže obsah databáze, hodí se na konci školního roku |
| `POST /zapis` | návrh zápisu do ŠOL, `{ rocnik, casti: { uvod, hlavni, zaver }, priklady }` |

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
