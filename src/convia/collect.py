"""Collect official CONVIA inputs without changing existing raw files."""

import argparse
import csv
from datetime import UTC, datetime
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlencode
from urllib.request import urlopen
from zipfile import BadZipFile, ZipFile


PRF = "https://drive.google.com/uc?export=download&id=1-G3MdmHBt6CprDwcW99xxC4BZ2DU5ryR"
ANTT = (
    "https://dados.antt.gov.br/dataset/438a5184-09db-49a3-88c8-0bad418b4409/"
    "resource/d7263808-bd77-4153-9910-49e041d73b21/download/producao_origem_destino_2025.csv"
)
# IBGE CEMPRE 2024, tabela 9510: pessoal ocupado (707) e unidades locais (706) por seção da CNAE 2.0, todos os municípios.
CNAE_SECTIONS = (
    "117897,116830,116880,116910,117296,117307,117329,117363,117484,117543,117555,"
    "117608,117666,117673,117714,117774,117788,117810,117838,117861,117888,117892"
)
CEMPRE = (
    "https://servicodados.ibge.gov.br/api/v3/agregados/9510/periodos/2024/variaveis/707|706"
    f"?localidades=N6[all]&classificacao=12762[{CNAE_SECTIONS}]"
)
# Ministério do Turismo, categorização dos municípios do Mapa do Turismo (2017, último arquivo aberto).
TURISMO = (
    "https://dados.turismo.gov.br/dataset/bc4166b3-a1ae-4d00-9e1a-05e9c4e1068d/resource/"
    "07c4f97a-888f-4ab7-ad2e-d5f040d627a0/download/2017-categorizacao-v2.csv"
)
DNIT = (
    "https://servicos.dnit.gov.br/dadosabertos/dataset/74588ac0-4170-4b51-b642-164a84110955/"
    "resource/7154cb44-9425-446f-b86b-b0f91956e7bb/download/vmda2022_snv_202301b.xlsx"
)

# Comex Stat (MDIC): exportações por NCM, UF e unidade da Receita de despacho (porto), e a tabela dessas unidades.
COMEX = "https://balanca.economia.gov.br/balanca/bd/comexstat-bd/ncm/EXP_2023.csv"
COMEX_URF = "https://balanca.economia.gov.br/balanca/bd/tabelas/URF.csv"


def validate(path: Path, source: str, year: int) -> None:
    if source == "prf":
        with ZipFile(path) as archive:
            if "datatran2025.csv" not in archive.namelist() or archive.testzip():
                raise ValueError("ZIP da PRF inválido")
    elif source == "dnit":
        with ZipFile(path) as archive:
            if "xl/workbook.xml" not in archive.namelist() or archive.testzip():
                raise ValueError("Planilha do DNIT inválida")
    elif source == "turismo":
        with path.open(encoding="latin-1", newline="") as file:
            header = file.readline()
            if "Cluster 2017" not in header or "Código Município" not in header:
                raise ValueError("Cabeçalho inesperado na categorização do turismo")
    elif source in ("comex", "comex-urf"):
        with path.open(encoding="latin-1", newline="") as file:
            header = file.readline()
            needed = ("CO_NCM", "SG_UF_NCM", "CO_URF", "KG_LIQUIDO") if source == "comex" else ("CO_URF", "NO_URF")
            if not all(field in header for field in needed) or not file.readline():
                raise ValueError("Cabeçalho inesperado no Comex Stat")
    elif source == "antt":
        with path.open(encoding="latin-1", newline="") as file:
            header = file.readline().lower()
            if not all(field in header for field in ("origem", "destino", "mercadoria_antt")):
                raise ValueError("Cabeçalho inesperado no CSV da ANTT")
            if not next(csv.reader(file), None):
                raise ValueError("CSV da ANTT sem registros")
    else:
        payload = json.loads(path.read_bytes())
        series = [
            item["serie"]
            for variable in payload
            for result in variable["resultados"]
            for item in result["series"]
        ]
        if not series or not any(values.get(str(year)) not in (None, "", "-", "...", "..", "X") for values in series):
            raise ValueError(f"IBGE sem resultados para {year}")


