// Utilitários compartilhados entre cliente, motorista e página de acompanhamento.
export const $ = (s, r = document) => r.querySelector(s);

/** Construtor de DOM seguro: texto sempre como textContent (nada de innerHTML com dados). */
export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}

/** replaceChildren que ignora null/false (replaceChildren nativo escreveria "null" na tela). */
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const brl = (n) => money.format(Number(n) || 0);
const dtf = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Fortaleza' });
export const dateBR = (t) => dtf.format(new Date(t));
export const km = (n) => `${Number(n).toFixed(1).replace('.', ',')} km`;

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'c-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const store = {
  get(k, d) {
    try { const v = localStorage.getItem('drink.' + k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) { try { localStorage.setItem('drink.' + k, JSON.stringify(v)); } catch { /* sem armazenamento */ } },
  del(k) { try { localStorage.removeItem('drink.' + k); } catch { /* sem armazenamento */ } },
};

export function getTheme() {
  return store.get('theme', 'dark') === 'light' ? 'light' : 'dark';
}

export function setTheme(theme) {
  const selected = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = selected;
  store.set('theme', selected);
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.setAttribute('content', selected === 'light' ? '#ffffff' : '#101010');
  window.dispatchEvent(new CustomEvent('drink:theme-change', { detail: { theme: selected } }));
  return selected;
}

// Aplica a preferência salva antes de montar as telas.
const initialTheme = getTheme();
document.documentElement.dataset.theme = initialTheme;
const initialThemeColor = document.querySelector('meta[name="theme-color"]');
if (initialThemeColor) initialThemeColor.setAttribute('content', initialTheme === 'light' ? '#ffffff' : '#101010');

export async function api(method, url, { body, headers } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const e = new Error('Sem conexão com o servidor. Verifique sua internet e tente de novo.');
    e.offline = true;
    throw e;
  }
  let data = {};
  try { data = await res.json(); } catch { /* corpo vazio */ }
  if (!res.ok) {
    const e = new Error(data.error || 'Algo deu errado. Tente novamente.');
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

export function toast(root, msg) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  root.append(t);
  setTimeout(() => t.remove(), 3200);
}

export function modal(root, title, content) {
  const prev = document.activeElement;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const closeBtn = h('button', { class: 'btn ghost small', onclick: close }, 'Fechar');
  const back = h(
    'div',
    { class: 'modal-back', onclick: (e) => e.target === back && close() },
    h('div', { class: 'modal stack', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'row between' }, h('h2', {}, title), closeBtn), content),
  );
  document.addEventListener('keydown', onKey);
  root.append(back);
  closeBtn.focus();
  return close;
}

export function pendingList(cfg) {
  return h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Este é um protótipo. Valores, pagamentos, verificações e o mapa são simulados. Ainda falta integrar:'),
    h('ul', { class: 'muted' }, cfg.pendingIntegrations.map((p) => h('li', {}, p))));
}

/** Evento em tempo real (SSE) com reconexão automática do navegador. */
export function stream(url, onRide) {
  if (!('EventSource' in window)) return () => {};
  const es = new EventSource(url);
  es.addEventListener('ride', (e) => { try { onRide(JSON.parse(e.data)); } catch { /* ignora */ } });
  es.addEventListener('requests', () => onRide(null));
  return () => es.close();
}

