// Núcleo do domínio: máquina de estados da corrida, regras de segurança e visões por perfil.
// O frontend NUNCA decide estado: apenas exibe o que este módulo confirmou.
import crypto from 'node:crypto';
import { db, persist, nextId, audit } from './store.js';
import { publish } from './events.js';
import { resolvePoint, insideServiceArea, haversineKm, lerp, roadKm } from './geo.js';
import { buildQuote, cancelFee, DEFAULT_TARIFF } from './pricing.js';
import { getProvider, recordTx, METHODS, demoPixCode } from './payments.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const STATE_LABELS = {
  aguardando_confirmacao: 'Aguardando confirmação',
  procurando_motorista: 'Procurando motorista',
  motorista_encontrado: 'Motorista encontrado',
  motorista_a_caminho: 'Motorista a caminho',
  motorista_chegou: 'Motorista chegou',
  verificacao_pre_servico: 'Verificação pré-serviço',
  servico_iniciado: 'Serviço iniciado',
  em_andamento: 'Em andamento',
  servico_concluido: 'Serviço concluído',
  cancelado: 'Cancelado',
};
export const STATES = Object.keys(STATE_LABELS);
const TERMINAL = new Set(['servico_concluido', 'cancelado']);
export const isActive = (r) => !TERMINAL.has(r.state);

export const CHECKLIST = [
  { key: 'identity', label: 'Conferi o documento do cliente e a placa do veículo' },
  { key: 'walkaround', label: 'Fiz a vistoria externa e anotei avarias já existentes' },
  { key: 'consent', label: 'O cliente consentiu o registro do estado do veículo' },
  { key: 'ready', label: 'Cinto, bancos e retrovisores ajustados; sem alertas no painel' },
  { key: 'sober', label: 'Declaro que estou apto e sem consumo de álcool ou drogas' },
];
export const EQUIPMENT_PLANS = [
  { id: 'porta_malas', label: 'Equipamento guardado no porta-malas' },
  { id: 'local_seguro', label: 'Equipamento deixado em local seguro combinado' },
  { id: 'segundo_profissional', label: 'Equipe de apoio recolhe o equipamento' },
  { id: 'inviavel', label: 'Não foi possível levar o equipamento com segurança' },
];

const PLATE_RE = /^[A-Z]{3}-?[0-9][A-Z0-9][0-9]{2}$/;
const DEMO_TRAVEL_MS = () => Math.max(300, 12000 * Number(process.env.DEMO_SPEED || 1));

const tariff = () => DEFAULT_TARIFF;
const now = () => Date.now();

const PICKUP_NO_PROGRESS_MS = 3 * 60 * 1000;
const PICKUP_LATE_GRACE_MS = 5 * 60 * 1000;
const PICKUP_GPS_FRESH_MS = 25 * 1000;
const PICKUP_ARRIVAL_RADIUS_KM = 0.12;
const DRIVER_ISSUE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DRIVER_REPEAT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DRIVER_COOLDOWN_MS = 30 * 60 * 1000;

function pickupCancellationPolicy(ride, at = now()) {
  const regularFee = cancelFee(ride.state, tariff());
  const driver = ride.driverId ? db.drivers[ride.driverId] : null;
  const progress = ride.pickupProgress;
  const cancellableStates = [
    'motorista_encontrado', 'motorista_a_caminho', 'motorista_chegou', 'verificacao_pre_servico',
  ];

  if (progress?.freeCancelReason && cancellableStates.includes(ride.state)) {
    return { fee: 0, eligible: true, reason: progress.freeCancelReason };
  }

  if (driver && !driver.isBot && progress) {
    const lateOnArrival = Boolean(progress.lateArrivalAt) &&
      ['motorista_chegou', 'verificacao_pre_servico'].includes(ride.state);
    const headingToPickup = ['motorista_encontrado', 'motorista_a_caminho'].includes(ride.state);
    const lateOnTheWay = headingToPickup &&
      Number.isFinite(progress.expectedArrivalAt) &&
      at >= progress.expectedArrivalAt + PICKUP_LATE_GRACE_MS;
    const gpsIsFresh = Boolean(driver.posAt) && at - driver.posAt <= PICKUP_GPS_FRESH_MS;
    const alreadyAtPickup = gpsIsFresh && haversineKm(driver.pos, ride.pickup) <= PICKUP_ARRIVAL_RADIUS_KM;
    const stoppedWithoutProgress = headingToPickup && !alreadyAtPickup &&
      gpsIsFresh && Number.isFinite(progress.lastProgressAt) &&
      at - progress.lastProgressAt >= PICKUP_NO_PROGRESS_MS;

    const reason = lateOnArrival || lateOnTheWay
      ? 'motorista_atrasado'
      : stoppedWithoutProgress
        ? 'motorista_sem_progresso'
        : null;
    if (reason) {
      progress.freeCancelReason = reason;
      progress.freeCancelAt = at;
      persist();
      return { fee: 0, eligible: true, reason };
    }
  }

  return { fee: regularFee, eligible: regularFee === 0, reason: null };
}

