import json
import os
from pathlib import Path

import duckdb
from fastapi import HTTPException


TABLES = ("accidents", "roads", "rail_flows", "economy", "traffic", "activities", "tourism")


def snapshot() -> tuple[Path, dict]:
    root = Path(os.environ.get("CONVIA_DATA_DIR", "data")) / "processed"
    for folder in sorted(root.glob("goias-*"), reverse=True):
        try:
            manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
            if manifest["region"] == "GO" and all(
                (folder / f"{name}.parquet").is_file() for name in TABLES
            ):
                return folder, manifest
        except (OSError, ValueError, KeyError):
            continue
    raise HTTPException(503, "Recorte de Goiás ainda indisponível")


def query(folder: Path, table: str, sql: str, parameters: list | None = None) -> list[dict]:
    with duckdb.connect() as connection:
        connection.read_parquet(str(folder / f"{table}.parquet")).create_view("records")
        result = connection.execute(sql, parameters or [])
        columns = [column[0] for column in result.description]
        return [dict(zip(columns, row)) for row in result.fetchall()]