def collect(root: Path, source: str, url: str, filename: str, year: int) -> Path:
    date = datetime.now(UTC)
    destination = root / source
    destination.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=destination) as staging:
        stage = Path(staging)
        path = stage / filename
        digest = hashlib.sha256()
        with urlopen(url, timeout=180) as response, path.open("wb") as output:
            for block in iter(lambda: response.read(65536), b""):
                output.write(block)
                digest.update(block)
        validate(path, source, year)
        folder = destination / f"{date:%Y%m%dT%H%M%S%fZ}-{digest.hexdigest()[:12]}"
        (stage / "manifest.json").write_text(
            json.dumps(
                {
                    "source": source,
                    "url": url,
                    "collected_at": date.isoformat(),
                    "reference_year": year,
                    "filename": filename,
                    "sha256": digest.hexdigest(),
                },
                indent=2,
            ) + "\n",
            encoding="utf-8",
        )
        stage.rename(folder)
    return folder / filename


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", choices=("prf", "antt", "dnit", "ibge", "cempre", "turismo", "comex", "comex-urf"))
    parser.add_argument("--year", type=int, help="Ano de referência do PIB municipal")
    parser.add_argument("--municipality", action="append", help="Código IBGE do município")
    parser.add_argument("--state", choices=("GO", "BR"), help="Coletar todos os municípios de Goiás ou do Brasil")
    parser.add_argument("--output", type=Path, default=Path("data/raw"))
    args = parser.parse_args()
    if args.source == "ibge":
        if args.state:
            if args.municipality:
                parser.error("Escolha --state ou --municipality")
            scope = "estados/52/municipios" if args.state == "GO" else "municipios"
            with urlopen(f"https://servicodados.ibge.gov.br/api/v1/localidades/{scope}", timeout=60) as response:
                args.municipality = [str(item["id"]) for item in json.load(response)]
        if not args.year or not args.municipality or any(
            len(code) != 7 or not code.isascii() or not code.isdecimal()
            for code in args.municipality
        ):
            parser.error("IBGE exige --year e ao menos um --municipality com sete dígitos")
        params = urlencode({"localidades": "N6[all]" if args.state == "BR" else f"N6[{','.join(args.municipality)}]"})
        # Brasil: PIB (37) e valor adicionado da agropecuária, indústria, serviços e administração, mais impostos.
        # O IBGE publica os setores com dois anos de atraso em relação ao PIB total: coleta os dois anos.
        variables, periods = ("37|513|517|6575|525|543", f"{args.year - 2}|{args.year}") if args.state == "BR" else ("37", args.year)
        url = (
            "https://servicodados.ibge.gov.br/api/v3/agregados/5938/"
            f"periodos/{periods}/variaveis/{variables}?{params}"
        )
        filename = {"GO": f"pib_goias_{args.year}.json", "BR": f"pib_brasil_{args.year}.json"}.get(
            args.state, f"pib_municipal_{args.year}.json")
        year = args.year
    else:
        if args.year is not None or args.municipality or args.state:
            parser.error("--year e --municipality são opções da coleta do IBGE")
        url, filename, year = {
            "prf": (PRF, "datatran2025.zip", 2025),
            "antt": (ANTT, "producao_origem_destino_2025.csv", 2025),
            "dnit": (DNIT, "vmda2022_snv_202301b.xlsx", 2022),
            "cempre": (CEMPRE, "cempre_2024.json", 2024),
            "turismo": (TURISMO, "categorizacao_turismo_2017.csv", 2017),
            "comex": (COMEX, "EXP_2023.csv", 2023),
            "comex-urf": (COMEX_URF, "URF.csv", 2023),
        }[args.source]
    try:
        print(collect(args.output, args.source, url, filename, year))
    except (OSError, ValueError, TypeError, KeyError, BadZipFile) as error:
        parser.exit(1, f"Falha na coleta {args.source}: {error}\n")


if __name__ == "__main__":
    main()
