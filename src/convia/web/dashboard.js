import { calcular, PARAMETROS } from './parametros.js';
const byId = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const format = (value) => value == null || value === '' ? '—'
  : typeof value === 'number' ? number.format(value) : String(value);
const pageSize = 15;

function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

async function get(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(response.status === 503
    ? 'O recorte de Goiás ainda está indisponível.' : 'Não foi possível carregar os dados.');
  return response.json();
}

function errorMessage(status, error, retry) {
  const button = element('button', 'Tentar novamente');
  button.addEventListener('click', retry, { once: true });
  status.replaceChildren(document.createTextNode(error.message), button);
}

function metrics(target, items) {
  target.replaceChildren(...items.map(([label, value, source]) => {
    const card = element('div');
    card.className = 'metric';
    const count = element('dd', format(value));
    count.className = 'value';
    card.append(element('dt', label), count);
    if (source) {
      const caption = element('dd', source);
      caption.className = 'source';
      card.append(caption);
    }
    return card;
  }));
}

const datasets = [
  ['Acidentes', 'accidents', 'prf', 'safety'],
  ['Trechos rodoviários', 'roads', 'dnit', 'roads'],
  ['Fluxos ferroviários', 'rail_flows', 'antt', 'rail'],
  ['PIB municipal', 'economy', 'ibge', 'economy'],
];

async function loadOverview() {
  const coverage = byId('coverage');
  coverage.textContent = 'Carregando cobertura das bases…';
  try {
    const { counts, reference_years: years, common_period: period } = await get('/api/overview');
    metrics(byId('overview'), datasets.map(([label, key, source, section]) => {
      const caption = `${source.toUpperCase()} · ${years[source]}`;
      byId(`${section}-source`).textContent = caption;
      return [label, counts[key], caption];
    }));
    coverage.textContent = period ? `Período comum: ${period}` : 'As bases cobrem anos diferentes. O piloto ainda não tem um período comum.';
  } catch (error) {
    errorMessage(coverage, error, loadOverview);
  }
}

function paginatedTable(target, label, columns, load) {
  const scroll = element('div');
  scroll.className = 'table-scroll';
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', label);
  const table = element('table');
  const header = table.createTHead().insertRow();
  for (const [name] of columns) {
    const cell = element('th', name);
    cell.scope = 'col';
    header.append(cell);
  }
  const body = table.createTBody();
  scroll.append(table);
  const status = element('p');
  status.className = 'status';
  status.setAttribute('role', 'status');
  const controls = element('div');
  controls.className = 'pagination';
  const previous = element('button', 'Anterior');
  const next = element('button', 'Próxima');
  const range = element('span');
  range.setAttribute('aria-live', 'polite');
  controls.append(previous, range, next);
  target.replaceChildren(status, scroll, controls);
  let offset = 0;

  async function show(start) {
    previous.disabled = next.disabled = true;
    status.textContent = 'Carregando registros…';
    try {
      const { items, total } = await load(start);
      body.replaceChildren(...items.map((item) => {
        const row = element('tr');
        for (const [, field] of columns) row.append(element('td', format(item[field])));
        return row;
      }));
      offset = start;
      scroll.hidden = controls.hidden = !items.length;
      status.textContent = items.length ? '' : 'Nenhum registro neste recorte.';
      range.textContent = `${format(start + 1)}–${format(start + items.length)} de ${format(total)}`;
      previous.disabled = start === 0;
      next.disabled = start + items.length >= total;
    } catch (error) {
      scroll.hidden = controls.hidden = true;
      errorMessage(status, error, () => show(start));
    }
  }

  previous.addEventListener('click', () => show(offset - pageSize));
  next.addEventListener('click', () => show(offset + pageSize));
  scroll.hidden = controls.hidden = true;
  show(0);
}

const localPage = (items) => (offset) => ({ items: items.slice(offset, offset + pageSize), total: items.length });
const apiPage = (url) => (offset) => get(`${url}?limit=${pageSize}&offset=${offset}`);
const filter = byId('road-filter');
const safetyMap = { container: byId('accident-map'), prefix: '' };
const triageMap = { container: byId('triage-map'), prefix: 'triage-' };
let safetyRequest = 0;

function frameMap(view) {
  const bounds = view.markers?.getBounds();
  if (!bounds?.isValid()) return;
  view.map.invalidateSize({ pan: false });
  view.map.fitBounds(bounds, { padding: [36, 36], maxZoom: 13, animate: false });
}

byId('triage-map-reset').addEventListener('click', () => frameMap(triageMap));

function updateMap(data, view = safetyMap) {
  const { container, prefix } = view;
  const figure = byId(`${prefix}map-figure`);
  const status = byId(`${prefix}map-status`);
  figure.hidden = !data.features.length || !window.L;
  if (!window.L) {
    status.textContent = 'O mapa interativo está indisponível.';
    return;
  }
  view.markers?.clearLayers();
  if (!data.features.length) return;

  const L = window.L;
  if (!view.map) {
    const accidentMap = L.map(container, { preferCanvas: true });
    view.map = accidentMap;
    accidentMap.zoomControl.getContainer().querySelector('.leaflet-control-zoom-in')?.setAttribute('aria-label', 'Ampliar mapa');
    accidentMap.zoomControl.getContainer().querySelector('.leaflet-control-zoom-out')?.setAttribute('aria-label', 'Reduzir mapa');
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    });
    tiles.on('tileerror', () => {
      status.textContent = 'Parte do mapa-base não pôde ser carregada.';
    });
    tiles.on('loading', () => { status.textContent = ''; });
    tiles.addTo(accidentMap);
    view.markers = L.geoJSON(null, view === triageMap ? {
      style: ({ geometry }) => geometry.type === 'Point'
        ? { color: '#1f2023', weight: 1.5, opacity: 1, fillColor: '#9fd5a9', fillOpacity: .95 }
        : { color: '#aa400c', weight: 7, opacity: .95 },
      pointToLayer: (_, location) => L.circleMarker(location, { radius: 6 }),
      onEachFeature: ({ properties }, layer) => {
        layer.bindTooltip(element('span', properties.name));
        if (properties.code) layer.on('click', () => byId('corridor').dispatchEvent(new CustomEvent('town', { detail: properties.code })));
      },
    } : {
      pointToLayer: (_, location) => L.circleMarker(location, {
        radius: 5, color: '#342316', weight: 1.2, fillColor: '#ffab61', fillOpacity: .93,
      }),
      onEachFeature: ({ properties }, marker) => {
        const detail = element('div');
        detail.className = 'accident-popup';
        detail.append(
          element('strong', format(properties.tipo_acidente)),
          element('div', `${format(properties.municipio)} · ${properties.br === '000' ? 'Código 000 na PRF' : `BR ${format(properties.br)}`} · km ${format(properties.km)}`),
          element('div', `Data: ${format(properties.data_inversa)}`),
          element('div', `${format(properties.mortos)} mortos · ${format(properties.feridos)} feridos`),
        );
        const location = [properties.municipio, /^\d{3}$/.test(properties.br) && properties.br !== '000' ? 'BR-' + properties.br : ''].filter(Boolean).join(' ');
        if (location) {
          const news = element('a', 'Buscar notícias da região');
          news.href = newsSearch(location + ' Goiás acidente trânsito');
          detail.append(news);
          marker.once('popupopen', () => {
            const regional = byId('seguranca').querySelector('.editorial-card').cloneNode(true);
            news.before(element('small', 'Leitura relacionada · prevenção em Goiás'), regional);
            marker.getPopup().update();
          });
        }
        marker.bindPopup(detail);
      },
    }).addTo(accidentMap);
    new ResizeObserver(() => {
      if (container.clientWidth) accidentMap.invalidateSize();
    }).observe(container);
  }

  view.markers.addData(data);
  frameMap(view);
  if (view === safetyMap) byId('map-caption').textContent = `${format(data.features.length)} acidentes com coordenadas. Selecione um ponto para abrir o registro.`;
}

