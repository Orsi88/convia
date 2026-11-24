# Arquitetura e requisitos técnicos do CONVIA

O CONVIA compara corredores candidatos a estudos de expansão ferroviária. O núcleo é um fluxo de dados reproduzível em Python. A interface apresenta evidências, cobertura e premissas para que o leitor entenda a origem de cada resultado. O projeto é individual e o parceiro externo está em aberto.

A base documental é o **DOC-01 v02**, Plano do Projeto e Metodologia Analítica, e o **DOC-02 v02**, Especificação Funcional, Analítica e Técnica. Os identificadores abaixo remetem a essas versões. O esqueleto entrega a API executável e sua rota de saúde. O desenho analítico e os critérios adiante orientam os próximos incrementos.

## 1. Arquitetura proposta

```mermaid
flowchart LR
  F[Fontes públicas] --> P[Pipeline Python]
  P --> D[Parquet e DuckDB]
  D --> A[API FastAPI]
  A --> W[Painel com mapa e tabela]
```

O processamento ocorre antes da consulta. A API lê resultados preparados e o painel apresenta os dados e a metodologia.

| Componente | Responsabilidade e contrato |
|---|---|
| Ingestão | Registrar fonte, URL, data de coleta, período, licença quando disponível e versão. Preservar arquivos originais e registrar falhas de leitura ou de esquema. |
| Tratamento | Validar campos, tipos, duplicidades e nulos. Padronizar chave IBGE e sistema de coordenadas. Registrar ano de referência e método de associação por trecho. |
| Análise | Calcular indicadores e candidatos em Python. Produzir resultados com unidade, período, cobertura, fonte e versão. |
| Persistência analítica | Manter dados tratados e resultados em Parquet. Consultar com DuckDB. Publicar o conjunto de resultados após validação e conservar a última versão válida em caso de falha. |
| API | Servir JSON e GeoJSON do conjunto publicado. Separar erro técnico, ausência de registros e cobertura insuficiente. Validar filtros e ler somente consultas previstas. |
| Painel | Exibir mapa e alternativa tabular, filtros, detalhes, cobertura e metodologia. Diferenciar valores observados, derivados e simulados. |

### Decisões para a primeira entrega

| Decisão | Opções e critério | Situação |
|---|---|---|
| Armazenamento | Parquet e DuckDB permitem execução local sem administrar servidor. PostGIS passa a ser opção se as consultas espaciais interativas ou o acesso concorrente justificarem a operação de um banco. | Parquet e DuckDB propostos conforme os DOCs. |
| Processamento | Pandas e GeoPandas são a primeira opção após medir as bases. PySpark depende de volume medido ou exigência da disciplina. | Proposta a verificar com os dados e com o docente. |
| Apresentação | FastAPI separa o contrato da interface e acompanha o DOC-02. Um painel Python integrado reduz ferramentas para uma entrega individual, ao custo de menor controle sobre mapa e interação. React/TypeScript é a opção documentada para maior controle visual. | FastAPI no esqueleto. Tecnologia final do painel em aberto. |

A execução inicial é local. Na aplicação completa, `/api/meta` informa as versões e `/api/sources` informa a origem dos dados. As consultas espaciais usam GeoJSON. Os resultados são publicados para leitura após a execução validada do pipeline.

## 2. Requisitos técnicos e verificação

| Origem | Requisito | Verificação |
|---|---|---|
| DOC-01 DQ-001, DQ-002 e DQ-009. DOC-02 AC-009/010/012 | Ingestão e processamento reproduzíveis, com dados brutos preservados e origem identificável. | Executar o fluxo com os mesmos insumos e comparar resultados e contagens. Conferir manifesto e instruções de execução. |
| DOC-01 DQ-003 a DQ-010. DOC-02 INT-001 a INT-010 | Validar schema, chaves, períodos, geometrias e cobertura. Usar projeção adequada para distâncias e registrar associações aproximadas. | Reconciliar uma amostra com a fonte e verificar joins incompatíveis, nulos, duplicidades e mudança de esquema. |
| DOC-02 RF-001 a RF-018, VIS-001 a VIS-009 e AC-001 a AC-003 | Exibir mapa e tabela com filtros compatíveis, unidade, fonte, período e cobertura. Distinguir dados insuficientes de zero. | Comparar recortes conhecidos, validar um período incompatível e percorrer ranking e detalhes pelo teclado. |
| DOC-02 RF-019 a RF-024, RN-011 a RN-016 e AC-004 a AC-006 | Calcular IPF versionado de 0 a 100 com componentes normalizados e pesos somando 100%. Exibir contribuição por componente e marcar insuficiência se faltar um obrigatório. | Recalcular um candidato à mão, testar falta de componente e comparar a ordenação com pesos alternativos. |
| DOC-02 RF-025 a RF-029, SIM-001 a SIM-010 e AC-007/008 | Comparar cenário base e três percentuais propostos de transferência. Aplicar apenas à parcela elegível e identificar premissas e estimativas. | Testar base e cenários de 10%, 20% e 30%. Mostrar efeito sobre exposição e verificar que a interface não atribui causalidade a acidentes ou PIB. |
| DOC-02 RNF-002/005/006/011/012 e AC-011 | Consultar resultados preparados, preservar termos de uso das fontes e manter cálculos críticos testáveis. | Testar contrato e entradas inválidas, verificar licenças antes de redistribuir e medir consulta no recorte escolhido. Metas de desempenho dependem da medição inicial. |

## 3. Entrega em etapas

1. **Fundação.** Instalar o pacote, iniciar a API e obter resposta de `GET /health`. A base atual cobre esse incremento.
2. **Recorte piloto.** Verificar a interseção de períodos e territórios de PRF, DNIT, IBGE e malha ferroviária. Selecionar uma região com ao menos dois candidatos como proposta de piloto. A saída é um catálogo com cobertura, limitações e exemplos de associação entre bases.
3. **Primeiro fluxo de ponta a ponta.** Executar ingestão, tratamento e cálculo de indicadores de segurança e infraestrutura no recorte. Validar totais e associações em uma amostra e servir os artefatos preparados para mapa e tabela.
4. **Priorização.** Fechar geração de candidatos, área de influência, componentes obrigatórios e normalização. Versionar o IPF e conferir a estabilidade do ranking. Os pesos iniciais do DOC-01 são hipótese de trabalho.
5. **Cenários e fechamento.** Definir a parcela elegível antes de simular transferência modal. Publicar os resultados com as premissas, validar o painel e registrar evidências de execução e limitações para a entrega acadêmica.

O recorte, o período comum, a suficiência de dados, os critérios de elegibilidade e a tecnologia do painel dependem dos resultados do piloto. A expansão nacional depende de verificar a cobertura e a compatibilidade entre as fontes.
