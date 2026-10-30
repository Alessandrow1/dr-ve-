// Regras do painel administrativo. Toda ação que altera algo grava auditoria.
// Acesso por chave única (demo). Em produção: login individual, papéis (RBAC) e MFA — PENDENTE.
import { db, persist, audit } from './store.js';
import { HttpError, STATE_LABELS, isActive } from './rides.js';
import { DEFAULT_TARIFF } from './pricing.js';
import { getProvider, recordTx } from './payments.js';
import { SERVICE_AREA, PLACES } from './geo.js';

const r2 = (n) => Math.round(n * 100) / 100;

export function listRides({ state } = {}) {
  return Object.values(db.rides)
    .filter((r) => !state || r.state === state)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 200)
    .map((r) => ({
      id: r.id, code: r.code, state: r.state, stateLabel: STATE_LABELS[r.state], createdAt: r.createdAt,
      customer: r.customer.name, driver: r.driverId ? db.drivers[r.driverId]?.name : null,
      pickup: r.pickup.label, destination: r.destination.label, total: r.quote.total,
      paymentStatus: r.payment?.status, paymentMethod: r.paymentMethod,
      cancel: r.cancel || null, active: isActive(r), simulated: !!db.drivers[r.driverId]?.isBot,
    }));
}

export function listCustomers() {
  const map = new Map();
  for (const r of Object.values(db.rides)) {
    const c = map.get(r.customer.id) || { id: r.customer.id.slice(0, 8), name: r.customer.name, rides: 0, completed: 0, cancelled: 0, spent: 0, last: 0 };
    c.rides += 1;
    if (r.state === 'servico_concluido') { c.completed += 1; c.spent += r.payment?.charged || 0; }
    if (r.state === 'cancelado') { c.cancelled += 1; c.spent += r.cancel?.fee || 0; }
    c.last = Math.max(c.last, r.createdAt);
    c.name = r.customer.name;
    map.set(r.customer.id, c);
  }
  return [...map.values()].map((c) => ({ ...c, spent: r2(c.spent) })).sort((a, b) => b.last - a.last);
}

export function listTransactions() {
  return db.transactions.slice(-300).reverse();
}

export function listIncidents() {
  return db.incidents.slice().sort((a, b) => b.at - a.at).map((i) => ({
    ...i, rideCode: db.rides[i.rideId]?.code || null,
  }));
}

export function resolveIncident(id, { note, status = 'resolvido' }) {
  const inc = db.incidents.find((i) => i.id === id);
  if (!inc) throw new HttpError(404, 'Ocorrência não encontrada.');
  if (!['em_analise', 'resolvido'].includes(status)) throw new HttpError(422, 'Situação inválida.');
  const text = String(note || '').trim();
  if (status === 'resolvido' && text.length < 5) throw new HttpError(422, 'Descreva em poucas palavras como foi resolvido.');
  inc.status = status;
  inc.resolution = { note: text.slice(0, 500), at: Date.now() };
  audit('admin', `incidente_${status}`, inc.id, { rideId: inc.rideId });
  persist();
  return inc;
}

export async function refundRide(rideId, { amount, reason }) {
  const ride = db.rides[rideId];
  if (!ride) throw new HttpError(404, 'Corrida não encontrada.');
  if (ride.payment?.status !== 'pago') throw new HttpError(409, 'Só é possível reembolsar corridas já pagas e ainda não reembolsadas.');
  const value = amount == null || amount === '' ? ride.payment.charged : Number(amount);
  if (!Number.isFinite(value) || value <= 0 || value > ride.payment.charged) {
    throw new HttpError(422, `O valor deve estar entre R$ 0,01 e o total cobrado (R$ ${ride.payment.charged.toFixed(2).replace('.', ',')}).`);
  }
  const why = String(reason || '').trim();
  if (why.length < 5) throw new HttpError(422, 'Informe o motivo do reembolso.');
  const res = await getProvider().refund({ ref: ride.payment.captureRef, amount: value });
  if (!res.ok) throw new HttpError(502, 'O provedor de pagamento recusou o reembolso.');
  if (ride.payment.status !== 'pago') throw new HttpError(409, 'Este reembolso já foi feito.');
  recordTx({ rideId, type: 'reembolso', amount: -r2(value), method: ride.paymentMethod, ref: res.ref, reason: why.slice(0, 200) });
  ride.payment = { ...ride.payment, status: 'reembolsado', refunded: r2(value) };
  audit('admin', 'reembolso', rideId, { amount: value, reason: why.slice(0, 200) });
  persist();
  return ride.payment;
}