async function loadSafety() {
  const request = ++safetyRequest;
  const status = byId('safety-status');
  const content = byId('safety-content');
  const suffix = '?uf=GO' + (filter.value ? `&br=${encodeURIComponent(filter.value)}` : '');
  status.textContent = 'Carregando acidentes…';
  content.hidden = true;
  try {
    const [summary, map] = await Promise.all([get(`/api/safety/summary${suffix}`), get(`/api/map/accidents${suffix}`)]);
    if (request !== safetyRequest) return;
    const points = map.features;
    if (!filter.value) {
      const roads = [...new Set(points.map(({ properties }) => properties.br))].filter((br) => /^\d{3}$/.test(br)).sort();
      filter.length = 1;
      for (const br of roads) filter.add(new Option(br === '000' ? 'Código 000 na PRF' : `BR-${br}`, br));
      filter.disabled = !roads.length;
    }
    metrics(byId('safety-metrics'), [['Acidentes', summary.accidents], ['Mortos', summary.deaths], ['Feridos', summary.injured]]);
    showBars('safety-bars', mostFrequent(points.map(({ properties }) => properties.tipo_acidente)));
    paginatedTable(byId('accident-table'), 'Acidentes da PRF', [
      ['Data', 'data_inversa'], ['Município', 'municipio'], ['BR', 'br'], ['Km', 'km'], ['Tipo', 'tipo_acidente'],
      ['Mortos', 'mortos'], ['Feridos', 'feridos'],
    ], localPage(points.map(({ properties }) => properties)));
    content.hidden = false;
    status.textContent = !summary.accidents ? 'Nenhum acidente neste recorte.'
      : map.omitted_coordinates ? `${format(map.omitted_coordinates)} registros sem coordenadas válidas ficam fora desta visualização e da tabela.` : '';
    if (!byId('seguranca').hidden) updateMap(map);
    else pendingMap = map;
  } catch (error) {
    if (request === safetyRequest) errorMessage(status, error, loadSafety);
  }
}

filter.addEventListener('change', loadSafety);
let pendingMap;

// ponytail: a faixa geográfica serve para triagem. Atribuir ocorrências à via exige cruzar a malha e o registro.
function nearbyAccidents(geometry, features) {
  const points = geometry.coordinates;
  const xScale = 111_195 * Math.cos(points[0][1] * Math.PI / 180);
  const yScale = 111_195;
  const buffer = 500;
  const segments = points.slice(1).map(([endX, endY], index) => {
    const [x, y] = points[index];
    return { x, y, dx: (endX - x) * xScale, dy: (endY - y) * yScale };
  });
  const totals = { accidents: 0, deaths: 0, items: [] };
  for (const { geometry: point, properties } of features) {
    const [lon, lat] = point.coordinates;
    const nearby = segments.some(({ x, y, dx, dy }) => {
      const px = (lon - x) * xScale;
      const py = (lat - y) * yScale;
      if (px < Math.min(0, dx) - buffer || px > Math.max(0, dx) + buffer ||
          py < Math.min(0, dy) - buffer || py > Math.max(0, dy) + buffer) return false;
      const lengthSquared = dx * dx + dy * dy;
      const position = lengthSquared ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared)) : 0;
      return (px - position * dx) ** 2 + (py - position * dy) ** 2 <= buffer ** 2;
    });
    if (nearby) {
      totals.accidents += 1;
      totals.deaths += properties.mortos ?? 0;
      totals.items.push(properties);
    }
  }
  return totals;
}

const money = (value) => Number.isFinite(value) ? 'R$ ' + format(Math.round(value)) : '—';
const decimal = (digits) => (value) => Number.isFinite(value)
  ? value.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
const whole = (value) => Number.isFinite(value) ? format(Math.round(value)) : '—';
const range = (show) => (value) => value ? show(value.min) + ' a ' + show(value.max) : '—';
const INDICADORES = [
  ['Carga no trem (t)', 'carga', whole],
  ['Viagens de caminhão evitadas', 'viagens', whole],
  ['Caminhões a menos por dia na rodovia (ida e volta)', 'passagensDia', decimal(1)],
  ['Acidentes evitados', 'acidentes', decimal(2)],
  ['Mortes evitadas', 'mortes', decimal(3)],
  ['Custo de acidentes evitado', 'custo', money],
  ['Economia de frete (faixa)', 'economia', range(money)],
  ['CO₂ evitado (t)', 'co2', whole],
  ['Diesel economizado (mil L)', 'diesel', (value) => whole(value / 1000)],
];

// Frase de abertura: o trem compensa por tonelada nesta distância?
function headline({ min, max }, onde = 'Nesta distância') {
  if (min > 0) return `${onde} o trem sai de ${money(min)} a ${money(max)} mais barato por tonelada, já com o transbordo.`;
  if (max < 0) return `${onde} o trem sai de ${money(-max)} a ${money(-min)} mais caro por tonelada: o transbordo pesa mais que a economia no trajeto.`;
  return `${onde}, depende do frete negociado: o trem vai de ${money(-min)} mais caro a ${money(max)} mais barato por tonelada.`;
}

function showImpact(pair) {
  const { cargo, km, safety, trafego } = pair;
  const tonnes = cargo.tonnes;
  const ready = cargo.coverage === 'present' && tonnes > 0 && Number.isFinite(km);
  byId('impact-status').textContent = cargo.coverage === 'present'
    ? tonnes === 0 ? 'A matriz registra zero toneladas para este sentido.'
      : Number.isFinite(km) ? '' : 'Sem rota rodoviária: os indicadores dependem da distância.'
    : cargo.coverage === 'absent' ? 'Sem registro de carga para este sentido.' : 'Matriz de cargas indisponível.';
  const entrada = {
    toneladas: tonnes, km, acidentes: safety.items ?? [], trafego,
    cargaUtil: Number(byId('impact-q').value), terminais: byId('impact-terminais').value,
  };
  const cenarios = [10, 20, 30].map((percentual) => ready ? calcular({ ...entrada, percentual }) : null);
  byId('impact-rows').replaceChildren(...INDICADORES.map(([label, key, show]) => {
    const row = element('tr');
    const heading = element('th', label);
    heading.scope = 'row';
    const cells = cenarios.map((result) => element('td', result ? show(result[key]) : '—'));
    if (key === 'economia') cells.forEach((cell, index) => cell.classList.toggle('negative', (cenarios[index]?.economia.max ?? 0) < 0));
    row.append(heading, ...cells);
    return row;
  }));
  const [base] = cenarios;
  byId('impact-headline').textContent = !base ? '' : headline(base.economiaPorT);
  byId('impact-notes').textContent = !base ? '' : [
    'Frete por tonelada: caminhão de ' + money(base.freteRodo.min) + ' a ' + money(base.freteRodo.max)
      + ' (variação observada nas rotas da Conab), trem ' + money(base.freteFerro) + ' com transbordo.',
    base.semVolume ? base.semVolume + ' acidente(s) perto da rota ficaram fora da conta por falta de volume de tráfego da BR na UF.' : '',
    'Parâmetros de granel agrícola, versão ' + PARAMETROS.versao + '.',
  ].filter(Boolean).join(' ');
}

// ---- Corredor da Norte-Sul ----------------------------------------------------------------------
const CORREDOR = [
  ['Carga no trem (t)', 'carga', whole],
  ['Viagens de caminhão evitadas', 'viagens', whole],
  ['Caminhões a menos por dia nas rodovias (ida e volta)', 'passagensDia', whole],
  ['Economia de frete (faixa)', 'economia', range(money)],
  ['CO₂ evitado (t)', 'co2', whole],
  ['Diesel economizado (mil L)', 'diesel', (value) => whole(value / 1000)],
];

// Caminhão até o terminal nas duas pontas; a exportação chega de trem ao porto e só paga a ponta de origem.
const pontas = (group) => group.kind === 'exportação' ? 'origem' : 'B';

// Soma, grupo a grupo, a mesma conta dos pares.
function sumCorridor(groups, cargaUtil, percentual) {
  const total = { carga: 0, viagens: 0, passagensDia: 0, economia: { min: 0, max: 0 }, co2: 0, diesel: 0 };
  for (const group of groups) {
    const r = calcular({ toneladas: group.tonnes, km: group.km, acidentes: [], trafego: new Map(), cargaUtil, terminais: pontas(group), percentual });
    for (const key of ['carga', 'viagens', 'passagensDia', 'co2', 'diesel']) total[key] += r[key];
    total.economia.min += r.economia.min;
    total.economia.max += r.economia.max;
  }
  return total;
}

