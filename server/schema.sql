-- Cvička: schéma pro Cloudflare D1
-- Na serveru leží jen kódy, čísla a texty hodin. Žádné jméno žáka.

CREATE TABLE IF NOT EXISTS zaznamy (
  id        TEXT PRIMARY KEY,   -- "store|rid", třeba "hodiny|2026-09-14|rz_a1b2"
  store     TEXT NOT NULL,      -- skupiny, rozvrh, hodiny, zaznamy, cinnosti, sliby, pozn, sys
  rid       TEXT NOT NULL,      -- id záznamu uvnitř store
  data      TEXT,               -- JSON záznamu, NULL u smazaného
  smazano   INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL DEFAULT 0,  -- čas poslední změny na klientu, řeší konflikty
  seq       INTEGER NOT NULL DEFAULT 0   -- pořadové číslo na serveru, kurzor pro stahování
);

CREATE INDEX IF NOT EXISTS idx_zaznamy_seq ON zaznamy(seq);

CREATE TABLE IF NOT EXISTS citac (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);

INSERT OR IGNORE INTO citac (k, v) VALUES ('seq', 0);
