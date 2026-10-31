// Servidor HTTP do protótipo Dr!nk — sem dependências externas.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as S from './store.js';
import * as R from './rides.js';
import * as D from './drivers.js';
import * as A from './admin.js';
import { scheduleBot } from './dispatch.js';
import { subscribe, closeAll } from './events.js';
import { PLACES, SERVICE_AREA, MAP_BOUNDS } from './geo.js';
import { METHODS } from './payments.js';
import { DEFAULT_TARIFF } from './pricing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, '../public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const PENDING = [
  'Autenticação real de clientes e motoristas (hoje: identificação de demonstração por dispositivo)',
  'Verificação de CNH junto ao órgão de trânsito e consulta de antecedentes (provedor externo)',
  'Verificação de seguro/responsabilidade civil compatível com o serviço',
  'Provedor de pagamentos real (cartão/Pix) — hoje 100% simulado',
  'Mapas, geocodificação e rotas reais — hoje mapa esquemático com bairros aproximados',
  'Notificações push (FCM/APNs)',
  'Upload e armazenamento seguro de documentos e fotos do veículo',
  'Painel da operação: login individual, permissões por perfil e MFA (hoje: chave única de demonstração); cadastro de novas áreas; cupons e parcerias',
  'Parecer jurídico, trabalhista, securitário e de trânsito antes do lançamento',
];

const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(8).toString('hex');
const json = (res, status, body) => {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(s);
};

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 100_000) throw new R.HttpError(413, 'Requisição muito grande.');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new R.HttpError(400, 'JSON inválido.');
  }
}

// Limitador simples por IP (em produção: gateway/WAF).
const hits = new Map();
function rateLimited(ip) {
  const t = Date.now();
  const arr = (hits.get(ip) || []).filter((x) => t - x < 60000);
  arr.push(t);
  hits.set(ip, arr);
  return arr.length > 240;
}

const header = (req, k) => String(req.headers[k] || '');

// ---- rotas ----
const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

route('GET', '/api/config', async () => ({
  brand: 'Dr!nk', slogan: 'Bebeu? A gente dirige.', prototype: true,
  area: SERVICE_AREA, mapBounds: MAP_BOUNDS, places: PLACES, paymentMethods: METHODS,
  tariff: { version: DEFAULT_TARIFF.version, commissionPct: DEFAULT_TARIFF.commissionPct },
  states: R.STATE_LABELS, pendingIntegrations: PENDING,
  emergency: { police: '190', samu: '192', bombeiros: '193' },
}));

route('POST', '/api/quote', async (req) => {
  const { quote } = R.makeQuote(await readBody(req));
  return quote;
});

route('POST', '/api/rides', async (req) => {
  const { ride, token } = R.createRide(await readBody(req));
  return { token, ride: R.view(ride, 'client') };
});

route('GET', '/api/rides', async (req) => {
  const cid = header(req, 'x-customer-id');
  if (cid.length < 8) throw new R.HttpError(401, 'Cliente não identificado.');
  return { rides: R.history(cid) };
});

route('GET', '/api/rides/:id', async (req, _res, p) =>
  R.view(R.getClientRide(p.id, header(req, 'x-ride-token')), 'client'),
);

route('POST', '/api/rides/:id/confirm', async (req, _res, p) => {
  const ride = await R.confirmRide(p.id, header(req, 'x-ride-token'));
  if (ride.demoAuto) scheduleBot(ride.id);
  return R.view(ride, 'client');
});

route('POST', '/api/rides/:id/cancel', async (req, _res, p) =>
  R.view(await R.cancelRide(p.id, 'cliente', { token: header(req, 'x-ride-token') }), 'client'),
);

route('POST', '/api/rides/:id/rate', async (req, _res, p) =>
  R.view(R.rateRide(p.id, header(req, 'x-ride-token'), await readBody(req)), 'client'),
);

route('POST', '/api/rides/:id/incident', async (req, _res, p) => {
  const ride = R.getClientRide(p.id, header(req, 'x-ride-token'));
  return R.reportIncident(ride.id, 'cliente', await readBody(req));
});

route('GET', '/api/rides/:id/receipt', async (req, _res, p) =>
  R.receipt(R.getClientRide(p.id, header(req, 'x-ride-token'))),
);

route('GET', '/api/share/:token', async (_req, _res, p) => R.view(R.getRideForShare(p.token), 'share'));

// ---- motorista (identificação de DEMONSTRAÇÃO por x-driver-id; autenticação real pendente) ----
route('GET', '/api/drivers', async () => ({
  drivers: Object.values(S.db.drivers).filter((d) => !d.isBot).map(D.publicDriver),
}));
route('POST', '/api/driver/apply', async (req) => D.publicDriver(D.applyDriver(await readBody(req))));
route('GET', '/api/driver/me', async (req) => {
  const d = S.db.drivers[header(req, 'x-driver-id')];
  if (!d || d.isBot) throw new R.HttpError(401, 'Motorista não identificado.');
  return D.publicDriver(d);
});
route('POST', '/api/driver/online', async (req) => {
  const b = await readBody(req);
  return D.publicDriver(R.setOnline(header(req, 'x-driver-id'), b.online === true, b.pos));
});
route('POST', '/api/driver/location', async (req) => {
  R.updateLocation(header(req, 'x-driver-id'), await readBody(req));
  return { ok: true };
});
route('GET', '/api/driver/requests', async (req) => ({ requests: R.openRequests(header(req, 'x-driver-id')) }));
route('GET', '/api/driver/active', async (req) => {
  const ride = R.activeRideOfDriver(header(req, 'x-driver-id'));
  return { ride: ride ? R.view(ride, 'driver') : null };
});
route('GET', '/api/driver/earnings', async (req) => R.earnings(header(req, 'x-driver-id')));

