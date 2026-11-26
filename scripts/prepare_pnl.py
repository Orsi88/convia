"""Prepare cargo flows leaving Goiás (domestic and exports), the municipality list and the suggested long pairs.

Uso: python scripts/prepare_pnl.py data/raw/infrasa/matrizes_empilhadas.rds data/raw/ibge/localidades.gpkg
Requer o extra "prep" (pyreadr e polars) só para ler o RDS da Infra S.A.
"""

import csv
import json
import math
from pathlib import Path
import sqlite3
import sys
import time
from urllib.request import Request, urlopen

MIN_KM = 300  # recorte confirmado: pares a partir de 300 km rodoviários
PAIRS = 40
PROCESSED = Path("data/processed")
WEB = Path("src/convia/web")


def municipalities(gpkg: Path) -> list[dict]:
    with sqlite3.connect(gpkg) as connection:
        rows = connection.execute(
            # Sedes municipais, capitais (Brasília entra como Capital Federal) e o distrito de Fernando de Noronha.
            "SELECT CD_MUN, NM_MUN, SIGLA_UF, LONG_LOCALIDADE, LAT_LOCALIDADE FROM BR_localidades_2022 "
            "WHERE CT_LOCALIDADE = 'Cidade' OR CT_LOCALIDADE LIKE 'Distrito Estadual%' "
            "GROUP BY CD_MUN ORDER BY CD_MUN"  # capitais estaduais aparecem como sede e como capital
        ).fetchall()
    towns = [{"id": int(code), "name": name, "uf": uf, "coordinates": [round(lon, 6), round(lat, 6)]}
             for code, name, uf, lon, lat in rows]
    if len({town["id"] for town in towns}) != len(towns) or len(towns) < 5500:
        raise ValueError("Sedes municipais incompletas ou duplicadas")
    return towns


def flows(rds: Path) -> tuple[list[dict], list[dict]]:
    """Pares entre municípios (com o macroproduto de maior carga) e exportações por macroproduto."""
    import polars as pl
    import pyreadr

    matrix = next(iter(pyreadr.read_r(str(rds), output_format="polars").values()))
    # A matriz registra a exportação com destino numa zona externa (continente ou país), sem o porto de saída.
    exports = matrix.filter(
        pl.col("mun_origem").str.contains(r"^52\d{5}$") & ~pl.col("mun_destino").str.contains(r"^\d{7}$")
        & pl.col("toneladas").is_finite() & (pl.col("toneladas") > 0)
    ).group_by(origin="mun_origem", product=pl.col("macro_produto").fill_null("Sem produto identificado")).agg(
        pl.col("toneladas").sum().round(3).alias("tonnes")).sort("origin", "product").to_dicts()
    keep = matrix.filter(
        pl.col("mun_origem").str.contains(r"^52\d{5}$") & pl.col("mun_destino").str.contains(r"^\d{7}$")
        & (pl.col("mun_origem") != pl.col("mun_destino"))
        & pl.col("toneladas").is_finite() & (pl.col("toneladas") >= 0)
    ).select(
        origin="mun_origem", destination="mun_destino", tonnes="toneladas",
        product=pl.col("macro_produto").fill_null("Sem produto identificado"),
    )
    by_product = keep.group_by("origin", "destination", "product").agg(pl.col("tonnes").sum())
    leaders = (by_product.sort(["tonnes", "product"], descending=[True, False])
               .unique(["origin", "destination"], keep="first").select("origin", "destination", "product"))
    totals = by_product.group_by("origin", "destination").agg(pl.col("tonnes").sum().round(3))
    return totals.join(leaders, on=["origin", "destination"]).sort("origin", "destination").to_dicts(), exports


def straight_km(a: list[float], b: list[float]) -> float:
    (lon1, lat1), (lon2, lat2) = (map(math.radians, point) for point in (a, b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


def road_km(a: list[float], b: list[float]) -> float | None:
    url = ("https://routing.openstreetmap.de/routed-car/route/v1/driving/"
           f"{a[0]},{a[1]};{b[0]},{b[1]}?overview=false&generate_hints=false")
    with urlopen(Request(url, headers={"User-Agent": "CONVIA-academic-project"}), timeout=30) as response:
        routes = json.load(response).get("routes") or []
    return round(routes[0]["distance"] / 1000, 1) if routes else None


def main(rds: Path, gpkg: Path) -> None:
    towns = municipalities(gpkg)
    places = {str(town["id"]): town for town in towns}
    rows, exports = flows(rds)
    unknown = {row["destination"] for row in rows} - places.keys()
    if unknown:
        raise ValueError(f"Destinos sem sede municipal: {sorted(unknown)[:5]}")
    PROCESSED.mkdir(parents=True, exist_ok=True)
    with (PROCESSED / "pnl-go-2023.csv.tmp").open("w", encoding="utf-8", newline="") as output:
        writer = csv.DictWriter(output, ["origin", "destination", "tonnes", "product"])
        writer.writeheader()
        writer.writerows(rows)
    (PROCESSED / "pnl-go-2023.csv.tmp").replace(PROCESSED / "pnl-go-2023.csv")
    with (PROCESSED / "pnl-go-export-2023.csv.tmp").open("w", encoding="utf-8", newline="") as output:
        writer = csv.DictWriter(output, ["origin", "product", "tonnes"])
        writer.writeheader()
        writer.writerows(exports)
    (PROCESSED / "pnl-go-export-2023.csv.tmp").replace(PROCESSED / "pnl-go-export-2023.csv")
    (WEB / "municipios-br.json").write_text(
        "[\n" + ",\n".join(json.dumps(town, ensure_ascii=False) for town in towns) + "\n]\n", encoding="utf-8")

    # ponytail: OSRM público só nos maiores pares; a reta de 200 km descarta de saída os que não chegam a 300 km pela estrada.
    pairs = []
    for row in sorted(rows, key=lambda item: -item["tonnes"]):
        a, b = places[row["origin"]]["coordinates"], places[row["destination"]]["coordinates"]
        if straight_km(a, b) < MIN_KM * 2 / 3:
            continue
        time.sleep(1)
        km = road_km(a, b)
        if km is not None and km >= MIN_KM:
            pairs.append({**row, "km": km})
            if len(pairs) == PAIRS:
                break
    (PROCESSED / "pares-go.json").write_text(json.dumps({
        "reference_year": 2023, "source": "Infra S.A. · PNL 2050 · distância OSRM/OpenStreetMap",
        "min_km": MIN_KM, "items": pairs,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(rows)} pares com origem em GO · {len(exports)} fluxos de exportação · {len(towns)} municípios · "
          f"{len(pairs)} pares sugeridos")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))
