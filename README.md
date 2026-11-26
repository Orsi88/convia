# CONVIA

Projeto de extensão de Big Data com Python para analisar corredores candidatos a estudos de expansão ferroviária. Esta versão inicial fornece a base executável da API. O plano de entrega e os critérios técnicos estão em [Arquitetura e requisitos](docs/arquitetura-e-requisitos.md).

## Rodar localmente

Pré-requisito: Python 3.12 ou superior. No PowerShell, a partir da raiz do repositório:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\python.exe -m uvicorn convia.api:app
```

Abra `http://127.0.0.1:8000/` para usar o painel web e `http://127.0.0.1:8000/docs` para consultar a API. O painel usa os dados preparados na etapa abaixo. `GET /health` retorna `{"status":"ok"}` e verifica que a aplicação está respondendo.

O mapa de acidentes usa Leaflet e o mapa-base do OpenStreetMap. O navegador precisa de internet para carregar o mapa e os arquivos do Leaflet. Os registros da PRF são lidos pela API local.

A triagem consulta pares com partida em Goiás e destino em qualquer município do Brasil, por código IBGE, e traça a rota rodoviária entre as sedes com OSRM. O painel conta os registros da PRF em uma faixa aproximada de 500 m ao redor da rota, em todos os estados que ela atravessa.

