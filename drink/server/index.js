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
import { scheduleBot, resumeActiveBots } from './dispatch.js';
import { subscribe, closeAll } from './events.js';
import { PLACES, SERVICE_AREA, MAP_BOUNDS, haversineKm } from './geo.js';
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
  'Rotas viárias: OSRM para carro e perfil bicycle do Valhalla, com FOSSGIS como alternativa para o motorista até o embarque; hospedagem própria e disponibilidade garantida ainda pendentes',
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

const geocodeCache = new Map();

// ---- rotas ----
const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

// Geocodificação no servidor para evitar bloqueios de CORS no navegador.
route('GET', '/api/geocode', async (req) => {
  const requestUrl = new URL(req.url, 'http://localhost');
  const query = String(requestUrl.searchParams.get('q') || '').trim();
  if (query.length < 4 || query.length > 160) {
    throw new R.HttpError(422, 'Digite pelo menos 4 caracteres para buscar o endereço.');
  }

  const cacheKey = query.toLocaleLowerCase('pt-BR');
  const cached = geocodeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const upstream = new URL('https://photon.komoot.io/api');
  upstream.searchParams.set('q', query + ', Mossoró, Rio Grande do Norte, Brasil');
  upstream.searchParams.set('lat', String(SERVICE_AREA.center.lat));
  upstream.searchParams.set('lon', String(SERVICE_AREA.center.lng));
  upstream.searchParams.set('zoom', '14');
  upstream.searchParams.set('limit', '8');
  let response;
  try {
    response = await fetch(upstream, {
      headers: {
        Accept: 'application/geo+json, application/json',
        'User-Agent': 'DrinkPrototype/0.1 (local development address lookup)',
      },
      signal: AbortSignal.timeout(12000),
    });
  } catch (error) {
    console.error('[geocode] falha de conexão com Photon:', error.message);
    throw new R.HttpError(502, 'Não foi possível conectar ao serviço de endereços. Verifique sua internet e tente novamente.');
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 160);
    const message = response.status === 429
      ? 'O serviço de endereços limitou temporariamente as consultas. Aguarde alguns instantes.'
      : response.status === 403
        ? 'O serviço de endereços recusou a consulta temporariamente.'
        : 'O serviço de endereços respondeu com erro HTTP ' + response.status + '.';
    console.error('[geocode] Photon HTTP', response.status, detail);
    throw new R.HttpError(502, message);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new R.HttpError(502, 'O serviço de endereços enviou uma resposta inválida.');
  }
  if (!data || !Array.isArray(data.features)) {
    throw new R.HttpError(502, 'A resposta do serviço de endereços está em formato inesperado.');
  }

  if (geocodeCache.size > 500) {
    for (const [key, value] of geocodeCache) {
      if (value.expiresAt <= Date.now()) geocodeCache.delete(key);
    }
    while (geocodeCache.size > 500) geocodeCache.delete(geocodeCache.keys().next().value);
  }
  geocodeCache.set(cacheKey, { data, expiresAt: Date.now() + 5 * 60 * 1000 });
  return data;
});

// Cache e limitador para respeitar o servidor público de demonstração do OSRM (máx. 1 req/s).
const routeCache = new Map();
let osrmNextAllowedAt = 0;
let osrmQueue = Promise.resolve();

function fetchRoutingLimited(url, options = {}) {
  const task = osrmQueue.then(async () => {
    const waitMs = Math.max(0, osrmNextAllowedAt - Date.now());
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    osrmNextAllowedAt = Date.now() + 1100;
    const { headers: customHeaders, ...requestOptions } = options;
    return fetch(url, {
      ...requestOptions,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'DrinkPrototype/0.1 (Mossoro RN route preview)',
        ...customHeaders,
      },
      signal: requestOptions.signal || AbortSignal.timeout(15000),
    });
  });
  osrmQueue = task.then(() => undefined, () => undefined);
  return task;
}

