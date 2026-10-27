// Cvička: synchronizační Worker pro Cloudflare + D1
//
// Server je provozní kanál, ne archiv. Nikdy se sem nedostane jméno ani příjmení žáka.
// Store `zaci` se neodesílá vůbec, druhé zařízení si jmenný seznam natáhne z CSV ze ŠOL.
// Poznámky o chování přicházejí už zašifrované klientem (AES-GCM), server vidí jen bajty.
//
// Protokol: jeden endpoint POST /sync, jedno kolo = odeslat své změny a natáhnout cizí.
//   požadavek  { od: <kurzor>, zmeny: [ { store, rid, data: {...}|null, updatedAt } ] }
//   odpověď    { verze: <nový kurzor>, zmeny: [ ...totéž... ], vic: bool }
// data: null znamená smazáno (náhrobek). Konflikt řeší poslední zápis podle updatedAt.
//
// POST /zapis: z náplně hodiny (Úvodní část, Hlavní část, Závěr) napíše přes
// Claude API návrh zápisu do Školy OnLine. Klíč ANTHROPIC_API_KEY je jen tady jako secret,
// aplikace ho nikdy nevidí. Pravidla pro zápis jsou tady, aplikace posílá jen text náplně
// (jména žáků z něj předem vymaže) a ročník.

const DAVKA = 500;      // kolik řádků vrátíme na jedno kolo
const MAX_PRIJEM = 2000; // strop na jednu dávku od klienta

const HLAVICKY = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-max-age": "86400"
};

const odpoved = (telo, status = 200) =>
  new Response(JSON.stringify(telo), {
    status,
    headers: { ...HLAVICKY, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HLAVICKY });

    if (!env.SYNC_TOKEN) return odpoved({ chyba: "server nemá nastavený SYNC_TOKEN" }, 500);
    const hlavicka = req.headers.get("authorization") || "";
    if (hlavicka !== "Bearer " + env.SYNC_TOKEN) return odpoved({ chyba: "neplatný token" }, 401);

    const cesta = new URL(req.url).pathname.replace(/\/+$/, "") || "/";

    try {
      if (cesta === "/stav") return odpoved(await stav(env));
      if (cesta === "/sync" && req.method === "POST") return odpoved(await sync(env, await req.json()));
      if (cesta === "/smazat-vse" && req.method === "POST") return odpoved(await smazatVse(env));
      if (cesta === "/zapis" && req.method === "POST") {
        const { status, ...r } = await navrhZapisu(env, await req.json());
        return odpoved(r, r.chyba ? (status || 500) : 200);
      }
    } catch (e) {
      return odpoved({ chyba: String(e && e.message || e) }, 500);
    }
    return odpoved({ chyba: "neznámý endpoint" }, 404);
  }
};

async function stav(env) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS radku, COALESCE(MAX(seq), 0) AS verze FROM zaznamy").first();
  return { ok: true, radku: r.radku, verze: r.verze };
}

async function smazatVse(env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM zaznamy"),
    env.DB.prepare("UPDATE citac SET v = 0 WHERE k = 'seq'")
  ]);
  return { ok: true, smazano: true };
}

