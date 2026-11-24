# CONVIA

Projeto de extensão de Big Data com Python para analisar corredores candidatos a estudos de expansão ferroviária. Esta versão inicial fornece a base executável da API. O plano de entrega e os critérios técnicos estão em [Arquitetura e requisitos](docs/arquitetura-e-requisitos.md).

## Rodar localmente

Pré-requisito: Python 3.12 ou superior. No PowerShell, a partir da raiz do repositório:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\python.exe -m uvicorn convia.api:app
```

Abra `http://127.0.0.1:8000/docs` para consultar a API. `GET /health` retorna `{"status":"ok"}` e verifica que a aplicação está respondendo.

`src/convia/` contém o pacote Python. A pasta local `data/` é destinada às bases de trabalho e fica fora do Git.