const driverActions = {
  accept: (id, d) => R.acceptRide(id, d),
  decline: (id, d) => R.declineRide(id, d),
  release: (id, d) => R.releaseRide(id, d),
  depart: (id, d) => R.departRide(id, d),
  arrive: (id, d) => R.arriveRide(id, d),
  verification: (id, d) => R.beginVerification(id, d),
  start: (id, d) => R.startService(id, d),
  drive: (id, d) => R.driveRide(id, d),
  finish: (id, d) => R.finishRide(id, d),
};
route('POST', '/api/driver/rides/:id/:action', async (req, _res, p) => {
  const driverId = header(req, 'x-driver-id');
  if (!S.db.drivers[driverId]) throw new R.HttpError(401, 'Motorista não identificado.');
  if (p.action === 'verify') {
    return R.view(await R.submitVerification(p.id, driverId, await readBody(req)), 'driver');
  }
  if (p.action === 'incident') {
    const ride = R.getRide(p.id);
    R.authDriverFor(ride, driverId);
    return R.reportIncident(p.id, 'motorista', await readBody(req));
  }
  const fn = driverActions[p.action];
  if (!fn) throw new R.HttpError(404, 'Ação desconhecida.');
  return R.view(await fn(p.id, driverId), 'driver');
});

// ---- admin mínimo ----
function adminAuth(req) {
  const a = Buffer.from(header(req, 'x-admin-key'));
  const b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new R.HttpError(401, 'Chave administrativa inválida.');
}
route('GET', '/api/admin/drivers', async (req) => (adminAuth(req), { drivers: D.adminListDrivers() }));
route('POST', '/api/admin/drivers/:id/:action', async (req, _res, p) => {
  adminAuth(req);
  return D.publicDriver(D.adminSetStatus(p.id, p.action));
});
route('GET', '/api/admin/audit', async (req) => (adminAuth(req), { audit: S.db.audit.slice(-200).reverse() }));
route('GET', '/api/admin/metrics', async (req) => (adminAuth(req), A.metrics()));
route('GET', '/api/admin/rides', async (req) => (adminAuth(req), { rides: A.listRides({ state: new URL(req.url, 'http://x').searchParams.get('state') || undefined }) }));
route('GET', '/api/admin/customers', async (req) => (adminAuth(req), { customers: A.listCustomers() }));
route('GET', '/api/admin/transactions', async (req) => (adminAuth(req), { transactions: A.listTransactions() }));
route('GET', '/api/admin/incidents', async (req) => (adminAuth(req), { incidents: A.listIncidents() }));
route('POST', '/api/admin/incidents/:id/resolve', async (req, _res, p) => (adminAuth(req), A.resolveIncident(p.id, await readBody(req))));
route('POST', '/api/admin/rides/:id/refund', async (req, _res, p) => (adminAuth(req), A.refundRide(p.id, await readBody(req))));
route('GET', '/api/admin/tariff', async (req) => (adminAuth(req), A.getTariff()));
route('PUT', '/api/admin/tariff', async (req) => (adminAuth(req), A.updateTariff(await readBody(req))));
route('GET', '/api/admin/areas', async (req) => (adminAuth(req), A.areas()));

// ---- SSE ----
function handleStream(req, res, url) {
  const q = url.searchParams;
  if (q.get('ride')) {
    const ride = R.getRide(q.get('ride'));
    if (q.get('role') === 'driver') {
      R.authDriverFor(ride, q.get('driver') || '');
      subscribe(`ride:${ride.id}:driver`, res);
    } else {
      R.authClient(ride, q.get('token'));
      subscribe(`ride:${ride.id}:client`, res);
    }
    return;
  }
  if (q.get('share')) {
    const ride = R.getRideForShare(q.get('share'));
    subscribe(`share:${ride.shareToken}`, res);
    return;
  }
  if (q.get('driver')) {
    if (!S.db.drivers[q.get('driver')]) throw new R.HttpError(401, 'Motorista não identificado.');
    subscribe('drivers', res);
    return;
  }
  throw new R.HttpError(400, 'Canal inválido.');
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(PUBLIC, '.' + rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Página não encontrada.');
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: https://tile.openstreetmap.org https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; script-src 'self' https://unpkg.com; connect-src 'self' https://tile.openstreetmap.org; frame-ancestors 'none'",
  });
  fs.createReadStream(file).pipe(res);
}

export function createApp() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
      if (rateLimited(req.socket.remoteAddress)) throw new R.HttpError(429, 'Muitas requisições. Aguarde um instante.');
      if (url.pathname === '/api/stream') return handleStream(req, res, url);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (m) return json(res, 200, await r.handler(req, res, m.groups || {}));
      }
      throw new R.HttpError(404, 'Rota não encontrada.');
    } catch (e) {
      if (e instanceof R.HttpError) return json(res, e.status, { error: e.message, ...e.extra });
      console.error('[erro]', e);
      json(res, 500, { error: 'Erro interno. Tente novamente.' });
    }
  });
  server.on('close', closeAll);
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  S.load();
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => {
    console.log(`\n  Dr!nk (protótipo) rodando em http://localhost:${port}`);
    console.log(`  Cliente:   http://localhost:${port}/`);
    console.log(`  Motorista: http://localhost:${port}/motorista.html`);
    console.log(`  Operação:  http://localhost:${port}/admin.html`);
    console.log(`  Chave admin desta execução (x-admin-key): ${ADMIN_KEY}\n`);
  });
}