const TARIFF_FIELDS = {
  baseFee: [0, 500], perKm: [0, 100], perMin: [0, 50], minimum: [0, 1000], freePickupKm: [0, 20], pickupFeePerKm: [0, 50],
  nightSurchargePct: [0, 200], commissionPct: [0, 60], cancelFeeEnRoute: [0, 200], cancelFeeArrived: [0, 200],
};

export function getTariff() {
  return { ...DEFAULT_TARIFF, editable: Object.keys(TARIFF_FIELDS), limits: TARIFF_FIELDS };
}

export function updateTariff(body) {
  const next = {};
  for (const [k, [min, max]] of Object.entries(TARIFF_FIELDS)) {
    if (body[k] == null) continue;
    const v = Number(body[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw new HttpError(422, `Valor inválido para "${k}": use entre ${min} e ${max}.`);
    next[k] = v;
  }
  if (!Object.keys(next).length) throw new HttpError(422, 'Nenhuma alteração informada.');
  const before = {};
  for (const k of Object.keys(next)) before[k] = DEFAULT_TARIFF[k];
  Object.assign(DEFAULT_TARIFF, next);
  DEFAULT_TARIFF.version = 'demo-' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  audit('admin', 'tarifa_alterada', DEFAULT_TARIFF.version, { antes: before, depois: next });
  persist();
  return getTariff();
}

export function areas() {
  return {
    areas: [{ name: SERVICE_AREA.name, center: SERVICE_AREA.center, radiusKm: SERVICE_AREA.radiusKm, active: true }],
    neighborhoods: PLACES.map((p) => p.name),
    editable: false,
    note: 'Cadastro de novas áreas depende de mapas reais e ainda não existe no protótipo.',
  };
}

export function metrics() {
  const rides = Object.values(db.rides);
  const done = rides.filter((r) => r.state === 'servico_concluido');
  const cancelled = rides.filter((r) => r.state === 'cancelado');
  const at = (r, s) => r.timeline.find((t) => t.state === s)?.at;
  const waits = rides
    .map((r) => (at(r, 'motorista_encontrado') && at(r, 'procurando_motorista') ? at(r, 'motorista_encontrado') - at(r, 'procurando_motorista') : null))
    .filter((x) => x != null);
  const arrivals = rides
    .map((r) => (at(r, 'motorista_chegou') && at(r, 'motorista_encontrado') ? at(r, 'motorista_chegou') - at(r, 'motorista_encontrado') : null))
    .filter((x) => x != null);
  const avg = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length / 1000) : null);
  const reasons = {};
  for (const r of cancelled) reasons[r.cancel?.reason || 'outro'] = (reasons[r.cancel?.reason || 'outro'] || 0) + 1;
  const byHour = Array(24).fill(0);
  for (const r of rides) byHour[Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'America/Fortaleza' }).format(r.createdAt)) % 24] += 1;
  const customers = new Map();
  for (const r of done) customers.set(r.customer.id, (customers.get(r.customer.id) || 0) + 1);
  const gross = r2(db.transactions.filter((t) => t.type === 'cobranca').reduce((s, t) => s + t.amount, 0)
    + db.transactions.filter((t) => t.type === 'taxa_cancelamento').reduce((s, t) => s + t.amount, 0));
  const refunds = r2(-db.transactions.filter((t) => t.type === 'reembolso').reduce((s, t) => s + t.amount, 0));
  const fees = r2(db.transactions.filter((t) => t.type === 'comissao_plataforma').reduce((s, t) => s + t.amount, 0));
  const drivers = Object.values(db.drivers).filter((d) => !d.isBot);
  return {
    demo: true,
    rides: { total: rides.length, active: rides.filter(isActive).length, completed: done.length, cancelled: cancelled.length },
    conversionPct: rides.length ? Math.round((done.length / rides.length) * 100) : null,
    cancelPct: rides.length ? Math.round((cancelled.length / rides.length) * 100) : null,
    avgSearchSec: avg(waits),
    avgArrivalSec: avg(arrivals),
    recurringCustomers: [...customers.values()].filter((n) => n > 1).length,
    totalCustomers: new Set(rides.map((r) => r.customer.id)).size,
    money: { gross, refunds, net: r2(gross - refunds), platformFees: fees },
    cancelReasons: reasons,
    byHour,
    drivers: {
      total: drivers.length, online: drivers.filter((d) => d.online).length,
      pending: drivers.filter((d) => d.status === 'em_analise').length,
    },
    openIncidents: db.incidents.filter((i) => i.status !== 'resolvido').length,
  };
}