async function loadNorteSul() {
  const status = byId('norte-sul-status');
  try {
    const data = await get('/api/corridors/norte-sul');
    const groups = data.groups.filter((group) => Number.isFinite(group.km) && group.tonnes > 0);
    const show = () => {
      const cargaUtil = Number(byId('impact-q').value);
      const cenarios = [10, 20, 30].map((percentual) => sumCorridor(groups, cargaUtil, percentual));
      byId('norte-sul-rows').replaceChildren(...CORREDOR.map(([label, key, format]) => {
        const row = element('tr');
        const heading = element('th', label);
        heading.scope = 'row';
        row.append(heading, ...cenarios.map((result) => element('td', format(result[key]))));
        return row;
      }));
      const [base] = cenarios;
      byId('norte-sul-headline').textContent = base.carga
        ? headline({ min: base.economia.min / base.carga, max: base.economia.max / base.carga }, 'Na média do corredor') : '';
    };
    byId('impact-q').addEventListener('change', show);
    show();
    byId('norte-sul-groups').replaceChildren(...groups.map((group) => {
      const r = calcular({ toneladas: group.tonnes, km: group.km, acidentes: [], trafego: new Map(), cargaUtil: 37, terminais: pontas(group), percentual: 100 });
      const row = element('tr');
      row.append(element('td', group.terminal + ' → ' + group.node), element('td', group.kind), element('td', whole(group.tonnes)),
        element('td', whole(group.km)), element('td', range(money)(r.economiaPorT)),
        element('td', group.products.join(', ')));
      return row;
    }));
    const pending = Object.values(data.exports_other_ports).reduce((sum, value) => sum + value, 0);
    byId('norte-sul-notes').textContent = [
      data.origins + ' municípios de origem em Goiás. Total no corredor: ' + whole(groups.reduce((sum, group) => sum + group.tonnes, 0)) + ' t/ano.',
      data.ports_estimated
        ? 'Exportações divididas pelos portos conforme o Comex Stat (MDIC), 2023: estimativa. ' + whole(pending) + ' t/ano saem por outros portos e ficam fora.'
        : 'Pendente: ' + whole(pending) + ' t/ano exportadas a partir dessas origens ainda não entram na soma, porque o porto de saída depende do Comex Stat, que não foi coletado.',
      'Terminais de Goiás citados na imprensa; a ANTT não publica a lista oficial de pátios. Fonte: ' + data.source + '.',
    ].join(' ');
    status.textContent = '';
  } catch (error) {
    errorMessage(status, error, loadNorteSul);
  }
}

// ---- Entorno do trajeto -------------------------------------------------------------------------
const CORRIDOR_KM = 25;
const SECTORS = [
  ['agro', 'Agropecuária', '#9fd5a9'], ['industry', 'Indústria', '#ffad70'],
  ['services', 'Serviços', '#8fb8ff'], ['public', 'Administração pública', '#c9c7c4'],
];

// Municípios com sede a até CORRIDOR_KM da rota e a posição (km) de cada um ao longo do caminho.
function corridorTowns(points, towns) {
  const xScale = 111_195 * Math.cos(points[Math.floor(points.length / 2)][1] * Math.PI / 180);
  const yScale = 111_195;
  const segments = [];
  let along = 0;
  for (let index = 1; index < points.length; index += 1) {
    const [x, y] = points[index - 1];
    const dx = (points[index][0] - x) * xScale;
    const dy = (points[index][1] - y) * yScale;
    segments.push({ x, y, dx, dy, along });
    along += Math.hypot(dx, dy);
  }
  const lons = points.map(([lon]) => lon);
  const lats = points.map(([, lat]) => lat);
  const pad = CORRIDOR_KM / 100;
  const box = [Math.min(...lons) - pad, Math.max(...lons) + pad, Math.min(...lats) - pad, Math.max(...lats) + pad];
  const found = [];
  for (const town of towns) {
    const [lon, lat] = town.coordinates;
    if (lon < box[0] || lon > box[1] || lat < box[2] || lat > box[3]) continue;
    let best = { distance: Infinity, along: 0 };
    for (const { x, y, dx, dy, along: start } of segments) {
      const px = (lon - x) * xScale;
      const py = (lat - y) * yScale;
      const lengthSquared = dx * dx + dy * dy;
      const position = lengthSquared ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared)) : 0;
      const distance = Math.hypot(px - position * dx, py - position * dy);
      if (distance < best.distance) best = { distance, along: start + position * Math.sqrt(lengthSquared) };
    }
    if (best.distance <= CORRIDOR_KM * 1000) found.push({ town, km: best.along / 1000, distance: best.distance / 1000 });
  }
  return found;
}

function dominant(profile) {
  const values = SECTORS.map(([key, label]) => [label, profile?.[key]]).filter(([, value]) => Number.isFinite(value));
  return values.length ? values.reduce((best, item) => item[1] > best[1] ? item : best)[0] : '—';
}

const wikiCache = new Map();
function wikipedia(code) {
  if (!wikiCache.has(code)) {
    wikiCache.set(code, (async () => {
      // O código IBGE (P1585 no Wikidata) evita ambiguidades de nome entre municípios.
      const sparql = 'SELECT ?article ?image WHERE { ?item wdt:P1585 "' + code + '". ' +
        'OPTIONAL { ?article schema:about ?item; schema:isPartOf <https://pt.wikipedia.org/>. } ' +
        'OPTIONAL { ?item wdt:P18 ?image. } } LIMIT 1';
      const data = await (await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(sparql),
        { signal: AbortSignal.timeout(12000) })).json();
      const article = data.results.bindings[0]?.article?.value;
      if (!article) return null;
      const title = decodeURIComponent(article.split('/wiki/')[1]);
      const summary = await (await fetch('https://pt.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title),
        { signal: AbortSignal.timeout(12000) })).json();
      return { title, url: article, extract: summary.extract, image: summary.thumbnail?.source };
    })().catch(() => null));
  }
  return wikiCache.get(code);
}

function sectorBar(profile, year) {
  const values = SECTORS.map(([key, label, color]) => [label, profile?.[key], color]).filter(([, value]) => Number.isFinite(value));
  const total = values.reduce((sum, [, value]) => sum + value, 0);
  if (!total) return [element('p', 'Sem valor adicionado por setor no IBGE.')];
  const share = (value) => Math.round(value / total * 100) + '%';
  const bar = element('div');
  bar.className = 'sector-bar';
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', values.map(([label, value]) => label + ' ' + share(value)).join(', '));
  const legend = element('ul');
  legend.className = 'sector-legend';
  for (const [label, value, color] of values) {
    const part = element('span');
    part.style.width = (value / total * 100) + '%';
    part.style.background = color;
    bar.append(part);
    const swatch = element('i');
    swatch.style.background = color;
    const item = element('li');
    item.append(swatch, label + ' ' + share(value));
    legend.append(item);
  }
  return [element('small', 'Valor adicionado por setor · IBGE ' + year), bar, legend];
}

