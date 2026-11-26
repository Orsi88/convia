import hashlib
from importlib.metadata import version
import json
import os
import threading
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from pathlib import Path
from typing import Annotated, Literal

import duckdb
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from convia.results import query, snapshot

app = FastAPI(title="CONVIA", version=version("convia"))
web = Path(__file__).with_name("web")
app.mount("/assets", StaticFiles(directory=web), name="assets")


@app.get("/", include_in_schema=False)
def dashboard() -> FileResponse:
    return FileResponse(web / "index.html")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/meta")
def metadata() -> dict[str, str | None]:
    folder, manifest = snapshot()
    return {
        "database_version": folder.name,
        "model_version": None,
        "updated_at": manifest["created_at"],
    }


@app.get("/api/quality")
def quality() -> dict:
    folder, manifest = snapshot()
    return {"database_version": folder.name, **manifest}


@app.get("/api/overview")
def overview() -> dict:
    folder, manifest = snapshot()
    return {
        "database_version": folder.name,
        "region": manifest["region"],
        "counts": manifest["counts"],
        "reference_years": {
            source: entry["reference_year"] for source, entry in manifest["inputs"].items()
        },
        "common_period": manifest["quality"]["common_period"],
    }


UF = Annotated[str | None, Query(pattern=r"^[A-Z]{2}$")]


def filters(br: str | None = None, uf: str | None = None, bbox: str | None = None) -> tuple[str, list]:
    clauses, values = [], []
    if br:
        clauses.append("br = ?"); values.append(br)
    if uf:
        clauses.append("uf = ?"); values.append(uf)
    if bbox:
        west, south, east, north = map(float, bbox.split(","))
        clauses.append("longitude BETWEEN ? AND ? AND latitude BETWEEN ? AND ?")
        values += [west, east, south, north]
    return ("WHERE " + " AND ".join(clauses)) if clauses else "", values


@app.get("/api/safety/summary")
def safety_summary(br: Annotated[str | None, Query(pattern=r"^\d{3}$")] = None, uf: UF = None) -> dict:
    folder, manifest = snapshot()
    where, values = filters(br, uf)
    rows = query(
        folder, "accidents",
        f"SELECT count(*) AS accidents, sum(mortos) AS deaths, sum(feridos) AS injured FROM records {where}",
        values,
    )
    return {
        "database_version": folder.name,
        "reference_year": manifest["inputs"]["prf"]["reference_year"],
        "source": "PRF", "br": br, **rows[0],
    }


