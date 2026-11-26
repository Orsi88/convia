"""Soma a carga de Goiás que o corredor da Ferrovia Norte-Sul poderia captar.

Uso: python -m convia.corridor
Lê data/processed/pnl-go-2023.csv e pnl-go-export-2023.csv (scripts/prepare_pnl.py) e, quando coletados,
o Comex Stat (python -m convia.collect comex e comex-urf) para estimar o porto de saída das exportações.
Grava data/processed/corredor-norte-sul.json.
"""

from collections import defaultdict
import csv
import json
import math
from pathlib import Path
import re
import time
from urllib.request import Request, urlopen

from convia.prepare import latest

RADIUS_KM = 100  # decisão do usuário em 25/11/2026
# Terminais da Rumo Malha Central em Goiás citados na imprensa; a ANTT não publica a lista de pátios (pendência).
TERMINALS = {"5201108": "Anápolis", "5218805": "Rio Verde", "5220405": "São Simão"}
# Pontos de chegada: fim da Malha Central (Estrela d'Oeste), porto de Santos pela Malha Paulista,
# fim norte da Malha Central (Porto Nacional) e porto do Itaqui (São Luís) pela Norte-Sul e Carajás.
NODES = {"3515202": "Estrela d'Oeste (SP)", "3548500": "Santos (SP)", "1718204": "Porto Nacional (TO)",
         "2111300": "São Luís (MA)"}
# Unidade da Receita de despacho (Comex Stat) → ponto de chegada das exportações.
PORTS = {"3548500": re.compile(r"PORTO DE SANTOS"), "2111300": re.compile(r"S[AÃ]O LU[IÍ]S|ITAQUI")}
PROCESSED = Path("data/processed")
WEB = Path(__file__).parent / "web"