Para atualizar os indicadores de carga, baixe a [matriz de cargas do PNL 2050](https://pit.infrasa.gov.br/dados-abertos/), extraia o arquivo RDS, instale o extra de preparo (`pip install -e .[prep]`) e execute `python scripts/prepare_pnl.py matrizes_empilhadas.rds data/raw/ibge/localidades.gpkg`. O script mantém os fluxos com origem em Goiás e destino em qualquer município, agrega a coluna `toneladas` da base de 2023 por par direcionado, identifica o macroproduto com maior tonelagem e grava os 40 pares de maior carga com 300 km ou mais pela estrada (distância do OSRM/OpenStreetMap). Também gera a lista de municípios do Brasil usada no painel. O PIB nacional vem de `python -m convia.collect ibge --year 2023 --state BR`.

As exportações de Goiás vão para `data/processed/pnl-go-export-2023.csv`. A matriz registra o destino delas como zona externa, sem o porto. Para somar o corredor da Norte-Sul, colete o Comex Stat e rode a soma:

```powershell
.\.venv\Scripts\python.exe -m convia.collect comex
.\.venv\Scripts\python.exe -m convia.collect comex-urf
.\.venv\Scripts\python.exe -m convia.corridor
```

A soma junta os pares com origem a até 100 km dos terminais de Anápolis, Rio Verde e São Simão e chegada a até 100 km de Estrela d'Oeste, Santos, Porto Nacional ou São Luís. O Comex Stat estima a parte das exportações que sai por Santos e pelo Itaqui. Sem ele, as exportações ficam fora da soma e o painel mostra quanto falta. `GET /api/corridors/norte-sul` entrega o resultado.

- `GET /api/meta` expõe a versão do recorte e a data de atualização. A versão do modelo permanece `null` até a implementação do modelo analítico.
- `GET /api/sources` lista as fontes usadas pelo painel, com o ano de referência e o uso de cada uma.

`src/convia/` contém o pacote Python. A pasta local `data/` é destinada às bases de trabalho e fica fora do Git.

## Coletar dados oficiais

Na raiz do repositório, com o ambiente instalado:

```powershell
.\.venv\Scripts\python.exe -m convia.collect prf
.\.venv\Scripts\python.exe -m convia.collect antt
.\.venv\Scripts\python.exe -m convia.collect dnit
.\.venv\Scripts\python.exe -m convia.collect ibge --year 2023 --municipality 3106200
```

PRF e ANTT usam os arquivos de 2025. O DNIT usa a planilha de contagem de tráfego de 2022. O exemplo do IBGE consulta o PIB de Belo Horizonte em 2023. Cada base mantém o próprio ano. O período comum ainda precisa ser definido, e a aba Fontes mostra o ano de cada uma.

Cada coleta validada grava o original e seu `manifest.json` em uma nova pasta de `data/raw/<fonte>/`. O manifesto registra URL, data de coleta, ano de referência e SHA-256. Para consultar vários municípios, repita `--municipality`.

## Preparar a base de Goiás

Após coletar PRF, ANTT e DNIT, colete o PIB dos municípios de Goiás e prepare o recorte:

```powershell
.\.venv\Scripts\python.exe -m convia.collect ibge --year 2023 --state GO
.\.venv\Scripts\python.exe -m convia.prepare
```

O processamento confere o SHA-256 dos insumos e gera quatro arquivos Parquet em uma nova pasta `data/processed/goias-<data>/`, com manifesto de origem, contagens e pendências de qualidade. Uma falha preserva as versões anteriores.

O recorte inclui os acidentes da PRF de todo o Brasil, porque as rotas atravessam outros estados. Inclui também os trechos rodoviários do DNIT em Goiás, os fluxos ferroviários com origem ou destino no estado e o PIB dos municípios. Os anos permanecem identificados por fonte. O período comum, a associação espacial entre bases e a conversão de TU/TKU da ANTT ainda precisam ser fechados.

## Consultar o recorte pela API

A API usa a pasta completa mais recente de `data/processed/goias-<data>/`. Configure `CONVIA_DATA_DIR` para usar outra pasta de dados. Inicie o servidor a partir da raiz do repositório.

| Rota | Resultado |
|---|---|
| `GET /api/overview` | Contagens e anos de referência por fonte |
| `GET /api/quality` | Manifesto, proveniência e pendências de qualidade |
| `GET /api/safety/summary?br=153` | Acidentes, mortos e feridos, com filtro opcional de BR de três dígitos |
| `GET /api/roads?limit=100&offset=0` | Trechos do DNIT com paginação |
| `GET /api/rail/flows?limit=100&offset=0` | Fluxos ferroviários com paginação |
| `GET /api/economy/summary` | PIB dos municípios com unidade e ano |
| `GET /api/map/layers` | Camadas disponíveis |
| `GET /api/map/accidents?br=153` | Acidentes em GeoJSON, com filtro opcional de BR |

Os resultados identificam a versão da base. Sem recorte preparado, as consultas retornam HTTP 503. Filtros inválidos retornam HTTP 422. Uma consulta sem acidentes retorna contagem zero e somas `null`. A paginação aceita de 1 a 500 registros.

Execute os testes locais com `.\.venv\Scripts\python.exe -m unittest discover -s tests` e, para o cálculo de benefícios do painel, `node --test tests/test_parametros.mjs`. Os parâmetros do cálculo, com valor, ano-base e fonte, ficam em `src/convia/web/parametros.js`.

## Painel: trajeto, região e referências

- **Entorno do trajeto:** municípios com sede a até 25 km da rota, com PIB (IBGE 2023) e setores (2021), pessoal ocupado por atividade (CEMPRE 2024), categoria do Mapa do Turismo (MTur 2017) e resumo da Wikipedia (resolvido pelo código IBGE no Wikidata). Coleta: `python -m convia.collect cempre`, `python -m convia.collect turismo` e `python -m convia.collect ibge --year 2023 --state BR`.
- **Abas por trajeto:** Segurança, Rodovias e Economia mostram primeiro o trajeto selecionado e depois a visão geral de Goiás.
- **Notícias:** `/api/noticias` consulta o GDELT pelo servidor, com cache em `data/cache/noticias` (6 h) e no máximo 1 consulta a cada 5 s. O GDELT limita consultas com frequência; sem resposta, o painel mostra os canais oficiais (PRF por estado, DNIT, ANTT, IBGE, MTur).
- **Ferrovias do mundo:** conteúdo curado com fontes em `src/convia/web/ferrovias-mundo.json`; cada afirmação cita a fonte e traz o nível de confiança.