function registerDriverPickupIssue(ride, reason) {
  const driver = ride.driverId ? db.drivers[ride.driverId] : null;
  if (!driver || driver.isBot) return null;

  const at = now();
  const declaredImpediment = db.incidents.find((incident) =>
    incident.rideId === ride.id &&
    incident.by === 'motorista' &&
    ['emergencia', 'acidente', 'avaria'].includes(incident.kind) &&
    incident.at <= at
  );
  if (declaredImpediment) {
    audit('sistema', 'desempenho_motorista_justificado', driver.id, {
      rideId: ride.id, incidentId: declaredImpediment.id, reason,
    });
    persist();
    return 'justificado_por_ocorrencia';
  }

  const previous = Array.isArray(driver.pickupIssues) ? driver.pickupIssues : [];
  const recent = previous.filter((event) => event.at >= at - DRIVER_ISSUE_WINDOW_MS);
  recent.push({ at, rideId: ride.id, reason });
  driver.pickupIssues = recent;

  const last7Days = recent.filter((event) => event.at >= at - DRIVER_REPEAT_WINDOW_MS).length;
  let penalty = 'advertencia';
  if (recent.length >= 3) {
    driver.status = 'em_analise';
    driver.online = false;
    driver.cooldownUntil = 0;
    penalty = 'revisao_administrativa';
  } else if (last7Days >= 2) {
    driver.cooldownUntil = at + DRIVER_COOLDOWN_MS;
    driver.online = false;
    penalty = 'pausa_30_minutos';
  }

  db.incidents.push({
    id: nextId('inc'),
    rideId: ride.id,
    driverId: driver.id,
    by: 'sistema',
    kind: reason,
    text: reason === 'motorista_sem_progresso'
      ? 'O cliente cancelou sem custo após 3 minutos sem avanço detectável do motorista, com GPS recente.'
      : 'O cliente cancelou sem custo porque a chegada ultrapassou em pelo menos 5 minutos a previsão original.',
    at,
    status: 'em_analise',
    penalty,
  });
  audit('sistema', 'desempenho_motorista_sinalizado', driver.id, {
    rideId: ride.id, rideCode: ride.code, reason, issues7d: last7Days, issues30d: recent.length, penalty,
  });
  persist();
  publish('drivers', 'requests', {});
  return penalty;
}

// ---------- utilidades ----------
export function onlineDrivers() {
  return Object.values(db.drivers).filter((d) => d.online && d.status === 'aprovado' && !d.isBot);
}
export function driverActiveRide(driverId) {
  return Object.values(db.rides).find((r) => r.driverId === driverId && isActive(r)) || null;
}
function customerActiveRide(customerId) {
  return Object.values(db.rides).find((r) => r.customer.id === customerId && isActive(r)) || null;
}
function getRide(id) {
  const r = db.rides[id];
  if (!r) throw new HttpError(404, 'Corrida não encontrada.');
  return r;
}
function requireState(ride, states, msg) {
  if (!states.includes(ride.state)) {
    throw new HttpError(409, msg || `Ação indisponível no estado "${STATE_LABELS[ride.state]}".`, {
      state: ride.state,
    });
  }
}
function go(ride, to, by, action, extra = {}) {
  ride.state = to;
  ride.updatedAt = now();
  ride.phaseStartedAt = now();
  ride.timeline.push({ state: to, label: STATE_LABELS[to], at: now(), by, action, ...extra });
  persist();
  notify(ride);
}

export function authClient(ride, token) {
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(ride.clientToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new HttpError(403, 'Acesso negado a esta corrida.');
  }
}
export function authDriverFor(ride, driverId) {
  if (ride.driverId !== driverId) throw new HttpError(403, 'Esta corrida não está atribuída a você.');
}

