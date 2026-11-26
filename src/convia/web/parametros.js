// Parâmetros do cálculo de benefícios: valor, ano-base e fonte de cada um.
// Origem: dossiê de referências do projeto (run 20261125-2015, seção 4). Valores em R$ de ago/2026.

const IPCA_2014_2026 = 7633.23 / 4059.86; // IPCA número-índice dez/2014 → ago/2026 (IBGE, tabela 1737)
const IGPDI_2017_2026 = 1.8311; // IGP-DI acumulado jan/2018–ago/2026 (BCB, série 190)
const IGPDI_2024_2026 = 1.067; // IGP-DI acumulado jul/2024–ago/2026 (BCB, série 190)

export const PARAMETROS = {
  versao: '2026-11-25',
  custoAcidente: { // Ipea/PRF 2015, Tabela 8, R$ de dez/2014 corrigidos pelo IPCA
    fatal: 646762.94 * IPCA_2014_2026,
    feridos: 90182.71 * IPCA_2014_2026,
    semVitimas: 23062.97 * IPCA_2014_2026,
  },
  fracaoCaminhao: { acidentes: 0.30, mortes: 0.43 }, // Ipea/PRF 2015, Anexo B (rodovias federais, 2014)
  // Reta sobre as 15 rotas de grãos da Conab em Goiás, ago/2026 (R$/t). A faixa soma à reta o maior
  // desvio para baixo e para cima observado nessas rotas (Rio Verde–Imbituba e Catalão–Santos).
  freteRodo: { fixo: 53.0, porKm: 0.229, desvioMin: -30.8, desvioMax: 55.4 },
  // ANTT, Relatório de Tarifas e Preços 2024, setor agrícola, tarifa + operações acessórias (R$/mil TKU)
  tarifaFerro: [[500, 259.06], [1000, 168.37], [1500, 149.20], [Infinity, 164.89]],
  reajusteFerro: IGPDI_2024_2026,
  transbordo: { rodoFerro: 9.52 * IGPDI_2017_2026, ferroRodo: 9.00 * IGPDI_2017_2026 }, // PNL, Tabela 10 (GSA, dez/2017)
  pontaRodoviaria: 39.0, // Conab ago/2026: Rio Verde → plataforma ferroviária, 22 km (R$/t)
  co2: { rodo: 37.3, ferro: 16.6 }, // BNDES 2025, Tabela 1, granel agrícola (kg CO₂/mil TKU)
  diesel: { rodo: 15.7, ferro: 7.0 }, // idem (L/mil TKU)
};

const FATAL = 'Com Vítimas Fatais';
const FERIDOS = 'Com Vítimas Feridas';

// ponytail: volume médio da BR inteira na UF, não do trecho exato; o SNV do DNIT não traz geometria.
export function calcular({ toneladas, km, acidentes, trafego, cargaUtil, terminais, percentual }, p = PARAMETROS) {
  const carga = toneladas * percentual / 100;
  const tku = carga * km;
  const viagens = carga / cargaUtil;
  const passagensDia = 2 * viagens / 365; // volta vazia
  const evitado = { acidentes: 0, mortes: 0, custo: 0, semVolume: 0 };
  for (const acidente of acidentes) {
    const volume = trafego.get(acidente.uf + ':' + acidente.br);
    if (!volume) { evitado.semVolume += 1; continue; }
    const exposicao = Math.min(1, passagensDia / volume);
    const fatal = acidente.classificacao_acidente === FATAL;
    const fracao = fatal ? p.fracaoCaminhao.mortes : p.fracaoCaminhao.acidentes;
    const custo = fatal ? p.custoAcidente.fatal
      : acidente.classificacao_acidente === FERIDOS ? p.custoAcidente.feridos : p.custoAcidente.semVitimas;
    evitado.acidentes += fracao * exposicao;
    evitado.mortes += (acidente.mortos ?? 0) * p.fracaoCaminhao.mortes * exposicao;
    evitado.custo += fracao * exposicao * custo;
  }
  const tarifa = p.tarifaFerro.find(([limite]) => km <= limite)[1];
  const reta = p.freteRodo.fixo + p.freteRodo.porKm * km;
  const rodo = { min: reta + p.freteRodo.desvioMin, max: reta + p.freteRodo.desvioMax };
  const ferro = tarifa / 1000 * km * p.reajusteFerro + p.transbordo.rodoFerro + p.transbordo.ferroRodo
    + { A: 0, B: 2, origem: 1 }[terminais] * p.pontaRodoviaria; // origem: exportação chega de trem ao porto
  const economiaPorT = { min: rodo.min - ferro, max: rodo.max - ferro };
  const economia = { min: economiaPorT.min * carga, max: economiaPorT.max * carga };
  return {
    carga, viagens, passagensDia, ...evitado,
    freteRodo: rodo, freteFerro: ferro, economiaPorT, economia,
    co2: tku / 1000 * (p.co2.rodo - p.co2.ferro) / 1000,
    diesel: tku / 1000 * (p.diesel.rodo - p.diesel.ferro),
  };
}
