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
  const recenter = h('button', {
    class: 'map-recenter',
    type: 'button',
    title: 'Centralizar na minha localização',
    'aria-label': 'Centralizar na minha localização',
    onclick: locate,
  },
    h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' },
      h('circle', { cx: '12', cy: '12', r: '7' }),
      h('circle', { cx: '12', cy: '12', r: '2' }),
      h('path', { d: 'M12 2v3M12 19v3M2 12h3M19 12h3' })));
  const el = h('div', { class: 'mapwrap' }, mapEl, note, recenter);

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
  const tiles = L.tileLayer('https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png', {
    maxZoom: 20,
    attribution:
      '&copy; <a href="https://stadiamaps.com/attribution/" target="_blank" rel="noopener">Stadia Maps</a> ' +
      '&copy; <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ' +
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(map);

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
    color: '#B8FF5C', weight: 5, opacity: 0.92, lineCap: 'round', dashArray: '8 8',
  });
  let lastRouteKey = '';
  let locating = false;

  function setMarker(marker, point) {
    if (!point || !Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lng))) {
      if (map.hasLayer(marker)) map.removeLayer(marker);
      return;
    }
    if (!map.hasLayer(marker)) marker.addTo(map);
    marker.setLatLng([Number(point.lat), Number(point.lng)]);
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

  return {
    el,
    update({ pickup: pk, dest: ds, driver: dr }) {
      setMarker(pickup, pk);
      setMarker(dest, ds);
      setMarker(driver, dr);

      if (pk && ds) {
        const points = [[Number(pk.lat), Number(pk.lng)], [Number(ds.lat), Number(ds.lng)]];
        route.setLatLngs(points);
        if (!map.hasLayer(route)) route.addTo(map);
        const key = points.map((p) => p.map((v) => v.toFixed(5)).join(',')).join('|');
        if (key !== lastRouteKey) {
          map.fitBounds(route.getBounds().pad(0.2), { maxZoom: 16, animate: true });
          lastRouteKey = key;
        }
      } else {
        if (map.hasLayer(route)) map.removeLayer(route);
        lastRouteKey = '';
        const single = pk || ds;
        if (single) map.setView([single.lat, single.lng], 16, { animate: true });
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