// ---------- posição simulada / real ----------
function positionInfo(ride) {
  const d = ride.driverId ? db.drivers[ride.driverId] : null;
  if (!d) return { pos: null, etaMin: null };
  const T = DEMO_TRAVEL_MS();
  const elapsed = now() - (ride.phaseStartedAt || now());
  const fresh = d.posAt && now() - d.posAt < 20000 && !d.isBot;
  const q = ride.quote;
  const start = ride.driverStart || d.pos;
  switch (ride.state) {
    case 'motorista_encontrado':
      return {
        pos: fresh ? d.pos : start,
        etaMin: ride.pickupProgress?.etaOriginalMin ?? q.etaMin,
        pickupProgress: d.isBot ? 0 : null,
        gpsFresh: d.isBot ? null : Boolean(fresh),
      };
    case 'motorista_a_caminho': {
      if (!d.isBot) {
        if (fresh) {
          const km = roadKm(d.pos, ride.pickup);
          return { pos: d.pos, etaMin: Math.max(1, Math.ceil((km / tariff().avgBikeKmh) * 60)), pickupProgress: null, gpsFresh: true };
        }
        // Para motorista humano, GPS antigo fica parado na última posição: não simulamos deslocamento.
        return { pos: d.pos || start, etaMin: null, pickupProgress: null, gpsFresh: false };
      }
      const progress = Math.max(0, Math.min(1, elapsed / T));
      return {
        // A posição em linha reta fica apenas como fallback; o cliente posiciona o marcador
        // na rota viária usando pickupProgress.
        pos: lerp(start, ride.pickup, progress),
        etaMin: Math.max(1, Math.ceil(q.etaMin * (1 - progress))),
        pickupProgress: progress,
        gpsFresh: null,
      };
    }
    case 'motorista_chegou':
    case 'verificacao_pre_servico':
    case 'servico_iniciado':
      return { pos: { lat: ride.pickup.lat, lng: ride.pickup.lng }, etaMin: 0 };
    case 'em_andamento': {
      if (fresh) {
        const km = roadKm(d.pos, ride.destination);
        return { pos: d.pos, etaMin: Math.max(1, Math.ceil((km / tariff().avgCarKmh) * 60)), progress: null };
      }
      const t = Math.max(0, Math.min(1, elapsed / T));
      return {
        pos: lerp(ride.pickup, ride.destination, t),
        etaMin: Math.max(1, Math.ceil(q.durationMin * (1 - t))),
        progress: t,
      };
    }
    case 'servico_concluido':
      return { pos: { lat: ride.destination.lat, lng: ride.destination.lng }, etaMin: 0, progress: 1 };
    default:
      return { pos: null, etaMin: null };
  }
}

// ---------- visões por perfil ----------
const pt = (p) => ({ label: p.label, lat: p.lat, lng: p.lng });

export function view(ride, role) {
  const d = ride.driverId ? db.drivers[ride.driverId] : null;
  const { pos, etaMin, progress, pickupProgress, gpsFresh } = positionInfo(ride);
  const base = {
    id: ride.id,
    code: ride.code,
    state: ride.state,
    stateLabel: STATE_LABELS[ride.state],
    createdAt: ride.createdAt,
    updatedAt: ride.updatedAt,
    pickup: pt(ride.pickup),
    destination: pt(ride.destination),
    quote: ride.quote,
    timeline: ride.timeline,
    driverPosition: pos,
    driverProgress: Number.isFinite(progress) ? progress : null,
    driverPickupProgress: Number.isFinite(pickupProgress) ? pickupProgress : null,
    driverRouteStart: d?.isBot ? (ride.driverRouteStart || ride.driverStart || null) : null,
    etaMin,
    driverGpsFresh: gpsFresh ?? null,
    cancel: ride.cancel || null,
    demo: true,
    simulatedDriver: !!d?.isBot,
    vehicle: { model: ride.vehicle.model, color: ride.vehicle.color, plate: ride.vehicle.plate },
  };
  if (role === 'share') {
    return {
      code: base.code,
      state: base.state,
      stateLabel: base.stateLabel,
      pickup: base.pickup,
      destination: base.destination,
      driverPosition: base.driverPosition,
      driverProgress: base.driverProgress,
      driverPickupProgress: base.driverPickupProgress,
      driverRouteStart: base.driverRouteStart,
      etaMin: base.etaMin,
      driverGpsFresh: base.driverGpsFresh,
      driverFirstName: d ? d.name.split(' ')[0] : null,
      customerFirstName: ride.customer.name.split(' ')[0],
      vehicle: { model: ride.vehicle.model, color: ride.vehicle.color },
      demo: true,
    };
  }
  const driverPublic = d && {
    id: d.id,
    publicId: d.publicId,
    name: d.name,
    rating: Math.round(d.rating * 10) / 10,
    ratingsCount: d.ratingsCount,
    transport: d.transport,
    photoUrl: null, // foto real depende de upload + verificação de identidade (pendente)
    verification: d.isBot ? 'simulado' : 'demo',
  };
  if (role === 'driver') {
    return {
      ...base,
      customer: { firstName: ride.customer.name.split(' ')[0] },
      authorizationConfirmed: ride.authorizationConfirmed,
      driverEarning: ride.quote.driverEarning,
      verification: ride.verification
        ? { ok: ride.verification.ok, attempts: ride.verification.attempts }
        : { ok: false, attempts: ride.pinAttempts || 0 },
      checklist: CHECKLIST,
      equipmentPlans: EQUIPMENT_PLANS,
    };
  }
  // client
  const cancelPolicy = pickupCancellationPolicy(ride);
  return {
    ...base,
    customer: { name: ride.customer.name },
    driver: driverPublic,
    pin: ['motorista_encontrado', 'motorista_a_caminho', 'motorista_chegou', 'verificacao_pre_servico'].includes(
      ride.state,
    )
      ? ride.pin
      : null,
    shareUrl: ride.shareToken ? `/acompanhar.html?t=${ride.shareToken}` : null,
    paymentMethod: ride.paymentMethod,
    payment: ride.payment,
    cancelPolicy,
    currentCancelFee: isActive(ride) ? cancelPolicy.fee : 0,
    canCancel: [
      'aguardando_confirmacao',
      'procurando_motorista',
      'motorista_encontrado',
      'motorista_a_caminho',
      'motorista_chegou',
      'verificacao_pre_servico',
    ].includes(ride.state),
    rating: ride.rating || null,
    pixDemo: ride.pixDemo || null,
  };
}