async function sync(env, telo) {
  const od = Number(telo && telo.od) || 0;
  const zmeny = Array.isArray(telo && telo.zmeny) ? telo.zmeny : [];
  if (zmeny.length > MAX_PRIJEM) return { chyba: "příliš velká dávka, maximum je " + MAX_PRIJEM };

  if (zmeny.length) {
    // Jedno pořadové číslo na řádek, aby stránkování podle kurzoru nikdy nerozseklo
    // dávku vejpůl. Celé to jde jedním batchem, takže je to atomické.
    const citac = await env.DB.prepare("SELECT v FROM citac WHERE k = 'seq'").first();
    let seq = Number(citac && citac.v) || 0;

    // Store `sys` drzi sul a kontrolni retezec pro sifrovani. Ty se smi zapsat jen jednou:
    // kdyby je druhe zarizeni prepsalo svymi, uz zasifrovane poznamky by nikdo neotevrel.
    const vlozitJednou = env.DB.prepare(
      `INSERT INTO zaznamy (id, store, rid, data, smazano, updatedAt, seq)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(id) DO NOTHING`
    );

    const vlozit = env.DB.prepare(
      `INSERT INTO zaznamy (id, store, rid, data, smazano, updatedAt, seq)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(id) DO UPDATE SET
         data = excluded.data,
         smazano = excluded.smazano,
         updatedAt = excluded.updatedAt,
         seq = excluded.seq
       WHERE excluded.updatedAt >= zaznamy.updatedAt`
    );

    const prikazy = [];
    for (const z of zmeny) {
      if (!z || typeof z.store !== "string" || typeof z.rid !== "string") continue;
      if (z.store === "zaci") continue; // pojistka: jmenný seznam sem nepatří
      seq += 1;
      const prikaz = z.store === "sys" ? vlozitJednou : vlozit;
      prikazy.push(prikaz.bind(
        z.store + "|" + z.rid,
        z.store,
        z.rid,
        z.data == null ? null : JSON.stringify(z.data),
        z.data == null ? 1 : 0,
        Number(z.updatedAt) || 0,
        seq
      ));
    }
    if (prikazy.length) {
      prikazy.push(env.DB.prepare("UPDATE citac SET v = ?1 WHERE k = 'seq'").bind(seq));
      await env.DB.batch(prikazy);
    }
  }

  const vysledek = await env.DB
    .prepare("SELECT store, rid, data, smazano, updatedAt, seq FROM zaznamy WHERE seq > ?1 ORDER BY seq LIMIT ?2")
    .bind(od, DAVKA)
    .all();
  const radky = vysledek.results || [];

  const posledni = radky.length
    ? radky[radky.length - 1].seq
    : (await env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS v FROM zaznamy").first()).v;

  return {
    verze: Math.max(od, Number(posledni) || 0),
    vic: radky.length === DAVKA,
    zmeny: radky.map((r) => ({
      store: r.store,
      rid: r.rid,
      data: r.smazano ? null : JSON.parse(r.data),
      updatedAt: r.updatedAt
    }))
  };
}


// ---------- návrh zápisu do ŠOL ----------

const ZAPIS_MODEL = "claude-haiku-4-5-20251001";
// rozcvicka zustava kvuli starsim aplikacim (0.15.0), od 0.15.1 je rozcvicka soucasti uvodni casti
const CASTI = [["rozcvicka", "Rozcvička"], ["uvod", "Úvodní část"], ["hlavni", "Hlavní část"], ["zaver", "Závěr"]];

function zapisPokyny() {
  return [
    "Píšeš zápisy do třídní knihy (Škola OnLine) pro učitele tělesné výchovy na základní škole v Praze.",
    "Z náplně hodiny napiš, co se žák v hodině naučil nebo procvičil. Pravidla:",
    "1. Začni aktivním slovesem ve 3. osobě jednotného čísla, nikdy slovem žáci nebo žák. První sloveso vyber z tohoto seznamu (Bloomova taxonomie, jak to chce vedení školy): cvičí, reaguje, přizpůsobí, řeší, vybere, určí, ukáže, předvede, popíše, vyjmenuje, rozliší, pozoruje, porovná, odhadne, posoudí, ohodnotí, zdůvodní, koordinuje, kombinuje, organizuje, uspořádá, plánuje, navrhne, sestaví, vytvoří, vylepší, testuje, ověří, rozvíjí. Další slovesa ve větě můžou být běžná (spolupracuje, hází, chytá, uhýbá).",
    "2. Jednotné číslo, stručně: jedna věta nebo souvětí, nejvýš asi 25 slov.",
    "3. Piš tak, aby tomu rozumělo dítě daného ročníku a jeho rodič. Bez odborných slov (ne uplatní herní činnosti, akcelerace, zdokonalí techniku, rozloží tempo).",
    "4. Popiš konkrétní dovednost nebo výsledek, ne program hodiny. Místo hráli fotbal napiš Cvičí přihrávky a spolupráci s týmem ve fotbalu.",
    "5. Nejmenuj konkrétní pohybové hry (třeba Mrazík, Bludišťák, Medvědí doupě, Ocásky, vlajkovaná). Napiš, co hra rozvíjí. Sportovní hry (fotbal, florbal, házená, vybíjená, basketbal, přehazovaná, ragby) jmenovat smíš.",
    "6. Těžiště je v hlavní části. Úvodní část (rozcvička nebo úvodní hra) přidej jen krátce, když se vejde, a obyčejnou rozcvičku nebo závěr (protažení, zhodnocení) nezmiňuj, pokud v nich nebylo nic zvláštního.",
    "7. Nepřipisuj dovednost, která v náplni není. Nic si nevymýšlej.",
    "8. V souladu s ŠVP tělesné výchovy, ale řečeno lidsky.",
    "9. Nepoužívej pomlčky ani spojovníky jako interpunkci, jen čárky a spojky.",
    "Vzory dobrých zápisů:",
    "Cvičí předávání kolíku ve štafetě a spolupracuje s týmem ve fotbalu.",
    "Přizpůsobí tempo běhu na 1000 m tak, aby mu vydržely síly až do cíle.",
    "Reaguje rychle při honičce a spolupracuje s ostatními.",
    "Koordinuje se s týmem, plní svůj úkol ve hře a vybere volné místo pro přihrávku.",
    "Vyjmenuje pravidla bezpečnosti v tělocvičně a reaguje na pokyny při hrách na rychlost a spolupráci.",
    "Odpověz přesně dvěma návrhy, každý na samostatném řádku, druhý jinými slovy nebo kratší. Bez číslování, uvozovek a dalšího textu."
  ].join("\n");
}

const vycisti = (x) => String(x || "").replace(/\r/g, "").trim().slice(0, 1500);

async function navrhZapisu(env, telo) {
  if (!env.ANTHROPIC_API_KEY) return { chyba: "Na serveru chybí ANTHROPIC_API_KEY, postup je v server/README.md.", status: 503 };
  const c = (telo && telo.casti) || {};
  const napln = CASTI.map(([k, n]) => [n, vycisti(c[k])]).filter(([, t]) => t).map(([n, t]) => n + ": " + t).join("\n");
  if (!napln) return { chyba: "Náplň hodiny je prázdná.", status: 400 };
  const r0 = Number(telo && telo.rocnik);
  const rocnik = r0 >= 1 && r0 <= 9 ? r0 : null;
  const priklady = (telo && Array.isArray(telo.priklady) ? telo.priklady : []).map((x) => vycisti(x).slice(0, 300)).filter(Boolean).slice(0, 3);
  const dotaz = [
    rocnik ? "Ročník: " + rocnik + ". (" + (rocnik <= 5 ? "1. stupeň, piš hodně jednoduše" : "2. stupeň") + ")" : "Ročník neznámý, piš jednoduše.",
    "Náplň hodiny:",
    napln,
    priklady.length ? "\nPro představu o stylu, takhle učitel psal dřív (obsah z nich nepřebírej):\n" + priklady.join("\n") : "",
    "\nNapiš dva návrhy zápisu."
  ].join("\n");

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: env.ZAPIS_MODEL || env.ASISTENT_MODEL || ZAPIS_MODEL,
      max_tokens: 400,
      system: zapisPokyny(),
      messages: [{ role: "user", content: dotaz }]
    })
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data) {
    const msg = data && data.error && data.error.message ? data.error.message : ("HTTP " + r.status);
    return { chyba: "Claude API: " + msg, status: 502 };
  }
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const navrhy = [...new Set(text.split("\n")
    .map((x) => x.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^["„“”']+|["„“”']+$/g, "").trim())
    .filter((x) => x.length > 10))].slice(0, 3);
  if (!navrhy.length) return { chyba: "Návrh se nepovedl, zkus to znovu.", status: 502 };
  return { navrhy, usage: data.usage || null };
}
