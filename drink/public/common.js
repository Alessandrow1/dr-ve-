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

// ---------- mapa real com Leaflet + OpenStreetMap ----------
export function mapView(cfg) {
  const center = cfg.area?.center || { lat: -5.1875, lng: -37.344 };
  const mapEl = h('div', {
    class: 'leaflet-map',
    role: 'application',
    'aria-label': 'Mapa de ruas de Mossoró com embarque, destino e motorista',
  });
  const el = h('div', { class: 'mapwrap' },
    mapEl,
    h('span', { class: 'map-note' }, 'Ruas reais · Mossoró/RN'));

  if (!globalThis.L) {
    mapEl.textContent = 'Não foi possível carregar o mapa. Verifique sua conexão e atualize a página.';
    return { el, update() {} };
  }

  const map = L.map(mapEl, {
    zoomControl: true,
    attributionControl: true,
    scrollWheelZoom: false,
  }).setView([center.lat, center.lng], 13);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  }).addTo(map);

  const pickup = L.circleMarker([center.lat, center.lng], {
    radius: 8, color: '#101010', weight: 2, fillColor: '#B8FF5C', fillOpacity: 1,
  });
  const dest = L.circleMarker([center.lat, center.lng], {
    radius: 8, color: '#101010', weight: 2, fillColor: '#FFFFFF', fillOpacity: 1,
  });
  const driver = L.circleMarker([center.lat, center.lng], {
    radius: 7, color: '#101010', weight: 2, fillColor: '#65B8FF', fillOpacity: 1,
  });
  const route = L.polyline([], {
    color: '#8BC443', weight: 5, opacity: 0.9, lineCap: 'round',
  });
  let lastRouteKey = '';

  function setMarker(marker, point) {
    if (!point || !Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lng))) {
      if (map.hasLayer(marker)) map.removeLayer(marker);
      return;
    }
    if (!map.hasLayer(marker)) marker.addTo(map);
    marker.setLatLng([Number(point.lat), Number(point.lng)]);
  }

  // O primeiro mapa pode ser criado antes de entrar no DOM; recalculamos o tamanho após a renderização.
  requestAnimationFrame(() => map.invalidateSize());

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
          map.fitBounds(route.getBounds().pad(0.18), { maxZoom: 15, animate: false });
          lastRouteKey = key;
        }
      } else {
        if (map.hasLayer(route)) map.removeLayer(route);
        lastRouteKey = '';
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