function notify(ride) {
  publish(`ride:${ride.id}:client`, 'ride', view(ride, 'client'));
  publish(`ride:${ride.id}:driver`, 'ride', view(ride, 'driver'));
  if (ride.shareToken) publish(`share:${ride.shareToken}`, 'ride', view(ride, 'share'));
  publish('drivers', 'requests', {});
}

// ---------- cliente ----------
export function makeQuote(body) {
  const pickup = resolvePoint(body?.pickup);
  const dest = resolvePoint(body?.destination);
  if (!pickup) throw new HttpError(422, 'Informe o local de embarque.');
  if (!dest) throw new HttpError(422, 'Informe o destino.');
  if (!insideServiceArea(pickup) || !insideServiceArea(dest)) {
    throw new HttpError(422, 'Fora da área de atendimento. No momento atendemos somente Mossoró (RN).');
  }
  if (haversineKm(pickup, dest) < 0.3) throw new HttpError(422, 'Embarque e destino estão muito próximos.');
  return { pickup, dest, quote: buildQuote({ pickup, dest, tariff: tariff(), onlineDrivers: onlineDrivers() }) };
}

export function createRide(body) {
  const { pickup, dest, quote } = makeQuote(body);
  const c = body.customer || {};
  const name = String(c.name || '').trim();
  if (name.length < 2) throw new HttpError(422, 'Informe seu nome.');
  if (!c.id || String(c.id).length < 8) throw new HttpError(422, 'Identificação do cliente inválida.');

  const v = body.vehicle || {};
  const plate = String(v.plate || '').toUpperCase().replace(/\s/g, '');
  if (!PLATE_RE.test(plate)) throw new HttpError(422, 'Placa inválida. Use ABC-1D23 ou ABC-1234.');
  const model = String(v.model || '').trim();
  const color = String(v.color || '').trim();
  if (model.length < 2 || color.length < 3) throw new HttpError(422, 'Informe modelo e cor do veículo.');

  if (body.authorization !== true) {
    throw new HttpError(
      422,
      'É necessário confirmar que você é o proprietário ou está autorizado a usar o veículo.',
    );
  }
  const method = String(body.paymentMethod || '');
  if (!METHODS.some((m) => m.id === method)) throw new HttpError(422, 'Escolha uma forma de pagamento.');

  if (customerActiveRide(String(c.id))) throw new HttpError(409, 'Você já possui uma solicitação em andamento.');

  let share = null;
  if (body.share && body.share.consent === true && body.share.name) {
    share = { name: String(body.share.name).slice(0, 60), phone: String(body.share.phone || '').slice(0, 20) };
  }

  const id = nextId('r');
  const ride = {
    id,
    code: 'DR-' + crypto.randomInt(1000, 9999),
    state: 'aguardando_confirmacao',
    customer: { id: String(c.id), name: name.slice(0, 60), phone: String(c.phone || '').slice(0, 20) },
    pickup,
    destination: dest,
    vehicle: { model: model.slice(0, 40), color: color.slice(0, 20), plate },
    authorizationConfirmed: true,
    paymentMethod: method,
    payment: { status: 'nao_autorizado' },
    quote,
    pin: String(crypto.randomInt(0, 10000)).padStart(4, '0'),
    clientToken: crypto.randomBytes(16).toString('hex'),
    shareToken: share ? crypto.randomBytes(8).toString('hex') : null,
    shareContact: share,
    demoAuto: body.demoAuto !== false,
    driverId: null,
    declinedBy: [],
    timeline: [],
    createdAt: now(),
    updatedAt: now(),
    phaseStartedAt: now(),
  };
  ride.timeline.push({ state: ride.state, label: STATE_LABELS[ride.state], at: now(), by: 'cliente', action: 'criar' });
  db.rides[id] = ride;
  persist();
  return { ride, token: ride.clientToken };
}

export async function confirmRide(id, token) {
  const ride = getRide(id);
  authClient(ride, token);
  requireState(ride, ['aguardando_confirmacao'], 'Esta solicitação já foi confirmada ou encerrada.');
  const prov = getProvider();
  const auth = await prov.authorize({ rideId: ride.id, amount: ride.quote.total, method: ride.paymentMethod });
  requireState(ride, ['aguardando_confirmacao']);
  if (!auth.ok) throw new HttpError(402, 'Pagamento não autorizado.');
  ride.payment = { status: 'autorizado', ref: auth.ref, amount: ride.quote.total, demo: true };
  if (ride.paymentMethod === 'pix') ride.pixDemo = { code: demoPixCode(ride.id, ride.quote.total), demo: true };
  recordTx({ rideId: ride.id, type: 'autorizacao', amount: ride.quote.total, method: ride.paymentMethod, ref: auth.ref });
  go(ride, 'procurando_motorista', 'cliente', 'confirmar');
  return ride;
}

