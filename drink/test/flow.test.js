import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DRINK_PERSIST = '0';
process.env.DEMO_SPEED = '0.01';
process.env.ADMIN_KEY = 'chave-de-teste';

const { createApp } = await import('../server/index.js');
const store = await import('../server/store.js');
const { resetForTests } = store;

let server, base;
before(async () => {
  resetForTests();
  server = createApp();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, url, { body, headers } = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

let n = 0;
const rideBody = (over = {}) => ({
  customer: { id: `cliente-teste-${++n}-${Date.now()}`, name: 'Ana Souza' },
  pickup: { placeId: 'centro' },
  destination: { placeId: 'nova-betania' },
  vehicle: { model: 'Onix', color: 'Prata', plate: 'ABC-1D23' },
  authorization: true,
  paymentMethod: 'pix',
  demoAuto: false,
  ...over,
});
const D = { 'x-driver-id': 'd_rafael' };
const checks = { identity: true, walkaround: true, consent: true, ready: true, sober: true };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(id, token, state, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await call('GET', `/api/rides/${id}`, { headers: { 'x-ride-token': token } });
    if (r.data.state === state) return r.data;
    await wait(50);
  }
  throw new Error(`timeout esperando ${state}`);
}

test('cotação transparente com linhas somando o total', async () => {
  const r = await call('POST', '/api/quote', { body: { pickup: { placeId: 'centro' }, destination: { placeId: 'aeroporto' } } });
  assert.equal(r.status, 200);
  const soma = Math.round(r.data.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  assert.equal(soma, r.data.total);
  assert.equal(r.data.demo, true);
  assert.ok(r.data.total >= 18);
  assert.ok(r.data.total <= 25, 'trajeto Centro–Aeroporto deve ficar abaixo de R$ 25 nesta tabela de demonstração');
  assert.equal(r.data.commissionPct, 20);
  assert.equal(Math.round((r.data.platformFee + r.data.driverEarning) * 100) / 100, r.data.total);
});

test('rejeita fora da área e dados inválidos', async () => {
  let r = await call('POST', '/api/quote', { body: { pickup: { placeId: 'centro' }, destination: { lat: -3.7, lng: -38.5 } } });
  assert.equal(r.status, 422);
  r = await call('POST', '/api/rides', { body: rideBody({ authorization: false }) });
  assert.equal(r.status, 422);
  r = await call('POST', '/api/rides', { body: rideBody({ vehicle: { model: 'Onix', color: 'Prata', plate: 'XX' } }) });
  assert.equal(r.status, 422);
});

test('fluxo manual completo com motorista real (checklist + código)', async () => {
  await call('POST', '/api/driver/online', { headers: D, body: { online: true } });
  const c = await call('POST', '/api/rides', { body: rideBody() });
  assert.equal(c.status, 200);
  const { token, ride } = c.data;
  const H = { 'x-ride-token': token };
  assert.equal(ride.state, 'aguardando_confirmacao');

  // não pode pular etapas
  let r = await call('POST', `/api/driver/rides/${ride.id}/accept`, { headers: D });
  assert.equal(r.status, 409);

  r = await call('POST', `/api/rides/${ride.id}/confirm`, { headers: H });
  assert.equal(r.data.state, 'procurando_motorista');

  const list = await call('GET', '/api/driver/requests', { headers: D });
  assert.ok(list.data.requests.some((x) => x.id === ride.id));

  r = await call('POST', `/api/driver/rides/${ride.id}/accept`, { headers: D });
  assert.equal(r.data.state, 'motorista_encontrado');
  r = await call('POST', `/api/driver/rides/${ride.id}/depart`, { headers: D });
  assert.equal(r.data.state, 'motorista_a_caminho');
  r = await call('POST', `/api/driver/rides/${ride.id}/arrive`, { headers: D });
  assert.equal(r.data.state, 'motorista_chegou');
  r = await call('POST', `/api/driver/rides/${ride.id}/start`, { headers: D });
  assert.equal(r.status, 409, 'não pode iniciar sem verificação');
  r = await call('POST', `/api/driver/rides/${ride.id}/verification`, { headers: D });
  assert.equal(r.data.state, 'verificacao_pre_servico');

  const mine = await call('GET', `/api/rides/${ride.id}`, { headers: H });
  const pin = mine.data.pin;
  assert.match(pin, /^\d{4}$/);

  // checklist incompleto
  r = await call('POST', `/api/driver/rides/${ride.id}/verify`, {
    headers: D, body: { checks: { ...checks, sober: false }, equipmentPlan: 'porta_malas', pin },
  });
  assert.equal(r.status, 422);
  // código errado
  r = await call('POST', `/api/driver/rides/${ride.id}/verify`, {
    headers: D, body: { checks, equipmentPlan: 'porta_malas', pin: pin === '0000' ? '1111' : '0000' },
  });
  assert.equal(r.status, 403);
  // ok
  r = await call('POST', `/api/driver/rides/${ride.id}/verify`, { headers: D, body: { checks, equipmentPlan: 'porta_malas', pin } });
  assert.equal(r.status, 200);
  assert.equal(r.data.verification.ok, true);

  r = await call('POST', `/api/driver/rides/${ride.id}/start`, { headers: D });
  assert.equal(r.data.state, 'servico_iniciado');
  r = await call('POST', `/api/rides/${ride.id}/cancel`, { headers: H });
  assert.equal(r.status, 409, 'sem cancelamento após início');
  r = await call('POST', `/api/driver/rides/${ride.id}/drive`, { headers: D });
  assert.equal(r.data.state, 'em_andamento');
  r = await call('POST', `/api/driver/rides/${ride.id}/finish`, { headers: D });
  assert.equal(r.data.state, 'servico_concluido');

  const rec = await call('GET', `/api/rides/${ride.id}/receipt`, { headers: H });
  assert.equal(rec.data.payment.status, 'pago');
  assert.equal(rec.data.demo, true);

  const rt = await call('POST', `/api/rides/${ride.id}/rate`, { headers: H, body: { stars: 5, comment: 'ótimo' } });
  assert.equal(rt.data.rating.stars, 5);
  const again = await call('POST', `/api/rides/${ride.id}/rate`, { headers: H, body: { stars: 4 } });
  assert.equal(again.status, 409);

  const earn = await call('GET', '/api/driver/earnings', { headers: D });
  assert.ok(earn.data.day.total > 0);
});

test('outro cliente não acessa a corrida; token errado é negado', async () => {
  const c = await call('POST', '/api/rides', { body: rideBody() });
  const r = await call('GET', `/api/rides/${c.data.ride.id}`, { headers: { 'x-ride-token': 'x'.repeat(32) } });
  assert.equal(r.status, 403);
  await call('POST', `/api/rides/${c.data.ride.id}/cancel`, { headers: { 'x-ride-token': c.data.token } });
});

test('taxa de cancelamento só após motorista a caminho; gratuito antes', async () => {
  await call('POST', '/api/driver/online', { headers: D, body: { online: true } });
  const a = await call('POST', '/api/rides', { body: rideBody() });
  const Ha = { 'x-ride-token': a.data.token };
  await call('POST', `/api/rides/${a.data.ride.id}/confirm`, { headers: Ha });
  let r = await call('POST', `/api/rides/${a.data.ride.id}/cancel`, { headers: Ha });
  assert.equal(r.data.cancel.fee, 0);

  const b = await call('POST', '/api/rides', { body: rideBody() });
  const Hb = { 'x-ride-token': b.data.token };
  await call('POST', `/api/rides/${b.data.ride.id}/confirm`, { headers: Hb });
  await call('POST', `/api/driver/rides/${b.data.ride.id}/accept`, { headers: D });
  await call('POST', `/api/driver/rides/${b.data.ride.id}/depart`, { headers: D });
  r = await call('POST', `/api/rides/${b.data.ride.id}/cancel`, { headers: Hb });
  assert.equal(r.data.cancel.fee, 8);
  assert.equal(r.data.payment.status, 'taxa_cobrada');
});

test('equipamento inviável cancela sem custo e gera ocorrência', async () => {
  await call('POST', '/api/driver/online', { headers: D, body: { online: true } });
  const c = await call('POST', '/api/rides', { body: rideBody() });
  const H = { 'x-ride-token': c.data.token };
  const id = c.data.ride.id;
  await call('POST', `/api/rides/${id}/confirm`, { headers: H });
  for (const a of ['accept', 'depart', 'arrive', 'verification']) await call('POST', `/api/driver/rides/${id}/${a}`, { headers: D });
  await call('POST', `/api/driver/rides/${id}/verify`, { headers: D, body: { equipmentPlan: 'inviavel', notes: 'não cabe' } });
  const r = await call('GET', `/api/rides/${id}`, { headers: H });
  assert.equal(r.data.state, 'cancelado');
  assert.equal(r.data.cancel.fee, 0);
  assert.equal(r.data.cancel.reason, 'equipamento_inviavel');
});

test('3 códigos errados encerram a solicitação por segurança', async () => {
  await call('POST', '/api/driver/online', { headers: D, body: { online: true } });
  const c = await call('POST', '/api/rides', { body: rideBody() });
  const H = { 'x-ride-token': c.data.token };
  const id = c.data.ride.id;
  await call('POST', `/api/rides/${id}/confirm`, { headers: H });
  for (const a of ['accept', 'depart', 'arrive', 'verification']) await call('POST', `/api/driver/rides/${id}/${a}`, { headers: D });
  const pin = (await call('GET', `/api/rides/${id}`, { headers: H })).data.pin;
  const wrong = pin === '0000' ? '1111' : '0000';
  for (let i = 0; i < 3; i++) {
    await call('POST', `/api/driver/rides/${id}/verify`, { headers: D, body: { checks, equipmentPlan: 'porta_malas', pin: wrong } });
  }
  const r = await call('GET', `/api/rides/${id}`, { headers: H });
  assert.equal(r.data.state, 'cancelado');
});

test('motorista simulado conduz o fluxo completo até concluir', async () => {
  const c = await call('POST', '/api/rides', { body: rideBody({ demoAuto: true }) });
  const H = { 'x-ride-token': c.data.token };
  await call('POST', `/api/rides/${c.data.ride.id}/confirm`, { headers: H });
  const done = await until(c.data.ride.id, c.data.token, 'servico_concluido', 15000);
  assert.equal(done.simulatedDriver, true);
  assert.equal(done.payment.status, 'pago');
  const estados = done.timeline.map((t) => t.state);
  for (const s of ['procurando_motorista', 'motorista_encontrado', 'motorista_a_caminho', 'motorista_chegou', 'verificacao_pre_servico', 'servico_iniciado', 'em_andamento', 'servico_concluido']) {
    assert.ok(estados.includes(s), `faltou ${s}`);
  }
});

test('cadastro de motorista exige dados válidos e fica em análise até aprovação', async () => {
  const valid = {
    name: 'Carlos Alberto Lima', phone: '84999990000', email: 'carlos@example.com', cpf: '529.982.247-25',
    cnhNumber: '12345678901', cnhCategory: 'B', cnhValidity: '2030-12-31', experience: 'Cinco anos como motorista.',
    pixKey: 'carlos@example.com', acceptTerms: true, acceptSafety: true,
  };
  let r = await call('POST', '/api/driver/apply', { body: { ...valid, cpf: '111.111.111-11' } });
  assert.equal(r.status, 422);
  r = await call('POST', '/api/driver/apply', { body: { ...valid, cnhValidity: '2020-01-01' } });
  assert.equal(r.status, 422);
  r = await call('POST', '/api/driver/apply', { body: valid });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'em_analise');
  assert.equal(r.data.cpf, undefined, 'dados sensíveis não são devolvidos');
  const id = r.data.id;

  r = await call('POST', '/api/driver/online', { headers: { 'x-driver-id': id }, body: { online: true } });
  assert.equal(r.status, 403, 'não pode ficar online sem aprovação');

  r = await call('POST', `/api/admin/drivers/${id}/approve`, { headers: { 'x-admin-key': 'errada' } });
  assert.equal(r.status, 401);
  r = await call('POST', `/api/admin/drivers/${id}/approve`, { headers: { 'x-admin-key': 'chave-de-teste' } });
  assert.equal(r.data.status, 'aprovado');
  r = await call('GET', '/api/admin/audit', { headers: { 'x-admin-key': 'chave-de-teste' } });
  assert.ok(r.data.audit.some((a) => a.action === 'motorista_aprovado'));
});

// ---------- painel administrativo ----------
const AD = { 'x-admin-key': 'chave-de-teste' };

test('admin: rotas exigem chave e devolvem indicadores coerentes', async () => {
  for (const u of ['metrics', 'rides', 'customers', 'transactions', 'incidents', 'tariff', 'areas']) {
    const r = await call('GET', `/api/admin/${u}`, { headers: { 'x-admin-key': 'errada' } });
    assert.equal(r.status, 401, u);
  }
  const m = await call('GET', '/api/admin/metrics', { headers: AD });
  assert.equal(m.status, 200);
  assert.ok(m.data.rides.completed >= 1);
  assert.equal(m.data.rides.total, m.data.rides.completed + m.data.rides.cancelled + m.data.rides.active);
  assert.equal(m.data.byHour.reduce((a, b) => a + b, 0), m.data.rides.total);
  const rides = await call('GET', '/api/admin/rides?state=servico_concluido', { headers: AD });
  assert.ok(rides.data.rides.every((r) => r.state === 'servico_concluido'));
  const cust = await call('GET', '/api/admin/customers', { headers: AD });
  assert.ok(cust.data.customers.length >= 1);
  assert.equal(JSON.stringify(cust.data).includes('cliente-teste'), false, 'id completo do cliente não é exposto');
});

test('admin: reembolso valida valor, registra transação e não repete', async () => {
  const rides = await call('GET', '/api/admin/rides?state=servico_concluido', { headers: AD });
  const paid = rides.data.rides.find((r) => r.paymentStatus === 'pago');
  assert.ok(paid);
  let r = await call('POST', `/api/admin/rides/${paid.id}/refund`, { headers: AD, body: { amount: 9999, reason: 'valor alto demais' } });
  assert.equal(r.status, 422);
  r = await call('POST', `/api/admin/rides/${paid.id}/refund`, { headers: AD, body: { reason: '' } });
  assert.equal(r.status, 422);
  r = await call('POST', `/api/admin/rides/${paid.id}/refund`, { headers: AD, body: { amount: 10, reason: 'avaria confirmada' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'reembolsado');
  r = await call('POST', `/api/admin/rides/${paid.id}/refund`, { headers: AD, body: { reason: 'tentativa repetida' } });
  assert.equal(r.status, 409);
  const tx = await call('GET', '/api/admin/transactions', { headers: AD });
  assert.ok(tx.data.transactions.some((t) => t.type === 'reembolso' && t.amount === -10));
});

test('admin: incidentes são resolvidos com justificativa e auditados', async () => {
  const inc = await call('GET', '/api/admin/incidents', { headers: AD });
  const open = inc.data.incidents.find((i) => i.status === 'aberto');
  assert.ok(open, 'há ocorrência aberta dos testes anteriores');
  let r = await call('POST', `/api/admin/incidents/${open.id}/resolve`, { headers: AD, body: { note: '' } });
  assert.equal(r.status, 422);
  r = await call('POST', `/api/admin/incidents/${open.id}/resolve`, { headers: AD, body: { note: 'Cliente contatado e caso encerrado.' } });
  assert.equal(r.data.status, 'resolvido');
  const a = await call('GET', '/api/admin/audit', { headers: AD });
  assert.ok(a.data.audit.some((x) => x.action === 'incidente_resolvido'));
  assert.ok(a.data.audit.some((x) => x.action === 'reembolso'));
});

test('admin: tarifa valida limites, só afeta novos pedidos e é auditada', async () => {
  const before = await call('POST', '/api/quote', { body: { pickup: { placeId: 'centro' }, destination: { placeId: 'aeroporto' } } });
  let r = await call('PUT', '/api/admin/tariff', { headers: AD, body: { commissionPct: 99 } });
  assert.equal(r.status, 422);
  r = await call('PUT', '/api/admin/tariff', { headers: AD, body: { baseFee: 'abc' } });
  assert.equal(r.status, 422);
  r = await call('PUT', '/api/admin/tariff', { headers: AD, body: {} });
  assert.equal(r.status, 422);
  const c = await call('POST', '/api/rides', { body: rideBody() });
  r = await call('PUT', '/api/admin/tariff', { headers: AD, body: { baseFee: 40 } });
  assert.equal(r.status, 200);
  assert.equal(r.data.baseFee, 40);
  const after = await call('POST', '/api/quote', { body: { pickup: { placeId: 'centro' }, destination: { placeId: 'aeroporto' } } });
  assert.ok(after.data.total > before.data.total);
  const old = await call('GET', `/api/rides/${c.data.ride.id}`, { headers: { 'x-ride-token': c.data.token } });
  assert.equal(old.data.quote.total, c.data.ride.quote.total, 'corrida existente mantém o preço');
  const a = await call('GET', '/api/admin/audit', { headers: AD });
  assert.ok(a.data.audit.some((x) => x.action === 'tarifa_alterada'));
  await call('PUT', '/api/admin/tariff', { headers: AD, body: { baseFee: 7 } });
  await call('POST', `/api/rides/${c.data.ride.id}/cancel`, { headers: { 'x-ride-token': c.data.token } });
});

test('motorista simulado atende dois pedidos simultâneos, um de cada vez', async () => {
  const a = await call('POST', '/api/rides', { body: rideBody({ demoAuto: true }) });
  const b = await call('POST', '/api/rides', { body: rideBody({ demoAuto: true }) });
  await call('POST', `/api/rides/${a.data.ride.id}/confirm`, { headers: { 'x-ride-token': a.data.token } });
  await call('POST', `/api/rides/${b.data.ride.id}/confirm`, { headers: { 'x-ride-token': b.data.token } });
  await until(a.data.ride.id, a.data.token, 'servico_concluido', 30000);
  await until(b.data.ride.id, b.data.token, 'servico_concluido', 30000);
});
test('cliente cancela sem custo por falta de avanço ou atraso, com penalidade progressiva ao motorista', async () => {
  resetForTests();

  async function startedRide() {
    await call('POST', '/api/driver/online', {
      headers: D,
      body: { online: true, pos: { lat: -5.19, lng: -37.341, accuracy: 12 } },
    });
    const created = await call('POST', '/api/rides', { body: rideBody() });
    const H = { 'x-ride-token': created.data.token };
    const id = created.data.ride.id;
    await call('POST', `/api/rides/${id}/confirm`, { headers: H });
    await call('POST', `/api/driver/rides/${id}/accept`, { headers: D });
    await call('POST', `/api/driver/rides/${id}/depart`, { headers: D });
    return { id, H };
  }

  const first = await startedRide();
  store.db.rides[first.id].pickupProgress.lastProgressAt = Date.now() - 3 * 60 * 1000 - 1000;
  store.db.drivers.d_rafael.posAt = Date.now();
  let r = await call('GET', `/api/rides/${first.id}`, { headers: first.H });
  assert.equal(r.data.cancelPolicy.eligible, true);
  assert.equal(r.data.cancelPolicy.reason, 'motorista_sem_progresso');
  r = await call('POST', `/api/rides/${first.id}/cancel`, { headers: first.H });
  assert.equal(r.data.cancel.fee, 0);
  assert.equal(r.data.cancel.reason, 'motorista_sem_progresso');
  assert.equal(store.db.drivers.d_rafael.pickupIssues.length, 1);

  const second = await startedRide();
  store.db.rides[second.id].pickupProgress.expectedArrivalAt = Date.now() - 5 * 60 * 1000 - 1000;
  // Sem GPS recente, o critério de atraso continua válido; o critério de parada não.
  store.db.drivers.d_rafael.posAt = 0;
  r = await call('GET', `/api/rides/${second.id}`, { headers: second.H });
  assert.equal(r.data.cancelPolicy.eligible, true);
  assert.equal(r.data.cancelPolicy.reason, 'motorista_atrasado');
  r = await call('POST', `/api/rides/${second.id}/cancel`, { headers: second.H });
  assert.equal(r.data.cancel.fee, 0);
  assert.equal(r.data.cancel.reason, 'motorista_atrasado');
  assert.equal(store.db.drivers.d_rafael.pickupIssues.length, 2);
  assert.equal(store.db.drivers.d_rafael.online, false);
  assert.ok(store.db.drivers.d_rafael.cooldownUntil > Date.now());

  r = await call('POST', '/api/driver/online', {
    headers: D,
    body: { online: true, pos: { lat: -5.19, lng: -37.341, accuracy: 12 } },
  });
  assert.equal(r.status, 403, 'motorista com reincidência deve entrar em pausa de 30 minutos');

  const admin = await call('GET', '/api/admin/drivers', { headers: AD });
  const driver = admin.data.drivers.find((x) => x.id === 'd_rafael');
  assert.equal(driver.pickupReliability.issues30d, 2);
});