async function showTown(entry, profile, sources) {
  const card = byId('town-card');
  const { town, km } = entry;
  const body = [element('small', km < 0.5 ? 'Início do trajeto' : 'km ' + format(Math.round(km)) + ' da rota'),
    element('h4', town.name + ' (' + town.uf + ')')];
  if (profile) {
    body.push(element('p', 'PIB ' + profile.year + ': R$ ' + format(Math.round(profile.value / 1000)) + ' milhões'),
      ...sectorBar(profile, profile.sector_year));
    const total = profile.activities.find((row) => row.section === 'Total');
    const top = profile.activities.filter((row) => row.section !== 'Total' && Number.isFinite(row.workers)).slice(0, 4);
    if (total) body.push(element('p', format(total.workers) + ' pessoas ocupadas em ' + format(total.units) + ' unidades locais.'));
    if (top.length) {
      const list = element('ol');
      for (const row of top) list.append(element('li', row.activity + ': ' + format(row.workers) + ' pessoas'));
      body.push(element('small', 'Atividades que mais empregam'), list);
    }
    const culture = ['I', 'R'].map((section) => profile.activities.find((row) => row.section === section)).filter(Boolean);
    if (culture.length) body.push(element('p', culture.map((row) => row.activity + ': ' + format(row.workers) + ' pessoas').join(' · ')));
    const tourism = profile.tourism;
    body.push(element('p', tourism
      ? 'Turismo: região "' + tourism.tourism_region + '", categoria ' + tourism.category + ' (escala A–E do MTur, 2017). ' +
        format(tourism.lodging_places) + ' meios de hospedagem e ' + format(tourism.lodging_jobs) + ' empregos no setor; ' +
        'demanda doméstica estimada de ' + format(tourism.domestic_demand) + ' visitantes.'
      : 'Fora do Mapa do Turismo Brasileiro de 2017.'));
  }
  const wikiSlot = element('div', 'Buscando resumo na Wikipedia…');
  body.push(wikiSlot);
  card.replaceChildren(...body);
  for (const row of byId('corridor-rows').children) row.setAttribute('aria-current', String(row.dataset.code === String(town.id)));
  byId('corridor-sources').textContent = 'Fontes: ' + Object.values(sources).join(' · ') + ' · Wikipedia/Wikidata.';
  const wiki = await wikipedia(String(town.id));
  if (!card.contains(wikiSlot)) return;
  const parts = [];
  if (wiki?.image) {
    const image = element('img');
    image.src = wiki.image;
    image.alt = 'Imagem de ' + town.name;
    image.loading = 'lazy';
    parts.push(image);
  }
  if (wiki?.extract) parts.push(element('p', wiki.extract));
  const link = element('a', wiki ? 'Ler na Wikipedia (CC BY-SA)' : 'Sem artigo na Wikipedia em português.');
  if (wiki) link.href = wiki.url;
  parts.push(link);
  wikiSlot.replaceChildren(...parts);
}

let corridorRequest = 0;
let corridorTown = () => {};
byId('corridor').addEventListener('town', ({ detail }) => corridorTown(detail));

async function loadCorridor(route, start, end, towns, context) {
  const request = ++corridorRequest;
  const status = byId('corridor-status');
  status.textContent = 'Identificando os municípios do entorno…';
  byId('corridor-rows').replaceChildren();
  byId('corridor-metrics').replaceChildren();
  byId('town-card').replaceChildren();
  const entries = corridorTowns(route.geometry.coordinates, towns.values());
  for (const [code, km] of [[start, 0], [end, route.km]]) {
    if (!entries.some(({ town }) => String(town.id) === code)) entries.push({ town: towns.get(code), km, distance: 0 });
  }
  entries.sort((a, b) => a.km - b.km);
  const codes = entries.map(({ town }) => String(town.id));
  const profiles = new Map();
  let sources = {};
  for (let index = 0; index < codes.length; index += 300) {
    const data = await get('/api/regiao?codes=' + codes.slice(index, index + 300).join(','));
    sources = data.sources;
    for (const item of data.items) profiles.set(item.ibge_code, item);
  }
  if (request !== corridorRequest) return [];
  const values = [...profiles.values()];
  const sum = (pick) => values.reduce((total, item) => total + (pick(item) ?? 0), 0);
  const workers = (section) => (item) => item.activities.find((row) => row.section === section)?.workers;
  metrics(byId('corridor-metrics'), [
    ['Municípios no entorno', entries.length, 'Sede a até ' + CORRIDOR_KM + ' km da rota'],
    ['PIB somado (R$ milhões)', Math.round(sum((item) => item.value) / 1000), sources.economy],
    ['Pessoas ocupadas', sum(workers('Total')), sources.activities],
    ['Em alojamento e alimentação', sum(workers('I')), sources.activities],
    ['No Mapa do Turismo', values.filter((item) => item.tourism).length, sources.tourism],
  ]);
  byId('corridor-rows').replaceChildren(...entries.map((entry) => {
    const code = String(entry.town.id);
    const profile = profiles.get(code);
    const row = element('tr');
    row.dataset.code = code;
    const button = element('button', entry.town.name + ' (' + entry.town.uf + ')');
    button.type = 'button';
    button.addEventListener('click', () => showTown(entry, profile, sources));
    const name = element('td');
    name.append(button);
    row.append(element('td', format(Math.round(entry.km))), name, element('td', dominant(profile)),
      element('td', profile?.tourism ? profile.tourism.category + ' · ' + profile.tourism.tourism_region : '—'));
    return row;
  }));
  corridorTown = (code) => {
    const entry = entries.find(({ town }) => String(town.id) === code);
    if (entry) showTown(entry, profiles.get(code), sources);
  };
  status.textContent = '';
  showTown(entries[0], profiles.get(codes[0]), sources);
  trajeto = { ...context, roads: route.roads, entries, profiles, sources };
  renderRouteTabs();
  return entries.map(({ town }) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: town.coordinates },
    properties: { name: town.name + ' (' + town.uf + ')', code: String(town.id) },
  }));
}

// ---- Abas por trajeto ---------------------------------------------------------------------------
let trajeto = null;

function bars(rows) {
  const list = element('ul');
  list.className = 'bar-list';
  const max = Math.max(0, ...rows.map(([, value]) => value));
  list.replaceChildren(...(rows.length ? rows.map(([label, value]) => {
    const item = element('li');
    const bar = element('span');
    bar.className = 'bar-fill';
    bar.style.width = (max ? 100 * value / max : 0) + '%';
    bar.setAttribute('aria-hidden', 'true');
    item.append(element('span', label), element('strong', format(value)), bar);
    return item;
  }) : [element('li', 'Sem registros neste recorte.')]));
  return list;
}

function block(title, ...children) {
  const section = element('section');
  section.className = 'context-panel';
  section.append(element('h3', title), ...children);
  return section;
}

function routeHeader(target, text) {
  const header = element('div');
  header.className = 'route-context-head';
  header.append(element('h3', 'No trajeto: ' + trajeto.name), element('p', text));
  target.replaceChildren(header);
}

// ---- Notícias por região ------------------------------------------------------------------------
const UF_SLUG = {
  AC: 'acre', AL: 'alagoas', AP: 'amapa', AM: 'amazonas', BA: 'bahia', CE: 'ceara', DF: 'distrito-federal',
  ES: 'espirito-santo', GO: 'goias', MA: 'maranhao', MT: 'mato-grosso', MS: 'mato-grosso-do-sul', MG: 'minas-gerais',
  PA: 'para', PB: 'paraiba', PR: 'parana', PE: 'pernambuco', PI: 'piaui', RJ: 'rio-de-janeiro', RN: 'rio-grande-do-norte',
  RS: 'rio-grande-do-sul', RO: 'rondonia', RR: 'roraima', SC: 'santa-catarina', SP: 'sao-paulo', SE: 'sergipe', TO: 'tocantins',
};

function newsBlock(title, terms, topic, links) {
  const list = element('ul');
  list.className = 'news-list';
  list.append(element('li', 'Buscando notícias recentes…'));
  const official = element('ul');
  for (const [label, url] of links) {
    const item = element('li');
    const link = element('a', label);
    link.href = url;
    item.append(link);
    official.append(item);
  }
  const note = element('small', '');
  const section = block(title, list, note, element('h4', 'Canais oficiais'), official);
  if (!terms.length) {
    list.replaceChildren(element('li', 'Sem termos para buscar neste trajeto.'));
    return section;
  }
  get('/api/noticias?' + new URLSearchParams({ terms: terms.join('|'), topic }))
    .then((data) => {
      note.textContent = 'Notícias em português dos últimos 3 meses, coletadas pelo GDELT. O painel não seleciona nem resume o conteúdo.'
        + (data.stale ? ' Mostrando a última busca guardada.' : '');
      list.replaceChildren(...(data.items.length ? data.items.slice(0, 6).map((item) => {
        const row = element('li');
        const link = element('a', item.title || item.url);
        link.href = item.url;
        link.rel = 'noopener';
        const date = /^(\d{4})(\d{2})(\d{2})/.exec(item.date ?? '');
        row.append(link, element('small', [item.domain, date && `${date[3]}/${date[2]}/${date[1]}`].filter(Boolean).join(' · ')));
        return row;
      }) : [element('li', data.unavailable
        ? 'O serviço de notícias não respondeu agora. Use os canais oficiais abaixo.'
        : 'O serviço de notícias não retornou resultados agora (ele limita consultas). Tente mais tarde ou use os canais oficiais abaixo.')]));
    })
    .catch(() => list.replaceChildren(element('li', 'Notícias indisponíveis no momento.')));
  return section;
}

