# Prevede tabulku „Úvodní hry - seznam.xlsx“ ze skolniho Disku na hry/uvodni.json pro knihovnu ve Cvicce.
# Pouziti: python3 uvodni-z-excelu.py "<cesta k Úvodní hry - seznam.xlsx>" uvodni.json
import sys, os, json, datetime, unicodedata, re, openpyxl

# hry z tabulky, ktere uz v zasobniku Cvicky jsou pod jinym nazvem
STEJNE_JAKO = {
    "Vítr, voda, oheň, blesk": "Oheň, voda, vítr",
    "Kámen, nůžky, papír kolem hřiště": "Kámen, nůžky, papír",
}

# Do appky jdou jen odkazy https://, tabulku muzou upravovat i kolegove.
def bezpecny(u):
    u = (u or "").strip()
    return u if u.lower().startswith("https://") else ""

# Karta hry na webu Cvicky (hry/<slug>.html), pokud existuje. Otevre se bez prihlaseni.
SLOZKA = os.path.dirname(os.path.abspath(sys.argv[2]))
def web(nazev):
    s = unicodedata.normalize("NFD", nazev.lower())
    s = re.sub(r"[^a-z0-9]+", "-", "".join(c for c in s if unicodedata.category(c) != "Mn")).strip("-")
    return "hry/" + s + ".html" if os.path.exists(os.path.join(SLOZKA, s + ".html")) else ""

def text(v):
    if v is None: return ""
    return " ".join(str(v).split())

ws = openpyxl.load_workbook(sys.argv[1]).active
hlavicka = None
hry = []
for row in ws.iter_rows():
    hodnoty = [c.value for c in row]
    if hlavicka is None:
        if text(hodnoty[0]).lower() == "název": hlavicka = [text(h).lower() for h in hodnoty]
        continue
    nazev = text(hodnoty[0])
    if not nazev: continue
    sl = {h: row[i] for i, h in enumerate(hlavicka) if h}
    odkaz = lambda k: (sl[k].hyperlink.target if k in sl and sl[k].hyperlink else "")
    pridano = sl.get("datum přidání").value if "datum přidání" in sl else None
    h = {"nazev": nazev, "popis": text(sl["krátký popis"].value), "rozviji": text(sl["rozvíjí"].value),
         "varianty": text(sl["varianty a úpravy"].value), "pomucky": text(sl["pomůcky"].value),
         "web": web(nazev), "karta": bezpecny(odkaz("karta hry")), "lamin": bezpecny(odkaz("karty k laminování")),
         "video": bezpecny(odkaz("video") or text(sl["video"].value)),
         "pridano": pridano.date().isoformat() if isinstance(pridano, datetime.datetime) else ""}
    if nazev in STEJNE_JAKO: h["cinnost"] = STEJNE_JAKO[nazev]
    hry.append({k: v for k, v in h.items() if v})

out = {"popis": "Úvodní hry ze společné tabulky na školním Disku (Nápady na TV/Úvodní hry). Generuje uvodni-z-excelu.py, ručně neupravovat.",
       "hry": hry}
with open(sys.argv[2], "w", encoding="utf-8") as f:
    f.write(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
print(len(hry), "her")