export async function cancelRide(id, who, { token, driverId, reason, fee: forcedFee } = {}) {
  const ride = getRide(id);
  if (who === 'cliente') authClient(ride, token);
  requireState(
    ride,
    [
      'aguardando_confirmacao',
      'procurando_motorista',
      'motorista_encontrado',
      'motorista_a_caminho',
      'motorista_chegou',
      'verificacao_pre_servico',
    ],
    'Após o início do serviço não é possível cancelar. Use o botão de suporte/emergência.',
  );
  const cancelPolicy = who === 'cliente' ? pickupCancellationPolicy(ride) : null;
  const policyReason = cancelPolicy?.eligible && ['motorista_sem_progresso', 'motorista_atrasado'].includes(cancelPolicy.reason)
    ? cancelPolicy.reason
    : null;
  const fee = forcedFee ?? (who === 'cliente' ? cancelPolicy.fee : 0);
  const prov = getProvider();
  if (ride.payment?.status === 'autorizado') {
    if (fee > 0) {
      const cap = await prov.capture({ ref: ride.payment.ref, amount: fee });
      recordTx({ rideId: ride.id, type: 'taxa_cancelamento', amount: fee, method: ride.paymentMethod, ref: cap.ref });
      ride.payment = { ...ride.payment, status: 'taxa_cobrada', charged: fee };
    } else {
      await prov.voidAuth({ ref: ride.payment.ref });
      recordTx({ rideId: ride.id, type: 'autorizacao_cancelada', amount: 0, method: ride.paymentMethod });
      ride.payment = { ...ride.payment, status: 'cancelado', charged: 0 };
    }
  }
  const driverPenalty = policyReason ? registerDriverPickupIssue(ride, policyReason) : null;
  ride.cancel = {
    by: who,
    reason: reason || policyReason || 'cancelado_pelo_cliente',
    fee,
    driverId: driverId || null,
    driverPenalty,
  };
  go(ride, 'cancelado', who, 'cancelar', { reason: ride.cancel.reason, fee });
  return ride;
}

export function getClientRide(id, token) {
  const ride = getRide(id);
  authClient(ride, token);
  return ride;
}
export function getRideForShare(shareToken) {
  const ride = Object.values(db.rides).find((r) => r.shareToken && r.shareToken === shareToken);
  if (!ride) throw new HttpError(404, 'Link de acompanhamento inválido ou expirado.');
  return ride;
}

export function rateRide(id, token, { stars, comment }) {
  const ride = getRide(id);
  authClient(ride, token);
  requireState(ride, ['servico_concluido'], 'Só é possível avaliar um serviço concluído.');
  if (ride.rating) throw new HttpError(409, 'Esta corrida já foi avaliada.');
  const s = Number(stars);
  if (!Number.isInteger(s) || s < 1 || s > 5) throw new HttpError(422, 'A avaliação deve ser de 1 a 5.');
  ride.rating = { stars: s, comment: String(comment || '').slice(0, 300), at: now() };
  const d = db.drivers[ride.driverId];
  if (d && !d.isBot) {
    d.rating = (d.rating * d.ratingsCount + s) / (d.ratingsCount + 1);
    d.ratingsCount += 1;
  }
  persist();
  notify(ride);
  return ride;
}

export function reportIncident(id, by, { kind, text }) {
  const ride = getRide(id);
  const kinds = ['emergencia', 'acidente', 'avaria', 'conduta', 'cobranca', 'outro'];
  if (!kinds.includes(kind)) throw new HttpError(422, 'Tipo de ocorrência inválido.');
  const inc = {
    id: nextId('inc'),
    rideId: ride.id,
    by,
    kind,
    text: String(text || '').slice(0, 1000),
    at: now(),
    status: 'aberto',
  };
  db.incidents.push(inc);
  audit(by, 'incidente_aberto', ride.id, { kind });
  persist();
  return inc;
}

export function history(customerId) {
  return Object.values(db.rides)
    .filter((r) => r.customer.id === customerId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 30)
    .map((r) => ({
      id: r.id,
      code: r.code,
      state: r.state,
      stateLabel: STATE_LABELS[r.state],
      createdAt: r.createdAt,
      pickup: r.pickup.label,
      destination: r.destination.label,
      total: r.state === 'cancelado' ? r.cancel?.fee || 0 : r.quote.total,
      token: r.clientToken, // demo: permite reabrir recibo no mesmo dispositivo
    }));
}

