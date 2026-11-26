"""Prepare the CONVIA snapshot (origin in Goiás, destination anywhere in Brazil) from verified raw inputs."""

import csv
from datetime import UTC, datetime
import hashlib
import io
import json
import math
import re
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile

import duckdb
from openpyxl import load_workbook


def latest(root: Path, source: str, filename: str) -> tuple[Path, dict]:
    manifests = []
    for path in (root / source).glob("*/manifest.json"):
        entry = json.loads(path.read_text(encoding="utf-8"))
        if entry["filename"] == filename:
            manifests.append((entry["collected_at"], path, entry))
    if not manifests:
        raise ValueError(f"Coleta ausente: {source}/{filename}")
    _, manifest, entry = max(manifests, key=lambda item: item[0])
    path = manifest.with_name(filename)
    if hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
        raise ValueError(f"Arquivo bruto alterado: {path}")
    return path, entry


def volumes(segments: list[dict]) -> list[dict]:
    """VMDa médio por UF e BR, ponderado pela extensão, somando os dois sentidos.

    Classes do DNIT: A a H são ônibus e veículos de carga (E a H, combinações de 6 a 9 eixos),
    I são veículos de passeio e J, motocicletas.
    """
    totals = {}
    for row in segments:
        length = row["vl_extensa"] or 0
        if not length or row["VMDa_C"] is None or not row["vl_br"]:
            continue
        key = (row["sg_uf"], str(row["vl_br"]).zfill(3))
        count = lambda classes: sum((row[f"{c}_C"] or 0) + (row[f"{c}_D"] or 0) for c in classes)
        item = totals.setdefault(key, [0.0, 0.0, 0.0])
        item[0] += length
        item[1] += count("ABCDEFGH") * length
        item[2] += count("EFGH") * length
    return [
        {"uf": uf, "br": br, "km": round(length, 1),
         "commercial": round(commercial / length), "heavy": round(heavy / length)}
        for (uf, br), (length, commercial, heavy) in sorted(totals.items())
    ]