function stateLinks(ufs, label, url) {
  return ufs.filter((uf) => UF_SLUG[uf]).map((uf) => [label + ' ' + uf, url(UF_SLUG[uf])]);
}

function renderSafetyRoute() {
  const target = byId('safety-route');
  if (!trajeto) return;
  const items = trajeto.safety.items ?? [];
  routeHeader(target, 'Acidentes da PRF de ' + (trajeto.accidentYear ?? '') + ' a até 500 m da rota. A PRF cobre só rodovias federais: trechos estaduais ficam sem registro.');
  const fatal = items.filter((item) => item.classificacao_acidente === 'Com Vítimas Fatais').length;
  const cards = element('dl');
  cards.className = 'metrics';
  target.append(cards);
  metrics(cards, [
    ['Acidentes', items.length], ['Mortes', items.reduce((sum, item) => sum + (item.mortos ?? 0), 0)],
    ['Feridos', items.reduce((sum, item) => sum + (item.feridos ?? 0), 0)], ['Acidentes com morte', fatal],
  ]);
  const byRoad = new Map();
  for (const item of items) {
    const key = item.uf + ':' + item.br;
    const row = byRoad.get(key) ?? { road: 'BR-' + item.br + ' (' + item.uf + ')', accidents: 0, deaths: 0, volume: trajeto.trafego.get(key) };
    row.accidents += 1;
    row.deaths += item.mortos ?? 0;
    byRoad.set(key, row);
  }
  const table = element('div');
  const grid = element('div');
  grid.className = 'insight-grid';
  grid.append(
    block('Onde acontecem', bars(mostFrequent(items.map((item) => item.municipio + ' (' + item.uf + ')')))),
    block('Tipos de acidente', bars(mostFrequent(items.map((item) => item.tipo_acidente)))),
  );
  const ufs = [...new Set(trajeto.entries.map(({ town }) => town.uf))];
  const roads = [...new Set(items.map((item) => 'BR-' + item.br))].slice(0, 6);
  target.append(grid, block('Por rodovia federal', table),
    newsBlock('Notícias de segurança nas rodovias do trajeto', roads, 'seguranca',
      stateLinks(ufs, 'Notícias da PRF em', (slug) => 'https://www.gov.br/prf/pt-br/noticias/estaduais/' + slug)));
  paginatedTable(table, 'Acidentes por rodovia no trajeto', [
    ['Rodovia', 'road'], ['Acidentes', 'accidents'], ['Mortes', 'deaths'], ['Veículos comerciais/dia (DNIT 2022)', 'volume'],
  ], localPage([...byRoad.values()].sort((a, b) => b.accidents - a.accidents)));
}

function renderRoadsRoute() {
  const target = byId('roads-route');
  if (!trajeto) return;
  routeHeader(target, 'Rodovias percorridas pela rota de referência (OSRM/OpenStreetMap) e o tráfego das BRs nos estados do caminho.');
  const ufs = [...new Set(trajeto.entries.map(({ town }) => town.uf))];
  const rows = (trajeto.roads ?? []).map(({ ref, km }) => {
    const br = /^BR-(\d{3})$/.exec(ref)?.[1];
    const volumes = br ? ufs.map((uf) => trajeto.trafego.get(uf + ':' + br)).filter(Number.isFinite) : [];
    return {
      ref, km: Math.round(km),
      kind: br ? 'Federal' : /^[A-Z]{2}-\d+/.test(ref) ? 'Estadual' : 'Via urbana ou sem código',
      volume: volumes.length ? Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length) : null,
    };
  }).sort((a, b) => b.km - a.km);
  const federal = rows.filter((row) => row.kind === 'Federal').reduce((sum, row) => sum + row.km, 0);
  const state = rows.filter((row) => row.kind === 'Estadual').reduce((sum, row) => sum + row.km, 0);
  const cards = element('dl');
  cards.className = 'metrics';
  target.append(cards);
  metrics(cards, [['km em rodovias federais', federal, 'OSRM/OpenStreetMap'], ['km em rodovias estaduais', state, 'OSRM/OpenStreetMap'],
    ['Estados atravessados', ufs.length, ufs.join(', ')]]);
  const table = element('div');
  const federalRoads = rows.filter((row) => row.kind === 'Federal').map((row) => row.ref).slice(0, 6);
  target.append(block('Trechos da rota', table),
    newsBlock('Obras e concessões nas rodovias do trajeto', federalRoads, 'rodovias', [
      ['Notícias do DNIT', 'https://www.gov.br/dnit/pt-br/assuntos/noticias'],
      ['Rodovias concedidas (ANTT)', 'https://www.gov.br/antt/pt-br/assuntos/rodovias'],
    ]));
  paginatedTable(table, 'Rodovias da rota', [
    ['Rodovia', 'ref'], ['km na rota', 'km'], ['Jurisdição', 'kind'], ['Veículos comerciais/dia (média da BR nos estados)', 'volume'],
  ], localPage(rows));
}

function renderEconomyRoute() {
  const target = byId('economy-route');
  if (!trajeto) return;
  const { entries, profiles, sources } = trajeto;
  const values = [...profiles.values()];
  routeHeader(target, 'Os ' + format(entries.length) + ' municípios com sede a até 25 km da rota. ' + Object.values(sources).join(' · ') + '.');
  const total = {};
  for (const [key] of SECTORS) total[key] = values.reduce((sum, item) => sum + (item[key] ?? 0), 0);
  const sectors = new Map();
  for (const item of values) {
    for (const row of item.activities) {
      if (row.section === 'Total' || !Number.isFinite(row.workers)) continue;
      sectors.set(row.activity, (sectors.get(row.activity) ?? 0) + row.workers);
    }
  }
  const workers = (section) => values.reduce((sum, item) => sum + (item.activities.find((row) => row.section === section)?.workers ?? 0), 0);
  const towns = new Map(entries.map(({ town }) => [String(town.id), town]));
  const label = (code) => towns.get(code).name + ' (' + towns.get(code).uf + ')';
  const grid = element('div');
  grid.className = 'insight-grid';
  grid.append(
    block('O que move a economia do corredor', ...sectorBar(total, 2021),
      bars([...sectors].sort((a, b) => b[1] - a[1]).slice(0, 6)), element('small', 'Pessoas ocupadas por atividade · ' + sources.activities)),
    block('Maiores economias do caminho', bars(values.filter((item) => Number.isFinite(item.value))
      .sort((a, b) => b.value - a.value).slice(0, 6).map((item) => [label(item.ibge_code), Math.round(item.value / 1000)])),
    element('small', 'PIB em R$ milhões · ' + sources.economy)),
  );
  const regions = new Map();
  for (const item of values) {
    if (!item.tourism) continue;
    const region = regions.get(item.tourism.tourism_region) ?? { name: item.tourism.tourism_region, towns: [], lodging: 0, demand: 0 };
    region.towns.push(label(item.ibge_code) + ' · ' + item.tourism.category);
    region.lodging += item.tourism.lodging_places ?? 0;
    region.demand += item.tourism.domestic_demand ?? 0;
    regions.set(region.name, region);
  }
  const regionList = element('ul');
  for (const region of [...regions.values()].sort((a, b) => b.demand - a.demand)) {
    const item = element('li');
    item.append(element('strong', region.name), element('span', ': ' + region.towns.join(', ') + '. ' +
      format(region.lodging) + ' meios de hospedagem; demanda doméstica estimada de ' + format(Math.round(region.demand)) + ' visitantes.'));
    regionList.append(item);
  }
  const cards = element('dl');
  cards.className = 'metrics';
  metrics(cards, [
    ['Em alojamento e alimentação', workers('I'), sources.activities],
    ['Em artes, cultura, esporte e recreação', workers('R'), sources.activities],
    ['Regiões turísticas no caminho', regions.size, sources.tourism],
  ]);
  const companies = entries.flatMap(({ town }) => industries[town.id] ?? []);
  const companyBlock = companies.length
    ? [element('ul'), element('small', 'Exemplos com fonte citada. Para os demais municípios, o painel mostra setores e empregos do IBGE.')]
    : [element('p', 'Sem empresas catalogadas com fonte para estes municípios. O perfil por setor e emprego vem do IBGE.')];
  if (companies.length) companyBlock[0].replaceChildren(...companyList(companies));
  const link = element('a', 'Ver como ferrovias de referência afetaram o turismo e a economia regional');
  link.href = '#mundo';
  target.append(grid,
    block('Potencial para turismo e cultura', element('p', 'Retrato atual do turismo e da cultura ao longo do caminho. O efeito de uma ferrovia sobre essas atividades depende do serviço oferecido; a aba Ferrovias do mundo reúne casos documentados.'),
      cards, regionList, link),
    block('Empresas de referência', ...companyBlock),
    newsBlock('Economia, empregos e turismo no caminho', values.filter((item) => Number.isFinite(item.value))
      .sort((a, b) => b.value - a.value).slice(0, 6).map((item) => towns.get(item.ibge_code).name), 'economia',
      [['Agência IBGE Notícias', 'https://agenciadenoticias.ibge.gov.br/'], ['Ministério do Turismo', 'https://www.gov.br/turismo/pt-br/assuntos/noticias']]));
}