export function receipt(ride) {
  if (!['servico_concluido', 'cancelado'].includes(ride.state)) {
    throw new HttpError(409, 'O recibo fica disponível após o encerramento da corrida.');
  }
  const d = db.drivers[ride.driverId];
  const charged = ride.state === 'cancelado' ? ride.cancel?.fee || 0 : ride.quote.total;
  return {
    demo: true,
    aviso: 'RECIBO DE DEMONSTRAÇÃO — sem valor fiscal ou financeiro.',
    code: ride.code,
    state: ride.state,
    stateLabel: STATE_LABELS[ride.state],
    createdAt: ride.createdAt,
    finishedAt: ride.finishedAt || ride.cancel?.at || ride.updatedAt,
    pickup: ride.pickup.label,
    destination: ride.destination.label,
    driver: d ? { name: d.name, publicId: d.publicId } : null,
    vehicle: ride.vehicle,
    lines: ride.state === 'cancelado' ? [{ label: 'Taxa de cancelamento', amount: charged }] : ride.quote.lines,
    total: charged,
    paymentMethod: ride.paymentMethod,
    payment: ride.payment,
    commissionPct: ride.quote.commissionPct,
    tariffVersion: ride.quote.tariffVersion,
  };
}

// ---------- motorista ----------
function requireDriver(driverId) {
  const d = db.drivers[driverId];
  if (!d) throw new HttpError(401, 'Motorista não identificado.');
  return d;
}