def straight_km(a: list[float], b: list[float]) -> float:
    (lon1, lat1), (lon2, lat2) = (map(math.radians, point) for point in (a, b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


def nearest(code: str, targets: dict, places: dict) -> str | None:
    """Ponto de `targets` mais perto da sede de `code`, se estiver a até RADIUS_KM em linha reta."""
    if code not in places:
        return None
    distance, target = min((straight_km(places[code], places[t]), t) for t in targets)
    return target if distance <= RADIUS_KM else None


def port_shares(comex: Path, urfs: Path, sh_macro: dict[int, str]) -> tuple[dict, dict]:
    """Participação de cada ponto de chegada nas exportações de GO, por macroproduto (kg líquidos)."""
    with urfs.open(encoding="latin-1", newline="") as file:
        names = {row["CO_URF"]: row["NO_URF"] for row in csv.DictReader(file, delimiter=";")}
    node_of = {urf: node for urf, name in names.items() for node, pattern in PORTS.items() if pattern.search(name.upper())}
    total, by_node = defaultdict(float), defaultdict(float)
    with comex.open(encoding="latin-1", newline="") as file:
        for row in csv.DictReader(file, delimiter=";"):
            if row["SG_UF_NCM"] != "GO":
                continue
            ncm = row["CO_NCM"].zfill(8)
            product = sh_macro.get(int(ncm[:4])) or sh_macro.get(int(ncm[:2]))
            if not product:
                continue
            kg = float(row["KG_LIQUIDO"])
            total[product] += kg
            if row["CO_URF"] in node_of:
                by_node[product, node_of[row["CO_URF"]]] += kg
    shares = {key: kg / total[key[0]] for key, kg in by_node.items() if total[key[0]]}
    return shares, {urf: names[urf] for urf in node_of}


def corridor(domestic: list[dict], exports: list[dict], places: dict, shares: dict | None) -> dict:
    """Agrupa por terminal de Goiás e ponto de chegada. Sem `shares`, a exportação fica sem porto."""
    groups = defaultdict(lambda: {"tonnes": 0.0, "products": defaultdict(float)})
    unallocated = defaultdict(float)
    catchment = {code: nearest(code, TERMINALS, places) for code in places if code.startswith("52")}
    for row in domestic:
        terminal = catchment.get(row["origin"])
        node = terminal and nearest(row["destination"], NODES, places)
        if node and not catchment.get(row["destination"]):  # destino dentro da própria área de captação não usa trem
            group = groups[terminal, node, "interno"]
            group["tonnes"] += row["tonnes"]
            group["products"][row["product"]] += row["tonnes"]
    for row in exports:
        terminal = catchment.get(row["origin"])
        if not terminal:
            continue
        allocated = 0.0
        for node in PORTS:
            share = (shares or {}).get((row["product"], node), 0.0)
            if share:
                group = groups[terminal, node, "exportação"]
                group["tonnes"] += row["tonnes"] * share
                group["products"][row["product"]] += row["tonnes"] * share
                allocated += row["tonnes"] * share
        unallocated[terminal] += row["tonnes"] - allocated
    return {
        "groups": [
            {"terminal": TERMINALS[t], "terminal_id": t, "node": NODES[n], "node_id": n, "kind": kind,
             "tonnes": round(g["tonnes"], 3),
             "products": [p for p, _ in sorted(g["products"].items(), key=lambda item: -item[1])[:3]]}
            for (t, n, kind), g in sorted(groups.items(), key=lambda item: -item[1]["tonnes"])
        ],
        "exports_other_ports": {TERMINALS[t]: round(v, 3) for t, v in unallocated.items() if v > 0.5},
        "origins": sum(1 for v in catchment.values() if v),
    }


def road_km(a: list[float], b: list[float]) -> float | None:
    url = ("https://routing.openstreetmap.de/routed-car/route/v1/driving/"
           f"{a[0]},{a[1]};{b[0]},{b[1]}?overview=false&generate_hints=false")
    with urlopen(Request(url, headers={"User-Agent": "CONVIA-academic-project"}), timeout=30) as response:
        routes = json.load(response).get("routes") or []
    return round(routes[0]["distance"] / 1000, 1) if routes else None


def sh_to_macro(dictionary: Path) -> dict[int, str]:
    import openpyxl

    sheet = openpyxl.load_workbook(dictionary, read_only=True)["SH por macroproduto"]
    return {int(code): macro for macro, _, code, *_ in sheet.iter_rows(min_row=2, values_only=True) if code is not None}


def main() -> None:
    places = {str(town["id"]): town["coordinates"]
              for town in json.loads((WEB / "municipios-br.json").read_text(encoding="utf-8"))}
    with (PROCESSED / "pnl-go-2023.csv").open(encoding="utf-8", newline="") as file:
        domestic = [{**row, "tonnes": float(row["tonnes"])} for row in csv.DictReader(file)]
    with (PROCESSED / "pnl-go-export-2023.csv").open(encoding="utf-8", newline="") as file:
        exports = [{**row, "tonnes": float(row["tonnes"])} for row in csv.DictReader(file)]
    raw = Path("data/raw")
    try:
        comex, comex_entry = latest(raw, "comex", "EXP_2023.csv")
        urfs, _ = latest(raw, "comex-urf", "URF.csv")
        shares, ports = port_shares(comex, urfs, sh_to_macro(raw / "infrasa" / "dicionario.xlsx"))
    except ValueError as error:
        print(f"Exportações sem porto estimado: {error}")
        shares, ports, comex_entry = None, {}, None
    result = corridor(domestic, exports, places, shares)
    distances = {}
    for terminal in TERMINALS:
        for node in NODES:
            time.sleep(1)
            distances[f"{terminal}-{node}"] = road_km(places[terminal], places[node])
    for group in result["groups"]:
        group["km"] = distances[f"{group['terminal_id']}-{group['node_id']}"]
    (PROCESSED / "corredor-norte-sul.json").write_text(json.dumps({
        "corridor": "Ferrovia Norte-Sul (Rumo Malha Central e Malha Paulista; Itaqui pela Norte-Sul e Carajás)",
        "reference_year": 2023, "radius_km": RADIUS_KM, "terminals": list(TERMINALS.values()),
        "nodes": list(NODES.values()), **result,
        "ports_estimated": shares is not None, "port_units": ports,
        "comex": comex_entry and {"url": comex_entry["url"], "collected_at": comex_entry["collected_at"]},
        "source": "Infra S.A. · PNL 2050, base 2023 · Comex Stat (MDIC) · distância OSRM/OpenStreetMap",
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    total = sum(group["tonnes"] for group in result["groups"])
    print(f"{result['origins']} origens · {len(result['groups'])} grupos · {total / 1e6:.2f} mi t no corredor")


if __name__ == "__main__":
    main()