function renderRouteTabs() {
  for (const [id, render] of [['seguranca', renderSafetyRoute], ['rodovias', renderRoadsRoute], ['economia', renderEconomyRoute]]) {
    try { render(); } catch (error) { console.warn(id, error); }
  }
}

async function loadTriage() {
  const status = byId('triage-status');
  const origin = byId('triage-start');
  const destination = byId('triage-end');
  status.textContent = 'Carregando pares sugeridos…';
  try {
    const [pairs, economy, municipalities, traffic] = await Promise.all([
      get('/api/cargo/pairs'), get('/api/economy/summary'), get('/assets/municipios-br.json'), get('/api/traffic'),
    ]);
    const trafego = new Map(traffic.items.map((item) => [item.uf + ':' + item.br, item.commercial]));
    let current;
    for (const id of ['impact-q', 'impact-terminais']) byId(id).addEventListener('change', () => current && showImpact(current));
    loadNorteSul();
    const label = (town) => town.name + ' (' + town.uf + ')';
    municipalities.sort((a, b) => label(a).localeCompare(label(b), 'pt-BR'));
    const towns = new Map(municipalities.map((town) => [String(town.id), town]));
    const gdp = new Map(economy.items.filter((town) => town.unit === 'Mil Reais' && Number.isFinite(town.value))
      .map((town) => [String(town.ibge_code), town.value]));
    const cache = new Map();
    origin.replaceChildren(...municipalities.filter((town) => town.uf === 'GO').map((town) => new Option(town.name, town.id)));
    destination.replaceChildren(...municipalities.map((town) => new Option(label(town), town.id)));
    origin.disabled = destination.disabled = false;
    const comparisons = new Map();
    function compare(start, end, km, accidents, tonnes, product) {
      const previous = comparisons.get(start + ':' + end) ?? {};
      comparisons.set(start + ':' + end, {
        name: label(towns.get(start)) + ' → ' + label(towns.get(end)),
        km, tonnes: tonnes ?? previous.tonnes, product: product ?? previous.product,
        accidents: accidents ?? previous.accidents,
        pib: gdp.has(start) && gdp.has(end) ? gdp.get(start) + gdp.get(end) : null,
      });
    }
    for (const pair of pairs.items) compare(pair.origin, pair.destination, pair.km, undefined, pair.tonnes, pair.product);
    const comparison = byId('triage-comparison');
    function showComparison() {
      if (!comparison.open) return;
      paginatedTable(byId('triage-table'), 'Comparação de pares', [
        ['Trajeto', 'name'], ['km rodoviários', 'km'], ['Carga (t/ano)', 'tonnes'], ['Produto principal', 'product'],
        ['Acidentes próximos', 'accidents'], ['PIB das pontas (R$ mil)', 'pib'],
      ], localPage([...comparisons.values()]));
    }
    comparison.addEventListener('toggle', showComparison);
    origin.value = pairs.items[0].origin;
    destination.value = pairs.items[0].destination;
    byId('triage-sources').textContent = 'PRF · IBGE ' + economy.reference_year + ' · ' + pairs.source;
    const button = byId('triage-search');
    const content = byId('triage-content');
    const coverage = 'Partida em Goiás e destino em qualquer município. Os pares sugeridos têm ' + pairs.min_km + ' km ou mais.';
    let latest;
    let lastRequest = 0;

    function drawRoute() {
      if (latest && !byId('ferrovias').hidden) {
        updateMap({ type: 'FeatureCollection', features: latest }, triageMap);
      }
    }

    async function showRoute() {
      const start = origin.value;
      const end = destination.value;
      if (start === end) {
        status.textContent = 'Escolha municípios diferentes para partida e destino.';
        return;
      }
      latest = undefined;
      content.hidden = true;
      button.disabled = origin.disabled = destination.disabled = true;
      status.textContent = 'Calculando a rota rodoviária e consultando a cobertura…';
      try {
        const name = label(towns.get(start)) + ' → ' + label(towns.get(end));
        const key = start + ':' + end;
        const cargoRequest = get('/api/cargo/flow?origin=' + start + '&destination=' + end)
          .catch(() => ({ coverage: 'unavailable' }));
        let route = cache.get(key);
        if (!route) {
          const coordinates = [start, end].map((id) => towns.get(id).coordinates.join(',')).join(';');
          try {
            await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1000 - (Date.now() - lastRequest))));
            lastRequest = Date.now();
            const response = await fetch('https://routing.openstreetmap.de/routed-car/route/v1/driving/' + coordinates +
              '?geometries=geojson&overview=full&steps=true&generate_hints=false', { signal: AbortSignal.timeout(12000) });
            if (!response.ok) throw new Error('Serviço de rotas indisponível');
            const [result] = (await response.json()).routes ?? [];
            if (!Number.isFinite(result?.distance) || result.geometry?.type !== 'LineString' || result.geometry.coordinates.length < 2) throw new Error('Rota não encontrada');
            const roads = new Map();
            for (const step of result.legs.flatMap((leg) => leg.steps)) {
              for (const ref of (step.ref || step.name || '').split(';').map((text) => text.trim()).filter(Boolean)) {
                roads.set(ref, (roads.get(ref) ?? 0) + step.distance / 1000);
              }
            }
            route = { km: result.distance / 1000, geometry: result.geometry,
              roads: [...roads].map(([ref, km]) => ({ ref, km })).filter(({ km }) => km >= 1) };
            cache.set(key, route);
          } catch (error) {
            console.warn('OSRM', error);
          }
        }
        const cargo = await cargoRequest;
        const cargoSource = cargo.coverage === 'present' ? cargo.source + ' · base ' + cargo.reference_year
          : cargo.coverage === 'absent' ? 'Par sem registro na matriz' : 'Matriz de cargas indisponível';
        let safety = {};
        let accidentYear;
        if (route) {
          // Só os registros no retângulo da rota: a base da PRF é nacional.
          const lons = route.geometry.coordinates.map(([lon]) => lon);
          const lats = route.geometry.coordinates.map(([, lat]) => lat);
          const pad = 0.01;
          const box = [Math.min(...lons) - pad, Math.min(...lats) - pad, Math.max(...lons) + pad, Math.max(...lats) + pad]
            .map((value) => value.toFixed(5)).join(',');
          const map = await get('/api/map/accidents?bbox=' + box);
          accidentYear = map.reference_year;
          safety = nearbyAccidents(route.geometry, map.features);
          compare(start, end, route.km, safety.accidents, cargo.tonnes, cargo.product);
          showComparison();
        }
        const pib = gdp.has(start) && gdp.has(end) ? gdp.get(start) + gdp.get(end) : null;
        metrics(byId('triage-metrics'), [
          ['Distância rodoviária (km)', route?.km, 'OSRM / OpenStreetMap'],
          ['Acidentes perto da rota', safety.accidents, 'PRF ' + (accidentYear ?? '') + ' · faixa de 500 m em rodovias federais'],
          ['Mortes nos registros próximos', safety.deaths, 'PRF ' + (accidentYear ?? '') + ' · faixa de 500 m em rodovias federais'],
          ['PIB somado das pontas (R$ mil)', pib, 'IBGE · ' + economy.reference_year],
          ['Carga total do par (t/ano)', cargo.tonnes, cargoSource],
          ['Produto com maior tonelagem', cargo.product, cargo.tonnes === 0 ? 'Nenhum volume positivo no par' : cargoSource],
        ]);
        current = { cargo, km: route?.km, safety, trafego, pib };
        showImpact(current);
        content.hidden = false;
        byId('triage-map-figure').hidden = !route;
        byId('triage-map-status').textContent = '';
        if (route) {
          latest = [{ type: 'Feature', geometry: route.geometry, properties: { name } }];
          byId('triage-map-caption').textContent = name + ' · ' + format(route.km) + ' km pela rota rodoviária de referência.';
          drawRoute();
          loadCorridor(route, start, end, towns, { name, safety, trafego, accidentYear }).then((points) => {
            if (points.length && latest?.[0]?.properties.name === name) { latest = [latest[0], ...points]; drawRoute(); }
          }).catch((error) => errorMessage(byId('corridor-status'), error, () => loadCorridor(route, start, end, towns, { name, safety, trafego, accidentYear })));
        }
        status.textContent = !route ? name + '. Não foi possível traçar a rota. Os indicadores disponíveis continuam abaixo.'
          : route.km < pairs.min_km ? name + ' tem menos de ' + pairs.min_km + ' km. Nessa distância, o frete ferroviário tende a não compensar o acesso aos terminais.' : '';
      } finally {
        button.disabled = origin.disabled = destination.disabled = false;
      }
    }
    button.addEventListener('click', showRoute);
    for (const select of [origin, destination]) select.addEventListener('change', () => {
      latest = undefined;
      content.hidden = true;
      status.textContent = origin.value === destination.value
        ? 'Escolha municípios diferentes para partida e destino.' : coverage;
    });
    byId('ferrovias').addEventListener('triage-visible', drawRoute);
    await showRoute();
  } catch (error) {
    errorMessage(status, error, loadTriage);
  }
}