// Rota viária real (carro) para o mapa do cliente.
route('GET', '/api/route', async (req) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const mode = params.get('mode') === 'bike' ? 'bike' : 'car';
  const pickup = {
    lat: Number(params.get('pickupLat')),
    lng: Number(params.get('pickupLng')),
  };
  const dest = {
    lat: Number(params.get('destLat')),
    lng: Number(params.get('destLng')),
  };

  const validPoint = (p) =>
    Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
  if (!validPoint(pickup) || !validPoint(dest)) {
    throw new R.HttpError(422, 'Coordenadas inválidas para calcular a rota.');
  }
  if (haversineKm(SERVICE_AREA.center, pickup) > SERVICE_AREA.radiusKm ||
      haversineKm(SERVICE_AREA.center, dest) > SERVICE_AREA.radiusKm) {
    throw new R.HttpError(422, 'A rota precisa começar e terminar dentro da área de Mossoró.');
  }

  const cacheKey = [mode, pickup.lat, pickup.lng, dest.lat, dest.lng]
    .map((value) => typeof value === 'number' ? value.toFixed(5) : value).join(',');
  const cached = routeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  let output = null;

  // Para a bicicleta, usa primeiro o Valhalla com perfil bicycle de verdade.
  // O formato OSRM + GeoJSON permite reutilizar a mesma geometria no mapa Leaflet.
  if (mode === 'bike') {
    try {
      const response = await fetchRoutingLimited('https://valhalla1.openstreetmap.de/route', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'drink-prototype-mossoro',
        },
        body: JSON.stringify({
          locations: [
            { lat: pickup.lat, lon: pickup.lng },
            { lat: dest.lat, lon: dest.lng },
          ],
          costing: 'bicycle',
          units: 'kilometers',
          format: 'osrm',
          shape_format: 'geojson',
          directions_type: 'none',
        }),
      });
      const data = await response.json().catch(() => ({}));
      const candidate = data.routes?.[0];
      const coordinatesOut = candidate?.geometry?.coordinates;
      if (!response.ok || !candidate || !Array.isArray(coordinatesOut) ||
          coordinatesOut.length < 3 ||
          !Number.isFinite(candidate.distance) || !Number.isFinite(candidate.duration)) {
        throw new Error(data.error || data.status_message || 'Valhalla não retornou uma rota de bicicleta válida.');
      }
      output = {
        provider: 'VALHALLA-BICYCLE',
        mode,
        distanceKm: Math.round((candidate.distance / 1000) * 10) / 10,
        durationMin: Math.max(1, Math.round(candidate.duration / 60)),
        geometry: candidate.geometry,
        geometryPointCount: coordinatesOut.length,
      };
    } catch (error) {
      console.warn('[route] Valhalla bicicleta indisponível; tentando FOSSGIS:', error.message);
    }
  }

  // Alternativa para bicicleta: instância pública FOSSGIS com perfil routed-bike.
  // Para carro, mantém o OSRM original sem mudança.
  if (!output) {
    const coordinates = `${pickup.lng},${pickup.lat};${dest.lng},${dest.lat}`;
    const baseUrl = mode === 'bike'
      ? 'https://routing.openstreetmap.de/routed-bike'
      : 'https://router.project-osrm.org';
    const upstream = new URL(`${baseUrl}/route/v1/driving/${coordinates}`);
    upstream.searchParams.set('overview', 'full');
    upstream.searchParams.set('geometries', 'geojson');
    upstream.searchParams.set('steps', 'false');

    let response;
    try {
      response = await fetchRoutingLimited(upstream);
    } catch (error) {
      console.error('[route] falha de conexão com serviço de rotas:', error.message);
      throw new R.HttpError(502, 'Não foi possível conectar ao serviço de rotas. Tente novamente.');
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new R.HttpError(502, 'O serviço de rotas enviou uma resposta inválida.');
    }
    if (!response.ok || data.code !== 'Ok' || !data.routes?.[0]) {
      const detail = String(data.message || data.code || response.status).slice(0, 120);
      console.error('[route] OSRM respondeu com erro:', response.status, detail);
      if (response.status === 429 || response.status >= 500) {
        throw new R.HttpError(503, 'O serviço de rotas está ocupado ou indisponível. Tente novamente em instantes.');
      }
      throw new R.HttpError(422, 'Não foi possível encontrar um caminho pelas ruas entre esses endereços.');
    }

    const result = data.routes[0];
    const coordinatesOut = result.geometry?.coordinates;
    const minGeometryPoints = mode === 'bike' ? 3 : 2;
    if (!Array.isArray(coordinatesOut) || coordinatesOut.length < minGeometryPoints ||
        !Number.isFinite(result.distance) || !Number.isFinite(result.duration)) {
      throw new R.HttpError(502, mode === 'bike'
        ? 'O serviço de bicicleta retornou uma linha sem detalhes suficientes. Não vou mover o motorista em linha reta.'
        : 'O serviço de rotas retornou um trajeto incompleto.');
    }
    output = {
      provider: mode === 'bike' ? 'FOSSGIS-OSRM-BIKE' : 'OSRM',
      mode,
      distanceKm: Math.round((result.distance / 1000) * 10) / 10,
      durationMin: Math.max(1, Math.round(result.duration / 60)),
      geometry: result.geometry,
      geometryPointCount: coordinatesOut.length,
    };
  }

  if (routeCache.size > 300) {
    for (const [key, value] of routeCache) {
      if (value.expiresAt <= Date.now()) routeCache.delete(key);
    }
    while (routeCache.size > 300) routeCache.delete(routeCache.keys().next().value);
  }
  routeCache.set(cacheKey, { data: output, expiresAt: Date.now() + 5 * 60 * 1000 });
  return output;
});

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
      "default-src 'self'; img-src 'self' data: https://tiles.stadiamaps.com https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; script-src 'self' https://unpkg.com; connect-src 'self'; frame-ancestors 'none'",
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
  // Recupera o fluxo do motorista simulado caso o servidor tenha sido fechado no meio da corrida.
  resumeActiveBots(Object.values(S.db.rides));
  for (const ride of Object.values(S.db.rides)) {
    if (ride.state === 'procurando_motorista' && ride.demoAuto && !ride.driverId) scheduleBot(ride.id);
  }
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => {
    console.log(`\n  Dr!nk (protótipo) rodando em http://localhost:${port}`);
    console.log(`  Cliente:   http://localhost:${port}/`);
    console.log(`  Motorista: http://localhost:${port}/motorista.html`);
    console.log(`  Operação:  http://localhost:${port}/admin.html`);
    console.log(`  Chave admin desta execução (x-admin-key): ${ADMIN_KEY}\n`);
  });
}