def prepare(root: Path = Path("data")) -> Path:
    inputs = {}
    prf, inputs["prf"] = latest(root / "raw", "prf", "datatran2025.zip")
    with ZipFile(prf) as archive, archive.open("datatran2025.csv") as stream:
        # Nacional: as rotas saem de Goiás e atravessam outros estados.
        accidents = list(csv.DictReader(io.TextIOWrapper(stream, encoding="latin-1"), delimiter=";"))
    seen = set()
    for row in accidents:
        if row["id"] in seen:
            raise ValueError(f"Ocorrência duplicada na PRF: {row['id']}")
        seen.add(row["id"])
        if datetime.strptime(row["data_inversa"], "%Y-%m-%d").year != 2025:
            raise ValueError("Ocorrência fora do ano de referência")
        for key in ("km", "latitude", "longitude"):
            row[key] = float(row[key].replace(",", ".")) if row[key].strip() else None
            if row[key] is not None and not math.isfinite(row[key]):
                raise ValueError(f"Valor não finito na PRF: {key}")
        for key in ("mortos", "feridos", "pessoas", "veiculos"):
            row[key] = int(row[key]) if row[key].strip() else None
        row["br"] = row["br"].zfill(3) if row["br"].strip() else None

    antt, inputs["antt"] = latest(root / "raw", "antt", "producao_origem_destino_2025.csv")
    with antt.open(encoding="latin-1", newline="") as stream:
        flows = [
            row for row in csv.DictReader(stream, delimiter=";")
            if row["UF_Origem"] == "GO" or row["UF_Destino"] == "GO"
        ]
    dnit, inputs["dnit"] = latest(root / "raw", "dnit", "vmda2022_snv_202301b.xlsx")
    workbook = load_workbook(dnit, read_only=True, data_only=True)
    try:
        rows = workbook["SNV202301B"].iter_rows(values_only=True)
        header = next(rows)
        segments = [dict(zip(header, row)) for row in rows]
    finally:
        workbook.close()
    roads = [row for row in segments if row["sg_uf"] == "GO"]
    traffic = volumes(segments)
    ibge, inputs["ibge"] = latest(root / "raw", "ibge", "pib_brasil_2023.json")
    fields = {"37": "value", "513": "agro", "517": "industry", "6575": "services", "525": "public", "543": "taxes"}
    towns = {}
    for variable in json.loads(ibge.read_bytes()):
        for result in variable["resultados"]:
            for item in result["series"]:
                locality = item["localidade"]
                match = re.search(r"(?: - |\()([A-Z]{2})\)?$", locality["nome"])  # "Nome - GO" ou "Nome (GO)"
                if not match:
                    raise ValueError(f"UF ausente no nome do município: {locality['nome']}")
                row = towns.setdefault(locality["id"], {
                    "ibge_code": locality["id"], "municipality": locality["nome"], "uf": match.group(1),
                    "year": 2023, "sector_year": 2021, "unit": "Mil Reais", **{field: None for field in fields.values()},
                })
                # PIB total de 2023; setores e impostos de 2021, último ano publicado pelo IBGE.
                raw = item["serie"]["2023" if variable["id"] == "37" else "2021"]
                row[fields[variable["id"]]] = float(raw) if raw not in ("", "-", "...", "..", "X") else None
    economy = list(towns.values())

    cempre, inputs["cempre"] = latest(root / "raw", "cempre", "cempre_2024.json")
    activity = {}
    for variable in json.loads(cempre.read_bytes()):
        key = {"707": "workers", "706": "units"}[variable["id"]]
        for result in variable["resultados"]:
            [(category, name)] = result["classificacoes"][0]["categoria"].items()
            section = "Total" if name == "Total" else name.split(" ", 1)[0]
            for item in result["series"]:
                raw = item["serie"]["2024"]
                row = activity.setdefault((item["localidade"]["id"], section), {
                    "ibge_code": item["localidade"]["id"], "section": section,
                    "activity": name if name == "Total" else name.split(" ", 1)[1], "workers": None, "units": None,
                })
                # "X" é dado sigiloso; "-" é zero absoluto.
                row[key] = 0 if raw == "-" else float(raw) if raw not in ("", "...", "..", "X") else None
    activities = list(activity.values())

    tourism_file, inputs["turismo"] = latest(root / "raw", "turismo", "categorizacao_turismo_2017.csv")
    with tourism_file.open(encoding="latin-1", newline="") as stream:
        number = lambda text: float(text.replace(".", "").replace(",", ".")) if text.strip() else None
        tourism = [{
            "ibge_code": row["Código Município"].strip(), "uf": row["UF"].strip(),
            "tourism_region": row["Região"].strip(), "category": row["Cluster 2017 (Categoria)"].strip(),
            "lodging_jobs": number(row["Qtd. Empregos Hospedagem"]),
            "lodging_places": number(row["Qtd. Estabelecimentos Hospedagem"]),
            "international_demand": number(row["Demanda Internacional"]),
            "domestic_demand": number(row["Demanda Doméstica"]),
        } for row in csv.DictReader(stream, delimiter=";")]
    datasets = {"accidents": accidents, "rail_flows": flows, "roads": roads, "economy": economy, "traffic": traffic,
                "activities": activities, "tourism": tourism}
    if any(not rows for rows in datasets.values()):
        raise ValueError("Uma das bases está vazia no recorte")
    if len({row["ibge_code"] for row in economy}) != len(economy):
        raise ValueError("PIB com municípios duplicados")
    published = root / "processed"
    published.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(UTC)
    folder = published / timestamp.strftime("goias-%Y%m%dT%H%M%S%fZ")
    with TemporaryDirectory(dir=published) as staging:
        stage = Path(staging)
        with duckdb.connect() as connection:
            for name, records in datasets.items():
                path = stage / f"{name}.json"
                path.write_text(json.dumps(records, ensure_ascii=False, allow_nan=False), encoding="utf-8")
                connection.read_json(str(path)).write_parquet(str(stage / f"{name}.parquet"))
                count = connection.read_parquet(str(stage / f"{name}.parquet")).count("*").fetchall()[0][0]
                if count != len(records):
                    raise ValueError(f"Contagem divergente no Parquet: {name}")
                path.unlink()
        (stage / "manifest.json").write_text(json.dumps({
            "region": "GO",
            "scope": "Origem em Goiás, destino em qualquer município do Brasil",
            "created_at": timestamp.isoformat(),
            "inputs": inputs,
            "counts": {name: len(rows) for name, rows in datasets.items()},
            "quality": {
                "missing_coordinates": sum(row["latitude"] is None or row["longitude"] is None for row in accidents),
                "missing_road": sum(row["br"] is None for row in accidents),
                "common_period": None,
                "notes": [
                    "PRF e ANTT 2025, DNIT 2022 e PIB 2023. Integração temporal pendente.",
                    "Acidentes da PRF e PIB do IBGE cobrem o Brasil. Trechos do DNIT seguem só em Goiás.",
                    "Volume de tráfego: VMDa 2022 do DNIT, média por UF e BR ponderada pela extensão (classes A a H).",
                    "Atividades: CEMPRE 2024 (IBGE, tabela 9510), pessoal ocupado e unidades locais por seção da CNAE; X = sigiloso.",
                    "PIB municipal total de 2023; valor adicionado por setor de 2021, último ano publicado.",
                    "Turismo: categorização do Mapa do Turismo de 2017, último arquivo aberto do MTur.",
                    "Fluxos ferroviários incluem origem ou destino em Goiás.",
                    "Municípios da PRF permanecem identificados pelo nome da fonte. Associação IBGE pendente.",
                    "TU e TKU preservados no formato original da ANTT. Conversão numérica pendente.",
                ],
            },
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        stage.rename(folder)
    return folder


if __name__ == "__main__":
    print(prepare())