// ---- Ferrovias do mundo -------------------------------------------------------------------------
const CONFIANCA = { estabelecida: 'Estabelecida', apoiada: 'Apoiada', fraca: 'Fraca' };
const EFEITOS = [['economia', 'Economia'], ['seguranca', 'Segurança'], ['ambiente', 'Ambiente'], ['turismo', 'Turismo e cultura']];

// Foto principal do artigo da Wikipedia; sem foto ou sem rede, o card fica sem imagem.
async function worldPhoto(railway) {
  const figure = element('figure');
  figure.className = 'world-photo';
  try {
    const { origin, pathname } = new URL(railway.wikipedia);
    const summary = await (await fetch(origin + '/api/rest_v1/page/summary/' + pathname.split('/wiki/')[1])).json();
    const thumb = summary.thumbnail?.source;
    if (!thumb) return null;
    const image = element('img');
    image.src = thumb.replace(/\/\d+px-/, '/500px-');
    image.onerror = () => { image.onerror = null; image.src = thumb; };
    image.alt = 'Imagem de referência: ' + railway.nome;
    image.loading = 'lazy';
    const credit = element('a', 'Imagem: Wikipedia / Wikimedia Commons');
    credit.href = railway.wikipedia;
    const caption = element('figcaption');
    caption.append(credit);
    figure.append(image, caption);
    return figure;
  } catch {
    return null;
  }
}

async function loadWorld() {
  const status = byId('world-status');
  status.textContent = 'Carregando ferrovias de referência…';
  try {
    const data = await get('/api/ferrovias-mundo');
    const cite = (ids) => {
      const span = element('span');
      span.className = 'cite';
      for (const id of ids) {
        const source = data.fontes[id];
        const link = element('a', id);
        link.href = source.url;
        link.title = `${source.titulo} — ${source.org}, ${source.data}`;
        span.append(' ', link);
      }
      return span;
    };
    const cards = data.ferrovias.map((railway) => {
      const card = element('article');
      card.className = 'world-card';
      card.append(element('small', `${railway.pais} · ${railway.tipo}`), element('h3', railway.nome), element('p', railway.resumo));
      if (railway.wikipedia) worldPhoto(railway).then((figure) => figure && card.prepend(figure));
      const figures = element('dl');
      figures.className = 'world-figures';
      for (const item of railway.numeros) {
        const row = element('div');
        const value = element('dd', item.valor);
        value.append(cite([item.fonte]));
        row.append(element('dt', item.rotulo), value);
        figures.append(row);
      }
      card.append(figures);
      for (const [key, label] of EFEITOS) {
        const effects = railway.efeitos[key] ?? [];
        const list = element('ul');
        list.append(...(effects.length ? effects.map((effect) => {
          const item = element('li', effect.texto);
          const tag = element('em', ` ${CONFIANCA[effect.confianca] ?? effect.confianca}`);
          item.append(cite(effect.fontes), tag);
          return item;
        }) : [element('li', 'Sem efeito documentado nas fontes lidas.')]));
        card.append(element('h4', label), list);
      }
      const warnings = element('ul');
      warnings.append(...railway.atencao.map((text) => element('li', text)), ...railway.lacunas.map((text) => element('li', 'Lacuna: ' + text)));
      card.append(element('h4', 'Pontos de atenção'), warnings);
      return card;
    });
    const lessons = element('ol');
    lessons.append(...data.licoes.map((lesson) => {
      const item = element('li', lesson.texto);
      item.append(cite(lesson.fontes));
      return item;
    }));
    const legend = element('p', 'Confiança: Estabelecida = documento oficial ou várias fontes independentes; Apoiada = fonte boa, ainda única; Fraca = fonte secundária, parte interessada ou sem números. Passe o mouse sobre o código da fonte para ver o documento.');
    legend.className = 'panel-note';
    byId('world-content').replaceChildren(
      element('p', data.nota),
      block('O que esses casos ensinam para o CONVIA', lessons),
      legend,
      ...cards,
    );
    status.textContent = '';
  } catch (error) {
    errorMessage(status, error, loadWorld);
  }
}

async function loadSources() {
  const status = byId('sources-status');
  status.textContent = 'Carregando fontes e cobertura…';
  try {
    const [quality, sources] = await Promise.all([get('/api/quality'), get('/api/sources')]);
    byId('version').textContent = `Versão da base: ${quality.database_version}`;
    byId('quality-notes').replaceChildren(...quality.quality.notes.map((note) => element('li', note)));
    byId('source-links').replaceChildren(...sources.map(({ name, url }) => {
      const item = element('li');
      const link = element('a', name);
      link.href = url;
      item.append(link);
      return item;
    }));
    status.textContent = '';
  } catch (error) {
    errorMessage(status, error, loadSources);
  }
}

function newsSearch(query) {
  return 'https://www.google.com/search?' + new URLSearchParams({ q: query, tbm: 'n', hl: 'pt-BR' });
}

function mostFrequent(labels) {
  const counts = new Map();
  for (const label of labels) if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6);
}

function showBars(id, rows) {
  const max = Math.max(0, ...rows.map(([, value]) => value));
  byId(id).replaceChildren(...(rows.length ? rows.map(([label, value]) => {
    const item = element('li');
    const bar = element('span');
    bar.className = 'bar-fill';
    bar.style.width = (max ? 100 * value / max : 0) + '%';
    bar.setAttribute('aria-hidden', 'true');
    item.append(element('span', label), element('strong', format(value)), bar);
    return item;
  }) : [element('li', 'Sem registros neste recorte.')]));
}