// ---------- mapa escuro com Leaflet + Stadia Maps / OpenStreetMap ----------
export function mapView(cfg) {
  const center = cfg.area?.center || { lat: -5.1875, lng: -37.344 };
  const mapEl = h('div', {
    class: 'leaflet-map',
    role: 'application',
    'aria-label': 'Mapa de ruas de Mossoró com embarque, destino e localização atual',
  });
  const note = h('span', { class: 'map-note' }, 'MOSSORÓ · RN');
  const routeLegendLabel = h('span', {}, 'Motorista · rota de bicicleta');
  const routeLegend = h('div', { class: 'map-route-legend', hidden: true },
    h('i', { class: 'bike-route-swatch', 'aria-hidden': 'true' }), routeLegendLabel);
  const recenter = h('button', {
    class: 'map-recenter',
    type: 'button',
    title: 'Centralizar na minha localização',
    'aria-label': 'Centralizar na minha localização',
    onclick: locate,
  }, h('span', { 'aria-hidden': 'true' }, '⌖'));
  const el = h('div', { class: 'mapwrap' }, mapEl, note, routeLegend, recenter);

  if (!globalThis.L) {
    mapEl.textContent = 'Não foi possível carregar o mapa. Verifique sua conexão e atualize a página.';
    recenter.disabled = true;
    return { el, update() {} };
  }

  const map = L.map(mapEl, {
    zoomControl: false,
    attributionControl: true,
    scrollWheelZoom: false,
  }).setView([center.lat, center.lng], 14);

  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  const tileUrls = {
    dark: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',
    light: 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png',
  };
  const tiles = L.tileLayer(tileUrls[getTheme()], {
    maxZoom: 20,
    attribution:
      '&copy; <a href="https://stadiamaps.com/attribution/" target="_blank" rel="noopener">Stadia Maps</a> ' +
      '&copy; <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ' +
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(map);

  window.addEventListener('drink:theme-change', (event) => {
    const theme = event.detail?.theme === 'light' ? 'light' : 'dark';
    tiles.setUrl(tileUrls[theme]);
  });

  tiles.on('tileerror', () => {
    note.textContent = 'MAPA INDISPONÍVEL · confira a conexão';
    note.classList.add('map-note-error');
  });
  tiles.on('load', () => {
    note.textContent = 'MOSSORÓ · RN';
    note.classList.remove('map-note-error');
  });

  const markerStyle = (fillColor) => ({
    radius: 8, color: '#101010', weight: 2, fillColor, fillOpacity: 1,
  });
  const pickup = L.circleMarker([center.lat, center.lng], markerStyle('#B8FF5C'));
  const dest = L.circleMarker([center.lat, center.lng], markerStyle('#FFFFFF'));
  const driver = L.circleMarker([center.lat, center.lng], markerStyle('#65B8FF'));
  const user = L.circleMarker([center.lat, center.lng], {
    radius: 7, color: '#FFFFFF', weight: 3, fillColor: '#4D9FFF', fillOpacity: 1,
  });
  const route = L.polyline([], {
    color: '#B8FF5C', weight: 5, opacity: 0.96, lineCap: 'round', lineJoin: 'round',
  });
  // A rota tracejada azul representa o deslocamento de bicicleta até o embarque.
  const driverRoute = L.polyline([], {
    color: '#65B8FF', weight: 5, opacity: 0.95, dashArray: '9 8', lineCap: 'round', lineJoin: 'round',
  });
  map.attributionControl.addAttribution(
    'Rota de bicicleta: <a href="https://routing.openstreetmap.de/about.html" target="_blank" rel="noopener">FOSSGIS / OSRM</a>',
  );
  let lastRouteKey = '';
  let routeRequestId = 0;
  let routeController = null;
  let routeTimer = null;
  let routeCoordinates = [];
  let driverRouteCoordinates = [];
  let driverRouteKey = '';
  let driverRouteRequestId = 0;
  let driverRouteController = null;
  let driverRouteTimer = null;
  let lastDriverRouteOrigin = null;
  let lastDriverRouteDestination = null;
  let lastDriverRouteRequestedAt = 0;
  let currentPickupPoint = null;
  let hasFitDriverRoute = false;
  let routeSegments = [];
  let routeLengthKm = 0;
  let currentDriverPosition = null;
  let currentDriverProgress = null;
  let displayedDriverProgress = null;
  let driverAnimationFrame = null;
  let locating = false;

  function setMarker(marker, point) {
    if (!point || !Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lng))) {
      if (map.hasLayer(marker)) map.removeLayer(marker);
      return;
    }
    if (!map.hasLayer(marker)) marker.addTo(map);
    marker.setLatLng([Number(point.lat), Number(point.lng)]);
  }

  // Precalcula a extensão da rota para posicionar a simulação ao longo das ruas.
  function buildRouteSegments(coordinates) {
    routeCoordinates = Array.isArray(coordinates) ? coordinates : [];
    routeSegments = [];
    routeLengthKm = 0;
    for (let i = 1; i < routeCoordinates.length; i++) {
      const a = routeCoordinates[i - 1];
      const b = routeCoordinates[i];
      const lengthKm = haversineKm(
        { lat: Number(a[1]), lng: Number(a[0]) },
        { lat: Number(b[1]), lng: Number(b[0]) },
      );
      if (!Number.isFinite(lengthKm)) continue;
      routeSegments.push({ a, b, lengthKm, startKm: routeLengthKm });
      routeLengthKm += lengthKm;
    }
  }

  function routePointAt(progress) {
    if (!routeSegments.length || routeLengthKm <= 0) return null;
    const targetKm = Math.max(0, Math.min(1, Number(progress))) * routeLengthKm;
    for (let i = 0; i < routeSegments.length; i++) {
      const segment = routeSegments[i];
      const endKm = segment.startKm + segment.lengthKm;
      if (targetKm <= endKm || i === routeSegments.length - 1) {
        const ratio = segment.lengthKm > 0
          ? Math.max(0, Math.min(1, (targetKm - segment.startKm) / segment.lengthKm))
          : 0;
        return {
          lat: Number(segment.a[1]) + (Number(segment.b[1]) - Number(segment.a[1])) * ratio,
          lng: Number(segment.a[0]) + (Number(segment.b[0]) - Number(segment.a[0])) * ratio,
        };
      }
    }
    const last = routeCoordinates[routeCoordinates.length - 1];
    return last ? { lat: Number(last[1]), lng: Number(last[0]) } : null;
  }

  function stopDriverAnimation() {
    if (driverAnimationFrame != null) cancelAnimationFrame(driverAnimationFrame);
    driverAnimationFrame = null;
  }

  function nearestPointOnGeometry(point, coordinates, maxDistanceKm = 0.09) {
    if (!point || !Array.isArray(coordinates) || coordinates.length < 2) return point;
    const radians = point.lat * Math.PI / 180;
    const xScale = 111320 * Math.cos(radians);
    const yScale = 111320;
    let best = null;
    let bestDistanceSq = Infinity;

    for (let i = 1; i < coordinates.length; i++) {
      const a = coordinates[i - 1];
      const b = coordinates[i];
      const ax = (Number(a[0]) - point.lng) * xScale;
      const ay = (Number(a[1]) - point.lat) * yScale;
      const bx = (Number(b[0]) - point.lng) * xScale;
      const by = (Number(b[1]) - point.lat) * yScale;
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSq = dx * dx + dy * dy;
      const ratio = lengthSq > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq)) : 0;
      const x = ax + dx * ratio;
      const y = ay + dy * ratio;
      const distanceSq = x * x + y * y;
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq;
        best = {
          lat: Number(a[1]) + (Number(b[1]) - Number(a[1])) * ratio,
          lng: Number(a[0]) + (Number(b[0]) - Number(a[0])) * ratio,
        };
      }
    }
    return best && Math.sqrt(bestDistanceSq) <= maxDistanceKm * 1000 ? best : point;
  }

  function setDriverMarker(point) {
    const snapped = driverRouteCoordinates.length
      ? nearestPointOnGeometry(point, driverRouteCoordinates)
      : point;
    setMarker(driver, snapped);
    if (map.hasLayer(driver)) driver.bringToFront();
  }

  function clearDriverRoute() {
    driverRouteRequestId += 1;
    clearTimeout(driverRouteTimer);
    driverRouteTimer = null;
    driverRouteController?.abort();
    driverRouteController = null;
    if (map.hasLayer(driverRoute)) map.removeLayer(driverRoute);
    routeLegend.hidden = true;
    routeLegendLabel.textContent = 'Motorista · rota de bicicleta';
    driverRouteCoordinates = [];
    driverRouteKey = '';
    lastDriverRouteOrigin = null;
    lastDriverRouteDestination = null;
    hasFitDriverRoute = false;
    setDriverMarker(currentDriverPosition);
  }

  async function loadDriverRoadRoute(from, to, key) {
    driverRouteRequestId += 1;
    const requestId = driverRouteRequestId;
    driverRouteController?.abort();
    const controller = new AbortController();
    driverRouteController = controller;
    lastDriverRouteOrigin = { lat: Number(from.lat), lng: Number(from.lng) };
    lastDriverRouteDestination = { lat: Number(to.lat), lng: Number(to.lng) };
    lastDriverRouteRequestedAt = Date.now();
    const params = new URLSearchParams({
      mode: 'bike',
      pickupLat: String(Number(from.lat)),
      pickupLng: String(Number(from.lng)),
      destLat: String(Number(to.lat)),
      destLng: String(Number(to.lng)),
    });
    try {
      const response = await fetch(`/api/route?${params.toString()}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Não foi possível calcular a rota de bicicleta.');
      if (requestId !== driverRouteRequestId || key !== driverRouteKey) return;
      const coordinates = data.geometry?.coordinates;
      if (!Array.isArray(coordinates) || coordinates.length < 2) {
        throw new Error('O serviço de rotas não retornou o caminho do motorista.');
      }
      const distance = Number(data.distanceKm).toFixed(1).replace('.', ',');
      const duration = Math.max(1, Number(data.durationMin) || 1);
      driverRouteCoordinates = coordinates;
      driverRoute.setLatLngs(coordinates.map(([lng, lat]) => [Number(lat), Number(lng)]));
      if (!map.hasLayer(driverRoute)) driverRoute.addTo(map);
      driverRoute.bringToFront();
      routeLegendLabel.textContent = `Motorista · bicicleta · ${distance} km · ${duration} min`;
      routeLegend.hidden = false;
      pickup.bringToFront();
      dest.bringToFront();
      setDriverMarker(currentDriverPosition);
      if (!hasFitDriverRoute) {
        const bounds = driverRoute.getBounds();
        if (map.hasLayer(route)) bounds.extend(route.getBounds());
        map.fitBounds(bounds.pad(0.18), { maxZoom: 15, animate: true });
        hasFitDriverRoute = true;
      }
    } catch (error) {
      if (error.name === 'AbortError' || requestId !== driverRouteRequestId) return;
      console.warn('[map] falha ao calcular rota de bicicleta:', error);
      routeLegend.hidden = false;
      routeLegendLabel.textContent = 'Rota de bicicleta temporariamente indisponível';
      if (!map.hasLayer(route)) {
        note.textContent = 'ROTA DO MOTORISTA INDISPONÍVEL';
        note.classList.add('map-note-error');
      }
    }
  }

  function scheduleDriverRoadRoute(from, to) {
    if (!from || !to) {
      clearDriverRoute();
      return;
    }
    if (haversineKm(from, to) <= 0.08) {
      clearDriverRoute();
      return;
    }
    const moved = !lastDriverRouteOrigin ||
      haversineKm(lastDriverRouteOrigin, from) >= 0.025 ||
      !lastDriverRouteDestination ||
      haversineKm(lastDriverRouteDestination, to) >= 0.02;
    if (!moved || driverRouteTimer) return;

    const waitMs = lastDriverRouteRequestedAt
      ? Math.max(0, 4500 - (Date.now() - lastDriverRouteRequestedAt))
      : 0;
    driverRouteTimer = setTimeout(() => {
      driverRouteTimer = null;
      const latestFrom = currentDriverPosition;
      const latestTo = currentPickupPoint;
      if (!latestFrom || !latestTo || haversineKm(latestFrom, latestTo) <= 0.08) {
        clearDriverRoute();
        return;
      }
      const nextKey = [
        Number(latestFrom.lat).toFixed(5), Number(latestFrom.lng).toFixed(5),
        Number(latestTo.lat).toFixed(5), Number(latestTo.lng).toFixed(5),
      ].join(',');
      driverRouteKey = nextKey;
      loadDriverRoadRoute(latestFrom, latestTo, nextKey);
    }, waitMs);
  }

  function showDriverProgress(progress, animate = false) {
    if (progress == null || !routeSegments.length) {
      stopDriverAnimation();
      displayedDriverProgress = null;
      setDriverMarker(currentDriverPosition);
      return;
    }

    const target = Math.max(0, Math.min(1, Number(progress)));
    if (!animate || displayedDriverProgress == null || target <= displayedDriverProgress) {
      stopDriverAnimation();
      displayedDriverProgress = target;
      setDriverMarker(routePointAt(target) || currentDriverPosition);
      return;
    }

    stopDriverAnimation();
    const from = displayedDriverProgress;
    const startedAt = performance.now();
    const durationMs = 2200;
    const tick = (nowMs) => {
      const fraction = Math.max(0, Math.min(1, (nowMs - startedAt) / durationMs));
      displayedDriverProgress = from + (target - from) * fraction;
      setDriverMarker(routePointAt(displayedDriverProgress) || currentDriverPosition);
      if (fraction < 1) {
        driverAnimationFrame = requestAnimationFrame(tick);
      } else {
        displayedDriverProgress = target;
        driverAnimationFrame = null;
      }
    };
    driverAnimationFrame = requestAnimationFrame(tick);
  }

  function clearRouteGeometry() {
    routeCoordinates = [];
    routeSegments = [];
    routeLengthKm = 0;
    displayedDriverProgress = null;
    stopDriverAnimation();
  }

  function locate() {
    if (locating) return;
    if (!navigator.geolocation) {
      note.textContent = 'LOCALIZAÇÃO NÃO DISPONÍVEL NESTE APARELHO';
      return;
    }
    locating = true;
    recenter.disabled = true;
    navigator.geolocation.getCurrentPosition((position) => {
      locating = false;
      recenter.disabled = false;
      const point = { lat: position.coords.latitude, lng: position.coords.longitude };
      setMarker(user, point);
      map.flyTo([point.lat, point.lng], 16, { duration: 0.8 });
      note.textContent = 'SUA LOCALIZAÇÃO';
    }, () => {
      locating = false;
      recenter.disabled = false;
      note.textContent = 'NÃO FOI POSSÍVEL LOCALIZAR';
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  }

  requestAnimationFrame(() => requestAnimationFrame(() => map.invalidateSize({ pan: false })));

  async function loadRoadRoute(pk, ds, key, requestId, controller) {
    const params = new URLSearchParams({
      pickupLat: String(Number(pk.lat)),
      pickupLng: String(Number(pk.lng)),
      destLat: String(Number(ds.lat)),
      destLng: String(Number(ds.lng)),
    });
    try {
      const response = await fetch(`/api/route?${params.toString()}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Não foi possível calcular a rota pelas ruas.');
      if (requestId !== routeRequestId || key !== lastRouteKey) return;

      const coordinates = data.geometry?.coordinates;
      if (!Array.isArray(coordinates) || coordinates.length < 2) {
        throw new Error('O serviço de rotas não retornou um caminho válido.');
      }

      buildRouteSegments(coordinates);
      route.setLatLngs(coordinates.map(([lng, lat]) => [Number(lat), Number(lng)]));
      if (!map.hasLayer(route)) route.addTo(map);
      pickup.bringToFront();
      dest.bringToFront();
      showDriverProgress(currentDriverProgress, false);
      if (map.hasLayer(user)) user.bringToFront();
      const visibleBounds = route.getBounds();
      if (map.hasLayer(driverRoute)) visibleBounds.extend(driverRoute.getBounds());
      map.fitBounds(visibleBounds.pad(0.2), { maxZoom: 15, animate: true });

      const distance = Number(data.distanceKm).toFixed(1).replace('.', ',');
      const duration = Math.max(1, Number(data.durationMin) || 1);
      if (!map.hasLayer(driverRoute)) note.textContent = `ROTA · ${distance} km · ${duration} min`;
      note.classList.remove('map-note-error');
    } catch (error) {
      if (error.name === 'AbortError' || requestId !== routeRequestId) return;
      console.warn('[map] falha ao calcular rota viária:', error);
      if (!map.hasLayer(driverRoute)) {
        note.textContent = error.message.length > 64 ? 'ROTA INDISPONÍVEL · tente novamente' : error.message;
        note.classList.add('map-note-error');
      }
    }
  }

  function cancelRoute() {
    routeRequestId += 1;
    clearTimeout(routeTimer);
    routeController?.abort();
    routeController = null;
    if (map.hasLayer(route)) map.removeLayer(route);
    clearRouteGeometry();
    setDriverMarker(currentDriverPosition);
    lastRouteKey = '';
  }

  return {
    el,
    update({ pickup: pk, dest: ds, driver: dr, driverProgress: progress }) {
      currentDriverPosition = dr || null;
      currentPickupPoint = pk || null;
      const previousProgress = currentDriverProgress;
      currentDriverProgress = progress == null || !Number.isFinite(Number(progress))
        ? null
        : Math.max(0, Math.min(1, Number(progress)));

      setMarker(pickup, pk);
      setMarker(dest, ds);
      showDriverProgress(
        currentDriverProgress,
        previousProgress != null && currentDriverProgress != null && currentDriverProgress > previousProgress,
      );
      if (currentDriverPosition && pk) scheduleDriverRoadRoute(currentDriverPosition, pk);
      else clearDriverRoute();

      if (pk && ds) {
        const points = [[Number(pk.lat), Number(pk.lng)], [Number(ds.lat), Number(ds.lng)]];
        const key = points.map((p) => p.map((v) => v.toFixed(5)).join(',')).join('|');
        if (key !== lastRouteKey) {
          lastRouteKey = key;
          routeRequestId += 1;
          const requestId = routeRequestId;
          clearTimeout(routeTimer);
          routeController?.abort();
          const controller = new AbortController();
          routeController = controller;
          if (map.hasLayer(route)) map.removeLayer(route);
          clearRouteGeometry();
          setDriverMarker(currentDriverPosition);
          note.textContent = 'CALCULANDO ROTA PELAS RUAS...';
          note.classList.remove('map-note-error');
          map.fitBounds(L.latLngBounds(points).pad(0.2), { maxZoom: 16, animate: true });
          routeTimer = setTimeout(() => {
            loadRoadRoute(pk, ds, key, requestId, controller);
          }, 450);
        }
      } else {
        cancelRoute();
        const single = pk || ds;
        if (single) map.setView([single.lat, single.lng], 16, { animate: true });
        note.textContent = 'MOSSORÓ · RN';
        note.classList.remove('map-note-error');
      }
    },
  };
}

export function haversineKm(a, b) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
export const norm = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
