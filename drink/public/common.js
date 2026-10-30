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

// ---------- mapa esquemático (sem provedor de mapas) ----------
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...kids) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of kids) e.append(c);
  return e;
};

export function mapView(cfg) {
  const W = 360, H = 320, b = cfg.mapBounds;
  const proj = (p) => ({
    x: Math.max(12, Math.min(W - 12, ((p.lng - b.lngMin) / (b.lngMax - b.lngMin)) * W)),
    y: Math.max(12, Math.min(H - 12, ((b.latMax - p.lat) / (b.latMax - b.latMin)) * H)),
  });
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid slice', role: 'img', 'aria-label': 'Mapa esquemático de Mossoró com embarque, destino e motorista' });
  svg.append(s('rect', { width: W, height: H, fill: '#171717' }));
  for (let i = 1; i < 9; i++) {
    svg.append(s('path', { d: `M${(W / 9) * i} 0V${H}`, stroke: '#242424', 'stroke-width': 1 }));
    svg.append(s('path', { d: `M0 ${(H / 9) * i}H${W}`, stroke: '#242424', 'stroke-width': 1 }));
  }
  for (const pl of cfg.places) {
    const p = proj(pl);
    svg.append(s('circle', { cx: p.x, cy: p.y, r: 2.5, fill: '#4a4a4a' }));
    const t = s('text', { x: p.x + 5, y: p.y + 3, 'font-size': 7.5, fill: '#767676' });
    t.textContent = pl.name;
    svg.append(t);
  }
  const route = s('path', { d: '', fill: 'none', stroke: '#B8FF5C', 'stroke-width': 3, 'stroke-dasharray': '2 7', 'stroke-linecap': 'round', opacity: 0.8 });
  const pickup = s('g', { visibility: 'hidden' }, s('circle', { r: 11, fill: 'rgba(184,255,92,.25)' }), s('circle', { r: 6, fill: '#101010', stroke: '#B8FF5C', 'stroke-width': 3 }));
  const dest = s('g', { visibility: 'hidden' }, s('rect', { x: -7, y: -7, width: 14, height: 14, rx: 3, fill: '#fff', stroke: '#101010', 'stroke-width': 2 }));
  const driver = s('g', { visibility: 'hidden', style: 'transition: transform 2.4s linear' },
    s('circle', { r: 13, fill: 'rgba(184,255,92,.3)' }), s('circle', { r: 8, fill: '#B8FF5C', stroke: '#101010', 'stroke-width': 2.5 }));
  svg.append(route, pickup, dest, driver);
  const place = (g, p) => {
    if (!p) return g.setAttribute('visibility', 'hidden');
    const q = proj(p);
    g.setAttribute('transform', `translate(${q.x} ${q.y})`);
    g.style.transform = `translate(${q.x}px, ${q.y}px)`;
    g.setAttribute('visibility', 'visible');
  };
  const el = h('div', { class: 'mapwrap' }, svg, h('span', { class: 'map-note' }, 'Mapa esquemático de demonstração'));
  return {
    el,
    update({ pickup: pk, dest: ds, driver: dr }) {
      place(pickup, pk);
      place(dest, ds);
      place(driver, dr);
      if (pk && ds) {
        const a = proj(pk), c = proj(ds);
        route.setAttribute('d', `M${a.x} ${a.y}L${c.x} ${c.y}`);
      } else route.setAttribute('d', '');
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