async function loadRoads() {
  const status = byId('roads-status');
  status.textContent = 'Carregando trechos…';
  try {
    const { items, total } = await get('/api/roads?limit=500');
    for (let offset = 500; offset < total; offset += 500) {
      const page = await get('/api/roads?limit=500&offset=' + offset);
      items.push(...page.items);
    }
    const select = byId('roads-filter');
    const roadName = (code) => 'BR-' + code;
    const codes = [...new Set(items.map(row => row.vl_br).filter(Boolean))].sort();
    select.replaceChildren(new Option('Todas as rodovias', ''), ...codes.map(code => new Option(roadName(code), code)));
    showBars('roads-bars', mostFrequent(items.map(row => row.vl_br && roadName(row.vl_br))));
    select.disabled = !codes.length;
    select.onchange = () => {
      const code = select.value;
      const link = byId('roads-news');
      link.href = code ? newsSearch(roadName(code) + ' Goiás obras trânsito') : 'https://www.gov.br/dnit/pt-br/assuntos/noticias';
      link.textContent = code ? 'Buscar notícias sobre a ' + roadName(code) : 'Notícias do DNIT';
      paginatedTable(byId('roads-table'), 'Trechos do DNIT', [
        ['BR', 'vl_br'], ['Início', 'ds_local_i'], ['Fim', 'ds_local_f'], ['Extensão (km)', 'vl_extensa'], ['Superfície', 'ds_legenda'],
      ], localPage(code ? items.filter(row => row.vl_br === code) : items));
    };
    select.onchange();
    status.textContent = '';
  } catch (error) {
    errorMessage(status, error, loadRoads);
  }
}

const industries = {
  5201108: [
    ['CAOA Montadora', 'Automotivo · Distrito Agroindustrial de Anápolis', 'https://www.caoa.com.br/fabrica/fabrica-de-anapolis'],
    ['Ambev', 'Indústria de bebidas', 'https://goias.gov.br/casacivil/em-menos-de-um-mes-multinacionais-confirmam-r-48-bilhoes-em-investimentos-para-goias/'],
  ],
  5205109: [
    ['HPE Automotores', 'Montagem de veículos · Catalão', 'https://www.hpeautos.com.br/'],
    ['John Deere', 'Máquinas agrícolas · Catalão', 'https://goias.gov.br/casacivil/em-menos-de-um-mes-multinacionais-confirmam-r-48-bilhoes-em-investimentos-para-goias/'],
  ],
  5218805: [
    ['BRF', 'Alimentos · BR-060, km 394', 'https://portal-api.sinir.gov.br/wp-content/uploads/2025/03/Anexo-6_RELATORIO_2023_Coalizao-Embalagens.pdf'],
  ],
};

function companyList(companies) {
  return companies.map(([name, sector, url]) => {
    const row = element('li');
    const link = element('a', name);
    link.href = url;
    row.append(link, element('span', sector));
    return row;
  });
}

async function loadEconomy() {
  const status = byId('economy-status');
  status.textContent = 'Carregando PIB municipal…';
  try {
    const [{ items, reference_year: year }, towns] = await Promise.all([
      get('/api/economy/summary?uf=GO'),
      get('/assets/municipios-br.json').then((list) => list.filter((town) => town.uf === 'GO')),
    ]);
    const name = row => row.municipality.replace(/\s*(\(GO\)| - GO)$/, '');
    const valid = items.filter(row => row.unit === 'Mil Reais' && Number.isFinite(row.value));
    showBars('economy-bars', valid.toSorted((a, b) => b.value - a.value).slice(0, 6)
      .map(row => [name(row), row.value / 1e6]));
    const select = byId('economy-town');
    select.replaceChildren(new Option('Todos os municípios', ''), ...items
      .toSorted((a, b) => name(a).localeCompare(name(b), 'pt-BR'))
      .map(row => new Option(name(row), row.ibge_code)));
    select.disabled = !items.length;
    const container = byId('economy-map');
    const L = window.L;
    const map = L?.map(container);
    const markers = map && L.featureGroup().addTo(map);
    if (map) {
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      new ResizeObserver(() => { if (container.clientWidth) map.invalidateSize({ pan: false }); }).observe(container);
    } else {
      container.textContent = 'Mapa indisponível. Consulte as empresas na lista ao lado.';
    }
    select.onchange = () => {
      const town = items.find(row => String(row.ibge_code) === select.value);
      const companies = town ? industries[select.value] ?? [] : Object.values(industries).flat();
      byId('economy-companies').replaceChildren(...(companies.length ? companyList(companies)
        : [element('li', 'Sem empresas catalogadas para este município.')]));
      for (const article of byId('economia').querySelectorAll('[data-town]')) {
        article.hidden = !!town && !!article.dataset.town && !article.dataset.town.split(' ').includes(select.value);
      }
      if (map) {
        markers.clearLayers();
        for (const place of towns) {
          if (town ? String(place.id) !== select.value : !industries[place.id]) continue;
          const popup = element('div');
          const list = element('ul');
          list.append(...companyList(industries[place.id] ?? []));
          if (!list.children.length) list.append(element('li', 'Sem empresas catalogadas neste município.'));
          popup.append(element('strong', place.name), list);
          L.marker([...place.coordinates].reverse(), { title: place.name, alt: place.name })
            .bindPopup(popup).addTo(markers);
        }
        frameMap({ map, markers });
      }
      const link = byId('economy-news');
      link.href = town ? newsSearch(name(town) + ' Goiás economia indústria empregos investimentos') : 'https://goias.gov.br/industriaecomercio/';
      link.textContent = town ? 'Buscar notícias econômicas de ' + name(town) : 'Notícias de indústria e comércio em Goiás';
      metrics(byId('economy-local'), town ? [['PIB municipal (R$ mil)', town.value, 'IBGE · ' + year]] : []);
    };
    select.onchange();
    paginatedTable(byId('economy-table'), 'PIB municipal do IBGE', [
      ['Município', 'municipality'], ['Código IBGE', 'ibge_code'], ['Ano', 'year'], ['PIB', 'value'], ['Unidade', 'unit'],
    ], localPage(items));
    status.textContent = '';
  } catch (error) {
    errorMessage(status, error, loadEconomy);
  }
}

const sections = {
  seguranca: loadSafety,
  rodovias: loadRoads,
  ferrovias: loadTriage,
  economia: loadEconomy,
  mundo: loadWorld,
  fontes: loadSources,
};

const visited = new Set();
const links = [...document.querySelectorAll('nav a')];
function navigate() {
  const fragment = location.hash.slice(1);
  const selected = Object.hasOwn(sections, fragment) ? fragment : 'ferrovias';
  for (const link of links) {
    const id = link.hash.slice(1);
    if (id === selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
    byId(id).hidden = id !== selected;
  }
  if (!visited.has(selected)) {
    visited.add(selected);
    sections[selected]();
  }
  if (selected === 'seguranca' && pendingMap) {
    updateMap(pendingMap);
    pendingMap = undefined;
  }
  if (selected === 'ferrovias') byId('ferrovias').dispatchEvent(new Event('triage-visible'));
}

byId('rail-history').addEventListener('toggle', function () {
  if (!this.open || byId('rail-table').hasChildNodes()) return;
  paginatedTable(byId('rail-table'), 'Fluxos da ANTT', [
    ['Mês', 'Mes_Ano'], ['Ferrovia', 'Ferrovia'], ['Origem', 'Estacao_Origem'], ['UF origem', 'UF_Origem'],
    ['Destino', 'Estacao_Destino'], ['UF destino', 'UF_Destino'], ['Mercadoria', 'Mercadoria_ANTT'], ['TU', 'TU'], ['TKU', 'TKU'],
  ], apiPage('/api/rail/flows'));
});

window.addEventListener('hashchange', navigate);
loadOverview();
// O trajeto padrão alimenta as abas de Segurança, Rodovias e Economia, mesmo quando se entra direto nelas.
visited.add('ferrovias');
loadTriage();
navigate();
