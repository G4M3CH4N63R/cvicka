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