@app.get("/api/roads")
def roads(
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict:
    return page("roads", limit, offset)


@app.get("/api/rail/flows")
def rail_flows(
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict:
    return page("rail_flows", limit, offset)


def page(table: str, limit: int, offset: int) -> dict:
    folder, manifest = snapshot()
    order = {"roads": "ID", "rail_flows": "Mes_Ano, Ferrovia, Estacao_Origem, Estacao_Destino, Mercadoria_ANTT"}
    return {
        "database_version": folder.name,
        "total": manifest["counts"][table],
        "limit": limit, "offset": offset,
        "items": query(folder, table, f"SELECT * FROM records ORDER BY {order[table]} LIMIT ? OFFSET ?", [limit, offset]),
    }


@app.get("/api/economy/summary")
def economy_summary(uf: UF = None) -> dict:
    folder, manifest = snapshot()
    where, values = filters(uf=uf)
    return {
        "database_version": folder.name,
        "reference_year": manifest["inputs"]["ibge"]["reference_year"],
        "source": "IBGE", "indicator": "PIB municipal",
        "items": query(folder, "economy", f"SELECT * FROM records {where} ORDER BY ibge_code", values),
    }


@app.get("/api/cargo/flow")
def cargo_flow(
    origin: Annotated[str, Query(pattern=r"^52[0-9]{5}$")],
    destination: Annotated[str, Query(pattern=r"^[0-9]{7}$")],
) -> dict:
    path = Path(os.environ.get("CONVIA_DATA_DIR", "data")) / "processed" / "pnl-go-2023.csv"
    result = {"reference_year": 2023, "source": "Infra S.A. · PNL 2050", "tonnes": None, "product": None}
    if not path.is_file():
        return {**result, "coverage": "unavailable"}
    with duckdb.connect() as connection:
        row = connection.execute(
            """SELECT tonnes, product FROM read_csv(?, header=true, auto_detect=false,
                 columns={'origin':'VARCHAR','destination':'VARCHAR','tonnes':'DOUBLE','product':'VARCHAR'})
                 WHERE origin = ? AND destination = ?""",
            [str(path), origin, destination],
        ).fetchone()
    if row is None:
        return {**result, "coverage": "absent"}
    return {**result, "coverage": "present", "tonnes": row[0], "product": row[1] if row[0] > 0 else None}


@app.get("/api/traffic")
def traffic() -> dict:
    folder, manifest = snapshot()
    return {
        "database_version": folder.name,
        "reference_year": manifest["inputs"]["dnit"]["reference_year"],
        "source": "DNIT · VMDa por trecho do SNV",
        "items": query(folder, "traffic", "SELECT * FROM records ORDER BY uf, br"),
    }


@app.get("/api/regiao")
def region(codes: Annotated[str, Query(pattern=r"^\d{7}(,\d{7})*$")]) -> dict:
    """Perfil dos municípios do trajeto: PIB e setores (IBGE), atividades (CEMPRE) e turismo (MTur)."""
    folder, manifest = snapshot()
    wanted = codes.split(",")
    if len(wanted) > 300:
        raise HTTPException(422, "Consulte no máximo 300 municípios por vez")
    marks = ",".join("?" * len(wanted))
    economy = query(folder, "economy", f"SELECT * FROM records WHERE ibge_code IN ({marks})", wanted)
    activities = query(
        folder, "activities",
        f"SELECT * FROM records WHERE ibge_code IN ({marks}) ORDER BY ibge_code, workers DESC NULLS LAST", wanted,
    )
    tourism = query(folder, "tourism", f"SELECT * FROM records WHERE ibge_code IN ({marks})", wanted)
    items = {row["ibge_code"]: {**row, "activities": [], "tourism": None} for row in economy}
    for row in activities:
        if row["ibge_code"] in items:
            items[row["ibge_code"]]["activities"].append(row)
    for row in tourism:
        if row["ibge_code"] in items:
            items[row["ibge_code"]]["tourism"] = row
    years = {source: entry["reference_year"] for source, entry in manifest["inputs"].items()}
    return {
        "database_version": folder.name,
        "sources": {
            "economy": f"IBGE · PIB dos Municípios {years['ibge']} (setores de 2021)",
            "activities": f"IBGE · CEMPRE {years['cempre']}",
            "tourism": f"MTur · Categorização do Mapa do Turismo {years['turismo']}",
        },
        "items": [items[code] for code in wanted if code in items],
    }


GDELT = "https://api.gdeltproject.org/api/v2/doc/doc"
NEWS_TTL = 6 * 3600  # segundos
NEWS_TOPICS = {
    "seguranca": "(acidente OR rodovia OR trânsito)",
    "rodovias": "(rodovia OR obras OR duplicação OR concessão)",
    "economia": "(economia OR indústria OR agronegócio OR empregos OR turismo)",
}
_news_lock = threading.Lock()
_news_last = [0.0]


@app.get("/api/noticias")
def news(
    terms: Annotated[str, Query(min_length=2, max_length=300)],
    topic: Literal["seguranca", "rodovias", "economia"] | None = None,
) -> dict:
    """Notícias recentes em português via GDELT, com cache em disco e no máximo 1 consulta a cada 5 s."""
    names = [term.strip() for term in terms.split("|") if term.strip()][:8]
    if not names or any('"' in name or len(name) > 60 for name in names):
        raise HTTPException(422, "Termos inválidos")
    query = "(" + " OR ".join(f'"{name}"' for name in names) + ")" if len(names) > 1 else f'"{names[0]}"'
    query += (" " + NEWS_TOPICS[topic] if topic else "") + " sourcelang:portuguese"
    cache = Path(os.environ.get("CONVIA_DATA_DIR", "data")) / "cache" / "noticias"
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / (hashlib.sha256(query.encode()).hexdigest()[:24] + ".json")
    if path.is_file() and time.time() - path.stat().st_mtime < NEWS_TTL:
        return json.loads(path.read_text(encoding="utf-8"))
    url = GDELT + "?" + urlencode({"query": query, "mode": "artlist", "maxrecords": 10, "format": "json",
                                   "timespan": "3months", "sort": "datedesc"})
    try:
        with _news_lock:
            time.sleep(max(0.0, 5.5 - (time.time() - _news_last[0])))
            _news_last[0] = time.time()
            with urlopen(Request(url, headers={"User-Agent": "CONVIA-academic-project"}), timeout=30) as response:
                payload = json.loads(response.read().decode("utf-8") or "{}")
    except (OSError, ValueError):
        # GDELT limita consultas e às vezes devolve texto em vez de JSON: usa o último resultado guardado.
        if path.is_file():
            return {**json.loads(path.read_text(encoding="utf-8")), "stale": True}
        return {"source": "GDELT", "query": query, "items": [], "unavailable": True}
    items = [{"title": item.get("title"), "url": item.get("url"), "domain": item.get("domain"),
              "date": item.get("seendate"), "image": item.get("socialimage")}
             for item in payload.get("articles", []) if item.get("url", "").startswith("https://")]
    result = {"source": "GDELT", "query": query, "items": items}
    if items:  # resposta vazia pode ser limite do GDELT: não guarda, tenta de novo na próxima visita
        path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    elif path.is_file():
        return {**json.loads(path.read_text(encoding="utf-8")), "stale": True}
    return result


@app.get("/api/ferrovias-mundo")
def world_railways() -> dict:
    """Casos de referência levantados com fontes abertas (conteúdo curado, versionado no repositório)."""
    return json.loads((web / "ferrovias-mundo.json").read_text(encoding="utf-8"))


@app.get("/api/cargo/pairs")
def cargo_pairs() -> dict:
    path = Path(os.environ.get("CONVIA_DATA_DIR", "data")) / "processed" / "pares-go.json"
    if not path.is_file():
        raise HTTPException(503, "Pares sugeridos ainda indisponíveis")
    return json.loads(path.read_text(encoding="utf-8"))


@app.get("/api/corridors/norte-sul")
def corridor_norte_sul() -> dict:
    path = Path(os.environ.get("CONVIA_DATA_DIR", "data")) / "processed" / "corredor-norte-sul.json"
    if not path.is_file():
        raise HTTPException(503, "Soma do corredor ainda indisponível: rode python -m convia.corridor")
    return json.loads(path.read_text(encoding="utf-8"))


@app.get("/api/map/layers")
def map_layers() -> list[dict]:
    _, manifest = snapshot()
    return [{"id": "accidents", "name": "Acidentes PRF", "format": "GeoJSON",
             "reference_year": manifest["inputs"]["prf"]["reference_year"]}]


@app.get("/api/map/{layer}")
def map_data(
    layer: Literal["accidents"],
    br: Annotated[str | None, Query(pattern=r"^\d{3}$")] = None,
    uf: UF = None,
    bbox: Annotated[str | None, Query(pattern=r"^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$")] = None,
) -> dict:
    folder, manifest = snapshot()
    where, values = filters(br, uf, bbox)
    rows = query(folder, "accidents", f"SELECT * FROM records {where} ORDER BY id", values)
    valid = [row for row in rows if row["latitude"] is not None and row["longitude"] is not None
             and -90 <= row["latitude"] <= 90 and -180 <= row["longitude"] <= 180]
    return {
        "type": "FeatureCollection", "database_version": folder.name,
        "reference_year": manifest["inputs"]["prf"]["reference_year"],
        "omitted_coordinates": len(rows) - len(valid),
        "features": [
            {"type": "Feature", "id": row["id"],
             "geometry": {"type": "Point", "coordinates": [row["longitude"], row["latitude"]]},
             "properties": row}
            for row in valid
        ],
    }


@app.get("/api/sources")
def sources() -> list[dict[str, str]]:
    return [
        {
            "name": "PRF — BAT — Acidentes de Trânsito",
            "url": "https://www.gov.br/prf/pt-br/acesso-a-informacao/dados-abertos/dados-abertos-da-prf",
        },
        {
            "name": "DNIT — PNCT — Contagem de Tráfego",
            "url": "https://www.gov.br/dnit/pt-br/assuntos/planejamento-e-pesquisa/planejamento/contagem-de-trafego/pnct",
        },
        {
            "name": "DNIT — Estatísticas PNCT",
            "url": "https://www.gov.br/dnit/pt-br/assuntos/planejamento-e-pesquisa/planejamento/contagem-de-trafego/estatisticas",
        },
        {
            "name": "ANTT — SIADE — Produção Origem-Destino",
            "url": "https://dados.antt.gov.br/dataset/sistema-de-acompanhamento-do-desempenho-operacional-das-concessionarias-siade",
        },
        {
            "name": "IBGE — PIB dos Municípios",
            "url": "https://www.ibge.gov.br/estatisticas/economicas/contas-nacionais/9088-produto-interno-bruto-dos-municipios.html",
        },
        {
            "name": "IBGE/SIDRA — Produção e população",
            "url": "https://sidra.ibge.gov.br/",
        },
        {
            "name": "ANTAQ — Dados Abertos / Estatístico Aquaviário",
            "url": "https://www.gov.br/antaq/pt-br/acesso-a-informacao/dados-abertos",
        },
        {
            "name": "Infra S.A./ONTL — Observatório de Transporte e Logística",
            "url": "https://ontl.infrasa.gov.br/",
        },
    ]
