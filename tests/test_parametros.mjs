// node --test tests/test_parametros.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { calcular } from '../src/convia/web/parametros.js';

const jataiPederneiras = {
  toneladas: 739237.639, km: 737.25, pib: 13866538, cargaUtil: 37, terminais: 'A', percentual: 30,
  trafego: new Map([['MS:158', 2610]]),
  acidentes: [{ uf: 'MS', br: '158', classificacao_acidente: 'Com Vítimas Fatais', mortos: 1 },
    { uf: 'SP', br: '999', classificacao_acidente: 'Sem Vítimas', mortos: 0 }],
};

test('Jataí → Pederneiras, 30%, q = 37 t, terminais nas duas pontas', () => {
  const r = calcular(jataiPederneiras);
  assert.equal(Math.round(r.co2), 3384);
  assert.equal(Math.round(r.diesel / 1000), 1422);
  assert.equal(Math.round(r.viagens), 5994);
  const ferro = r.freteFerro;
  assert.equal(Math.round(r.freteRodo.min), Math.round(53.0 + 0.229 * 737.25 - 30.8));
  assert.equal(Math.round(r.economia.max / 1e4) / 100, Math.round((53.0 + 0.229 * 737.25 + 55.4 - ferro) * 221771.29 / 1e4) / 100);
  assert.ok(r.economia.min < r.economia.max);
  assert.equal(r.economiaPorT.max * r.carga, r.economia.max);
  assert.ok(r.economiaPorT.min > 0, 'em 737 km o trem compensa por tonelada');
  assert.equal(r.passagensDia.toFixed(1), (2 * 5993.8 / 365).toFixed(1));
  const exposicao = 2 * 5993.8 / 365 / 2610;
  assert.ok(Math.abs(r.mortes - 0.43 * exposicao) < 1e-5);
  assert.equal(r.semVolume, 1);
});

test('caminhão até o terminal encarece o trem em duas pontas', () => {
  const a = calcular(jataiPederneiras);
  const b = calcular({ ...jataiPederneiras, terminais: 'B' });
  assert.equal(Math.round(a.freteFerro - b.freteFerro), -78);
});

test('exportação paga caminhão só na origem', () => {
  const b = calcular({ ...jataiPederneiras, terminais: 'B' });
  const origem = calcular({ ...jataiPederneiras, terminais: 'origem' });
  assert.equal(Math.round(b.freteFerro - origem.freteFerro), 39);
});