export function openRequests(driverId) {
  const d = requireDriver(driverId);
  if (d.cooldownUntil > now()) {
    const remaining = Math.ceil((d.cooldownUntil - now()) / 60000);
    throw new HttpError(403, 'Pausa temporária por cancelamentos repetidos. Você poderá voltar em ' + remaining + ' min.');
  }
  if (d.status !== 'aprovado') {
    throw new HttpError(403, 'Seu cadastro está em análise pela operação após ocorrências de pontualidade.');
  }
  if (!d.online) throw new HttpError(409, 'Você está offline. Ative novamente o status Online para receber solicitações.');
  return Object.values(db.rides)
    .filter((r) => r.state === 'procurando_motorista' && !r.declinedBy.includes(driverId) && !r.demoAuto)
    .map((r) => {
      const toClient = roadKm(d.pos, r.pickup);
      return {
        id: r.id,
        code: r.code,
        pickup: pt(r.pickup),
        destination: pt(r.destination),
        distanceToClientKm: toClient,
        etaToClientMin: Math.ceil((toClient / tariff().avgBikeKmh) * 60),
        serviceKm: r.quote.distanceKm,
        serviceMin: r.quote.durationMin,
        earning: r.quote.driverEarning,
        vehicle: { model: r.vehicle.model, color: r.vehicle.color },
        customerFirstName: r.customer.name.split(' ')[0],
        createdAt: r.createdAt,
        demo: true,
      };
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function setOnline(driverId, online, pos) {
  const d = requireDriver(driverId);
  if (online && d.cooldownUntil > now()) {
    const remaining = Math.ceil((d.cooldownUntil - now()) / 60000);
    throw new HttpError(403, `Pausa temporária por cancelamentos repetidos. Tente novamente em ${remaining} min.`);
  }
  if (online && d.cooldownUntil && d.cooldownUntil <= now()) d.cooldownUntil = 0;
  if (online && d.status !== 'aprovado') {
    throw new HttpError(403, 'Seu cadastro ainda não foi aprovado pela operação.');
  }
  if (!online && driverActiveRide(driverId)) {
    throw new HttpError(409, 'Finalize o atendimento em andamento antes de ficar offline.');
  }
  d.online = !!online;
  if (pos && Number.isFinite(+pos.lat) && Number.isFinite(+pos.lng)) {
    d.pos = { lat: +pos.lat, lng: +pos.lng };
    d.posAccuracy = Number.isFinite(Number(pos.accuracy)) ? Math.max(0, Number(pos.accuracy)) : d.posAccuracy;
    d.posAt = now();
  }
  persist();
  publish('drivers', 'requests', {});
  return d;
}

export function updateLocation(driverId, pos) {
  const d = requireDriver(driverId);
  if (!pos || !Number.isFinite(+pos.lat) || !Number.isFinite(+pos.lng)) throw new HttpError(422, 'Posição inválida.');
  d.pos = { lat: +pos.lat, lng: +pos.lng };
  d.posAccuracy = Number.isFinite(Number(pos.accuracy)) ? Math.max(0, Number(pos.accuracy)) : d.posAccuracy;
  d.posAt = now();

  const ride = driverActiveRide(driverId);
  if (ride && ['motorista_encontrado', 'motorista_a_caminho'].includes(ride.state) && ride.pickupProgress) {
    const distanceKm = haversineKm(d.pos, ride.pickup);
    const accuracyKm = Math.max(0, Math.min(0.15, ((d.posAccuracy || 25) + 25) / 1000));
    const movementThresholdKm = Math.max(0.05, accuracyKm);
    if (distanceKm <= ride.pickupProgress.closestDistanceKm - movementThresholdKm) {
      ride.pickupProgress.closestDistanceKm = distanceKm;
      ride.pickupProgress.lastProgressAt = now();
      persist();
    }
    if (!ride.pickupProgress.freeCancelReason) pickupCancellationPolicy(ride);
  }
  return d;
}

export function acceptRide(id, driverId) {
  const ride = getRide(id);
  const d = requireDriver(driverId);
  requireState(ride, ['procurando_motorista'], 'Esta solicitação não está mais disponível.');
  if (d.cooldownUntil > now()) {
    const remaining = Math.ceil((d.cooldownUntil - now()) / 60000);
    throw new HttpError(403, `Pausa temporária por cancelamentos repetidos. Tente novamente em ${remaining} min.`);
  }
  if (d.status !== 'aprovado') throw new HttpError(403, 'Cadastro não aprovado.');
  if (!d.isBot && !d.online) throw new HttpError(409, 'Fique online para aceitar solicitações.');
  if (driverActiveRide(driverId)) throw new HttpError(409, 'Você já tem um atendimento em andamento.');
  ride.driverId = driverId;
  ride.driverStart = { ...d.pos };
  ride.driverRouteStart = { ...d.pos };
  const acceptedAt = now();
  const distanceKm = roadKm(d.pos, ride.pickup);
  const etaMin = Math.max(1, Math.ceil((distanceKm / tariff().avgBikeKmh) * 60));
  ride.pickupProgress = {
    acceptedAt,
    expectedArrivalAt: acceptedAt + etaMin * 60 * 1000,
    etaOriginalMin: etaMin,
    lastProgressAt: acceptedAt,
    closestDistanceKm: haversineKm(d.pos, ride.pickup),
  };
  go(ride, 'motorista_encontrado', 'motorista', 'aceitar', { driverId, etaOriginalMin: etaMin });
  return ride;
}

export function declineRide(id, driverId) {
  const ride = getRide(id);
  requireDriver(driverId);
  requireState(ride, ['procurando_motorista']);
  if (!ride.declinedBy.includes(driverId)) ride.declinedBy.push(driverId);
  persist();
  return ride;
}

export function releaseRide(id, driverId) {
  const ride = getRide(id);
  authDriverFor(ride, driverId);
  requireState(ride, ['motorista_encontrado', 'motorista_a_caminho'], 'Só é possível liberar antes de chegar ao cliente.');
  ride.declinedBy.push(driverId);
  ride.driverId = null;
  ride.driverStart = null;
  go(ride, 'procurando_motorista', 'motorista', 'liberar', { driverId });
  return ride;
}

export function departRide(id, driverId) {
  const ride = getRide(id);
  authDriverFor(ride, driverId);
  requireState(ride, ['motorista_encontrado']);
  const d = requireDriver(driverId);
  if (!ride.pickupProgress) {
    const startedAt = now();
    const distanceKm = roadKm(d.pos, ride.pickup);
    ride.pickupProgress = {
      acceptedAt: startedAt,
      expectedArrivalAt: startedAt + Math.max(1, Math.ceil((distanceKm / tariff().avgBikeKmh) * 60)) * 60 * 1000,
      etaOriginalMin: Math.max(1, Math.ceil((distanceKm / tariff().avgBikeKmh) * 60)),
      lastProgressAt: startedAt,
      closestDistanceKm: haversineKm(d.pos, ride.pickup),
    };
  }
  ride.pickupProgress.departedAt = now();
  go(ride, 'motorista_a_caminho', 'motorista', 'iniciar_deslocamento');
  return ride;
}
export function arriveRide(id, driverId) {
  const ride = getRide(id);
  authDriverFor(ride, driverId);
  requireState(ride, ['motorista_a_caminho']);
  if (ride.pickupProgress?.expectedArrivalAt &&
      now() >= ride.pickupProgress.expectedArrivalAt + PICKUP_LATE_GRACE_MS) {
    ride.pickupProgress.lateArrivalAt = now();
  }
  go(ride, 'motorista_chegou', 'motorista', 'chegar');
  return ride;
}
export function beginVerification(id, driverId) {
  const ride = getRide(id);
  authDriverFor(ride, driverId);
  requireState(ride, ['motorista_chegou']);
  ride.pinAttempts = 0;
  go(ride, 'verificacao_pre_servico', 'motorista', 'iniciar_verificacao');
  return ride;
}

export async function submitVerification(id, driverId, body) {
  const ride = getRide(id);
  authDriverFor(ride, driverId);
  requireState(ride, ['verificacao_pre_servico']);
  const plan = String(body.equipmentPlan || '');
  if (!EQUIPMENT_PLANS.some((p) => p.id === plan)) throw new HttpError(422, 'Informe como o seu equipamento será tratado.');

  // Alternativa operacional: equipamento inviável => cancela sem custo para o cliente.
  if (plan === 'inviavel') {
    db.incidents.push({
      id: nextId('inc'), rideId: ride.id, by: 'motorista', kind: 'equipamento_inviavel',
      text: String(body.notes || '').slice(0, 500), at: now(), status: 'aberto',
    });
    await cancelRide(id, 'motorista', { driverId, reason: 'equipamento_inviavel', fee: 0 });
    return ride;
  }

  const checks = body.checks || {};
  const missing = CHECKLIST.filter((c) => checks[c.key] !== true).map((c) => c.key);
  if (missing.length) throw new HttpError(422, 'Complete todos os itens do checklist.', { missing });

  const pin = String(body.pin || '');
  if (pin !== ride.pin) {
    ride.pinAttempts = (ride.pinAttempts || 0) + 1;
    persist();
    if (ride.pinAttempts >= 3) {
      db.incidents.push({
        id: nextId('inc'), rideId: ride.id, by: 'sistema', kind: 'pin_invalido_reiterado',
        text: 'Três tentativas de código de segurança inválido.', at: now(), status: 'aberto',
      });
      await cancelRide(id, 'sistema', { reason: 'falha_verificacao_identidade', fee: 0 });
      throw new HttpError(403, 'Verificação falhou 3 vezes. Solicitação encerrada por segurança.', { cancelled: true });
    }
    notify(ride);
    throw new HttpError(403, `Código de segurança incorreto. Tentativas restantes: ${3 - ride.pinAttempts}.`);
  }
  ride.verification = {
    ok: true,
    at: now(),
    driverId,
    checks,
    equipmentPlan: plan,
    notes: String(body.notes || '').slice(0, 500),
    attempts: ride.pinAttempts || 0,
  };
  ride.timeline.push({ state: ride.state, label: 'Verificação concluída', at: now(), by: 'motorista', action: 'verificar' });
  persist();
  notify(ride);
  return ride;
}

export function startService(id, driverId) {
  const ride = getRide(id);
  authDriverFor(ride, driverId);
  requireState(ride, ['verificacao_pre_servico']);
  if (!ride.verification?.ok) {
    throw new HttpError(409, 'O serviço só pode começar após a verificação de segurança (checklist e código do cliente).');
  }
  go(ride, 'servico_iniciado', 'motorista', 'iniciar_servico');
  return ride;
}
export function driveRide(id, driverId) {
  const ride = getRide(id);
  authDriverFor(ride, driverId);
  requireState(ride, ['servico_iniciado']);
  go(ride, 'em_andamento', 'motorista', 'iniciar_trajeto');
  return ride;
}

export async function finishRide(id, driverId) {
  const ride = getRide(id);
  authDriverFor(ride, driverId);
  requireState(ride, ['em_andamento']);
  const prov = getProvider();
  const cap = await prov.capture({ ref: ride.payment.ref, amount: ride.quote.total });
  requireState(ride, ['em_andamento']);
  ride.payment = { ...ride.payment, status: 'pago', charged: ride.quote.total, captureRef: cap.ref };
  recordTx({ rideId: ride.id, type: 'cobranca', amount: ride.quote.total, method: ride.paymentMethod, ref: cap.ref });
  recordTx({ rideId: ride.id, type: 'comissao_plataforma', amount: ride.quote.platformFee, method: 'interno' });
  const payout = await prov.payout({ driverId, amount: ride.quote.driverEarning });
  recordTx({ rideId: ride.id, type: 'repasse_motorista', amount: ride.quote.driverEarning, driverId, ref: payout.ref, status: 'simulado' });
  ride.finishedAt = now();
  const d = db.drivers[driverId];
  if (d) d.ridesDone += 1;
  go(ride, 'servico_concluido', 'motorista', 'finalizar');
  return ride;
}

export function earnings(driverId) {
  requireDriver(driverId);
  const done = Object.values(db.rides).filter((r) => r.driverId === driverId && r.state === 'servico_concluido');
  const fmt = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(t);
  const today = fmt(now());
  const sum = (arr) => Math.round(arr.reduce((s, r) => s + r.quote.driverEarning, 0) * 100) / 100;
  const day = done.filter((r) => fmt(r.finishedAt) === today);
  const week = done.filter((r) => now() - r.finishedAt < 7 * 864e5);
  const month = done.filter((r) => now() - r.finishedAt < 30 * 864e5);
  return {
    demo: true,
    day: { total: sum(day), rides: day.length },
    week: { total: sum(week), rides: week.length },
    month: { total: sum(month), rides: month.length },
    history: done
      .sort((a, b) => b.finishedAt - a.finishedAt)
      .slice(0, 30)
      .map((r) => ({
        code: r.code, finishedAt: r.finishedAt, pickup: r.pickup.label, destination: r.destination.label,
        km: r.quote.distanceKm, earning: r.quote.driverEarning,
      })),
  };
}

export function activeRideOfDriver(driverId) {
  requireDriver(driverId);
  return driverActiveRide(driverId);
}
export { getRide, notify };
