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
// POST /asistent: přeposílá konverzaci do Claude API. Klíč ANTHROPIC_API_KEY je jen tady
// jako secret, aplikace ho nikdy nevidí. Pokyny a nástroje jsou definované tady, aplikace
// posílá jen zprávy. Nástroje vykonává aplikace u sebe v zařízení a vrací výsledky,
// ve kterých jsou žáci jen jako kódy Ž1, Ž2…, jména Claude nikdy nedostane.

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
      if (cesta === "/asistent" && req.method === "POST") {
        const { status, ...r } = await asistent(env, await req.json());
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


// ---------- asistent ----------

const ASISTENT_MODEL = "claude-haiku-4-5-20251001";
const ASISTENT_MAX_ZPRAV = 40;        // strop na délku konverzace
const ASISTENT_MAX_BAJTU = 300000;    // strop na velikost požadavku

const ASISTENT_NASTROJE = [
  { name: "skupiny", description: "Seznam skupin (tříd nebo jejich částí), které Karel učí, s počtem žáků a rozvrhem.",
    input_schema: { type: "object", properties: {} } },
  { name: "zaci", description: "Žáci jedné skupiny jako kódy (Ž1, Ž2…) se třídou. Jména nejsou k dispozici, aplikace je doplní sama.",
    input_schema: { type: "object", properties: { skupina: { type: "string", description: "id skupiny z nástroje skupiny" } }, required: ["skupina"] } },
  { name: "dochazka", description: "Docházka skupiny za období po žácích: odučené hodiny, kolikrát cvičil (ok), nepřítomen (X), necvičil (N), bez úboru (U), vedl rozcvičku. Omluvení bez záznamu se počítají jako N.",
    input_schema: { type: "object", properties: { skupina: { type: "string" }, od: { type: "string", description: "RRRR-MM-DD, výchozí začátek školního roku" }, do: { type: "string", description: "RRRR-MM-DD, výchozí dnešek" } }, required: ["skupina"] } },
  { name: "vykony", description: "Naměřené výkony (disciplína, hodnota, jednotka, datum, kód žáka). U jednotek s a min je lepší menší číslo.",
    input_schema: { type: "object", properties: { skupina: { type: "string" }, disciplina: { type: "string" }, zak: { type: "string", description: "kód žáka, např. Ž3" }, od: { type: "string" }, do: { type: "string" } } } },
  { name: "omluvy", description: "Omluvy žáků z tělocviku (kód žáka, od, do; prázdné do znamená do odvolání). Důvod se nesdílí.",
    input_schema: { type: "object", properties: { skupina: { type: "string" }, platne_k: { type: "string", description: "RRRR-MM-DD, jen omluvy platné v ten den" } } } },
  { name: "hodiny", description: "Hodiny s plánem, náplní, zápisem do ŠOL, stavem a poznanými činnostmi. Nejnovější napřed, nejvýš 60.",
    input_schema: { type: "object", properties: { skupina: { type: "string" }, od: { type: "string" }, do: { type: "string" }, hledat: { type: "string", description: "volitelný text, který má hodina obsahovat" } } } },
  { name: "dlouho_nebylo", description: "Činnosti ze zásobníku u jedné skupiny seřazené od nejdéle nedělaných, s počtem týdnů od posledního provedení a okruhem ŠVP.",
    input_schema: { type: "object", properties: { skupina: { type: "string" } }, required: ["skupina"] } },
  { name: "sliby", description: "Nesplněné sliby třídám.",
    input_schema: { type: "object", properties: { skupina: { type: "string" } } } }
];

function asistentPokyny() {
  const dnes = new Intl.DateTimeFormat("cs-CZ", { timeZone: "Europe/Prague", weekday: "long", year: "numeric", month: "numeric", day: "numeric" }).format(new Date());
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date());
  return [
    "Jsi asistent v aplikaci Cvička, třídní knize učitele tělesné výchovy Karla na ZŠ v Praze.",
    "Dnes je " + dnes + " (" + iso + ").",
    "Odpovídej česky, stručně a věcně. Nepoužívej pomlčky ani spojovníky jako interpunkci, piš celé věty a čárky.",
    "Data zjišťuj nástroji, nic si nevymýšlej. Když nástroj nic nevrátí, řekni to.",
    "Žáci jsou v datech jen jako kódy Ž1, Ž2 atd. V odpovědi je piš přesně v tomto tvaru, aplikace je nahradí jmény. Nikdy se neptej na jména a nehádej je.",
    "Skupiny označuj jejich názvem (např. III. A), ne id.",
    "Seznamy dělej krátké. Když je výsledků hodně, shrň je a uveď počet.",
    "Když Karel chce návrh zápisu do ŠOL, piš jednu větu v jednotném čísle, srozumitelnou pro děti daného ročníku, s aktivním slovesem a konkrétní dovedností, bez názvů konkrétních her."
  ].join("\n");
}

async function asistent(env, telo) {
  if (!env.ANTHROPIC_API_KEY) return { chyba: "Na serveru chybí ANTHROPIC_API_KEY, postup je v server/README.md.", status: 503 };
  const zpravy = Array.isArray(telo && telo.zpravy) ? telo.zpravy : null;
  if (!zpravy || !zpravy.length) return { chyba: "chybí zprávy", status: 400 };
  if (zpravy.length > ASISTENT_MAX_ZPRAV) return { chyba: "Konverzace je moc dlouhá, začni novou.", status: 400 };
  if (JSON.stringify(zpravy).length > ASISTENT_MAX_BAJTU) return { chyba: "Požadavek je moc velký, začni novou konverzaci.", status: 400 };

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: env.ASISTENT_MODEL || ASISTENT_MODEL,
      max_tokens: 1024,
      system: asistentPokyny(),
      tools: ASISTENT_NASTROJE,
      messages: zpravy
    })
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data) {
    const msg = data && data.error && data.error.message ? data.error.message : ("HTTP " + r.status);
    return { chyba: "Claude API: " + msg, status: 502 };
  }
  return { content: data.content || [], stop_reason: data.stop_reason, usage: data.usage || null };
}
