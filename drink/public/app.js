// Aplicativo do cliente. O estado da corrida vem SEMPRE do backend: nada é exibido como confirmado sem resposta dele.
import { $, h, api, brl, dateBR, km, uid, store, toast, modal, pendingList, stream, mapView, haversineKm, norm, fill, getTheme, setTheme } from './common.js';

const root = $('#app');
let cfg;
let me = store.get('me', null);
if (!me) { me = { id: uid(), name: '', phone: '' }; store.set('me', me); }

const S = {
  pickup: null, // endereço selecionado pelo cliente ou localização atual
  dest: null, // endereço selecionado pelo cliente
  quote: null,
  pay: store.get('pay', 'pix'),
  ride: null,
  token: null,
  stopStream: null,
  poll: null,
};
const authH = () => ({ 'x-ride-token': S.token });
const placeName = (p) => (p?.placeId ? cfg.places.find((x) => x.id === p.placeId)?.name : p?.label) || '';
const placePoint = (p) => (p?.placeId ? cfg.places.find((x) => x.id === p.placeId) : p);

const MENU_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
const KEY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="#101010" stroke-width="2.4" stroke-linecap="round"><circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v4M21 12v3"/></svg>';
const svgNode = (markup) => { const d = document.createElement('div'); d.innerHTML = markup; return d.firstChild; };

// ---------- estrutura comum ----------
function frame(...children) {
  stopLive();
  root.replaceChildren(
    h('div', { class: 'demo-bar' }, h('span', {}, 'Protótipo: valores e verificações simulados'),
      h('button', { onclick: () => modal(root, 'O que falta integrar', pendingList(cfg)) }, 'Ver o que falta')),
    ...children,
  );
}
function topbar() {
  return h('header', { class: 'topbar' },
    h('div', { class: 'logo' }, h('img', { src: '/logo.svg', alt: '' }), h('span', {}, 'Dr', h('span', { class: 'bang' }, '!'), 'nk')),
    h('button', { class: 'icon-btn', 'aria-label': 'Abrir menu', onclick: openMenu }, svgNode(MENU_ICON)));
}
function busy(btn, on) { btn.classList.toggle('busy', on); btn.disabled = on; }
function stopLive() {
  S.stopStream?.(); S.stopStream = null;
  clearInterval(S.poll); S.poll = null;
}

// ---------- menu ----------
function openMenu() {
  const close = () => back.remove();
  const item = (label, fn, extra = {}) => h('button', { class: 'item', onclick: () => { close(); fn(); }, ...extra }, label);
  const back = h('div', { class: 'drawer-back', onclick: (e) => e.target === back && close() },
    h('nav', { class: 'drawer', 'aria-label': 'Menu' },
      h('div', { class: 'logo', style: 'margin-bottom:14px' }, h('span', {}, 'Dr', h('span', { class: 'bang' }, '!'), 'nk')),
      item('Início', () => (S.ride && !isTerminal(S.ride) ? showTracking() : showHome())),
      item('Histórico de corridas', showHistory),
      item('Pagamentos', showPayments),
      item('Perfil', showProfile),
      item('⚙ Configurações', showSettings),
      item('Suporte e segurança', showSupport),
      h('a', { class: 'item', href: '/motorista.html', style: 'display:flex;align-items:center;min-height:54px;padding:0 14px;font-size:17px;font-weight:600;color:var(--white);text-decoration:none' }, 'Sou motorista parceiro')));
  root.append(back);
  back.querySelector('button').focus();
}


function showSettings() {
  let theme = getTheme();
  const status = h('span', { class: 'setting-current' }, theme === 'light' ? 'Tema claro ativado' : 'Tema escuro ativado');
  const toggle = h('button', {
    class: 'theme-toggle',
    type: 'button',
    role: 'switch',
    'aria-checked': theme === 'light' ? 'true' : 'false',
    'aria-label': 'Alternar entre tema claro e escuro',
    onclick: () => {
      theme = setTheme(theme === 'light' ? 'dark' : 'light');
      toggle.setAttribute('aria-checked', theme === 'light' ? 'true' : 'false');
      toggle.setAttribute('aria-label', theme === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro');
      status.textContent = theme === 'light' ? 'Tema claro ativado' : 'Tema escuro ativado';
    },
  }, h('i', { 'aria-hidden': 'true' }));

  modal(root, 'Configurações', h('div', { class: 'settings-list' },
    h('div', { class: 'setting-row' },
      h('div', { class: 'setting-copy' },
        h('b', {}, 'Aparência'),
        h('p', { class: 'muted small' }, 'Alterne entre o tema claro e escuro. O mapa acompanha a sua escolha.'),
        status),
      toggle)));
}

function showSupport() {
  const kind = h('select', {}, [['emergencia', 'Emergência'], ['acidente', 'Acidente'], ['avaria', 'Avaria no veículo'], ['conduta', 'Conduta do motorista'], ['cobranca', 'Cobrança'], ['outro', 'Outro']].map(([v, l]) => h('option', { value: v }, l)));
  const text = h('textarea', { maxlength: '1000', placeholder: 'Conte o que aconteceu' });
  const err = h('div', { class: 'error', role: 'alert' });
  const send = h('button', { class: 'btn', onclick: async () => {
    err.textContent = '';
    if (!S.ride) { err.textContent = 'Você precisa ter uma corrida para registrar uma ocorrência. Em emergência, ligue 190 ou 192.'; return; }
    busy(send, true);
    try { await api('POST', `/api/rides/${S.ride.id}/incident`, { headers: authH(), body: { kind: kind.value, text: text.value } }); close(); toast(root, 'Ocorrência registrada. A operação vai analisar.'); }
    catch (e) { err.textContent = e.message; } finally { busy(send, false); }
  } }, 'Registrar ocorrência');
  const close = modal(root, 'Suporte e segurança', h('div', { class: 'stack' },
    h('div', { class: 'banner' }, 'Em risco imediato, ligue primeiro:'),
    h('div', { class: 'grid2' },
      h('a', { class: 'btn warn', href: 'tel:190', style: 'display:grid;place-items:center;text-decoration:none' }, 'Polícia 190'),
      h('a', { class: 'btn warn', href: 'tel:192', style: 'display:grid;place-items:center;text-decoration:none' }, 'SAMU 192')),
    h('p', { class: 'muted' }, S.ride ? `Corrida ${S.ride.code}: registre acidentes, avarias ou problemas com o serviço.` : 'Registre problemas de uma corrida abrindo-a pelo histórico.'),
    h('label', { class: 'field' }, h('span', {}, 'Tipo'), kind),
    h('label', { class: 'field' }, h('span', {}, 'Descrição'), text), err, send,
    h('button', { class: 'btn ghost', disabled: true }, 'Falar com atendente (indisponível no protótipo)')));
}

function showPayments() {
  const group = h('div', { class: 'radio-group', role: 'radiogroup', 'aria-label': 'Forma de pagamento padrão' },
    cfg.paymentMethods.map((m) => h('label', { class: 'check' },
      h('input', { type: 'radio', name: 'pay', value: m.id, ...(S.pay === m.id ? { checked: true } : {}), onchange: () => { S.pay = m.id; store.set('pay', m.id); toast(root, `Pagamento padrão: ${m.label}`); } }), m.label)));
  modal(root, 'Pagamentos', h('div', { class: 'stack' }, group,
    h('div', { class: 'banner' }, 'Nenhuma cobrança real é feita. A integração com um provedor de pagamentos ainda não existe.'),
    h('button', { class: 'btn ghost', disabled: true }, 'Salvar cartão (indisponível no protótipo)')));
}

function showProfile() {
  const name = h('input', { value: me.name, autocomplete: 'name', maxlength: '60' });
  const phone = h('input', { value: me.phone, type: 'tel', autocomplete: 'tel', inputmode: 'tel', maxlength: '20' });
  const close = modal(root, 'Perfil', h('div', { class: 'stack' },
    h('label', { class: 'field' }, h('span', {}, 'Nome'), name),
    h('label', { class: 'field' }, h('span', {}, 'Telefone (opcional)'), phone),
    h('p', { class: 'muted small' }, 'Salvos só neste aparelho. Em produção, o cadastro terá verificação de identidade.'),
    h('button', { class: 'btn', onclick: () => { me = { ...me, name: name.value.trim(), phone: phone.value.trim() }; store.set('me', me); close(); toast(root, 'Perfil salvo'); } }, 'Salvar')));
}

async function showHistory() {
  stopLive();
  const list = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Carregando…'));
  frame(topbar(), h('section', { class: 'sheet full stack' },
    h('div', { class: 'row between' }, h('h1', {}, 'Suas corridas'), h('button', { class: 'btn ghost small', onclick: () => (S.ride && !isTerminal(S.ride) ? showTracking() : showHome()) }, 'Voltar')), list));
  try {
    const { rides } = await api('GET', '/api/rides', { headers: { 'x-customer-id': me.id } });
    list.replaceChildren(...(rides.length ? rides.map((r) => h('button', { class: 'list-item', onclick: () => openReceipt(r.id, r.token) },
      h('div', { class: 'row between' }, h('b', {}, `${r.pickup} para ${r.destination}`), h('span', { class: 'pill' }, r.stateLabel)),
      h('p', { class: 'muted' }, `${dateBR(r.createdAt)} · ${r.code} · ${brl(r.total)}`))) : [h('p', { class: 'muted' }, 'Você ainda não fez nenhuma corrida. Peça seu primeiro motorista na tela inicial.')]));
  } catch (e) { list.replaceChildren(h('div', { class: 'error', role: 'alert' }, e.message)); }
}

async function openReceipt(id, token) {
  const box = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Carregando…'));
  modal(root, 'Recibo', box);
  try {
    const r = await api('GET', `/api/rides/${id}/receipt`, { headers: { 'x-ride-token': token } });
    fill(box,
      h('div', { class: 'banner' }, r.aviso),
      h('p', {}, h('b', {}, `${r.pickup} para ${r.destination}`)),
      h('p', { class: 'muted' }, `${dateBR(r.createdAt)} · ${r.code} · ${r.stateLabel}`),
      r.driver ? h('p', { class: 'muted' }, `Motorista: ${r.driver.name} (${r.driver.publicId})`) : null,
      h('p', { class: 'muted' }, `Veículo: ${r.vehicle.model} ${r.vehicle.color}, placa ${r.vehicle.plate}`),
      h('table', { class: 'lines' }, h('tbody', {}, r.lines.map((l) => h('tr', {}, h('td', {}, l.label), h('td', {}, brl(l.amount)))), h('tr', { class: 'total' }, h('td', {}, 'Total cobrado'), h('td', {}, brl(r.total))))),
      h('p', { class: 'muted small' }, `Pagamento: ${cfg.paymentMethods.find((m) => m.id === r.paymentMethod)?.label} (simulado) · Tabela de preços ${r.tariffVersion} · Comissão da plataforma ${r.commissionPct}%`),
      h('button', { class: 'btn ghost no-print', onclick: () => window.print() }, 'Imprimir ou salvar em PDF'));
  } catch (e) { box.replaceChildren(h('div', { class: 'error', role: 'alert' }, e.message)); }
}

// ---------- tela inicial ----------
function showHome() {
  S.ride = null; S.token = null; store.del('ride');
  const map = mapView(cfg);
  const err = h('div', { class: 'error', role: 'alert' });
  const quoteBox = h('div', { class: 'stack' });
  const cta = h('button', { class: 'btn', disabled: true, onclick: () => showRequest() }, 'Solicitar motorista');

  const pickupInput = h('input', {
    type: 'search', placeholder: 'Rua, número e bairro', autocomplete: 'off',
    'aria-label': 'Endereço de embarque', enterkeyhint: 'search',
  });
  const destInput = h('input', {
    type: 'search', placeholder: 'Rua, número e bairro', autocomplete: 'off',
    'aria-label': 'Endereço de destino', enterkeyhint: 'search',
  });
  const pickupResults = h('div', { class: 'address-results', role: 'listbox', 'aria-label': 'Sugestões de embarque' });
  const destResults = h('div', { class: 'address-results', role: 'listbox', 'aria-label': 'Sugestões de destino' });
  const gpsBtn = h('button', { class: 'btn ghost small location-pickup', onclick: useGps }, 'Usar minha localização no embarque');

  const cache = new Map();
  const timers = { pickup: null, dest: null };
  const controllers = { pickup: null, dest: null };
  let lastSearchAt = 0;
  let quoteRequestId = 0;

  function renderEmpty(container, message) {
    container.replaceChildren(h('p', { class: 'muted small address-message' }, message));
  }

  const RECENT_ADDRESS_LIMIT = 8;

  function getRecentAddresses() {
    const saved = store.get('recentAddresses', []);
    if (!Array.isArray(saved)) return [];
    return saved.filter((item) =>
      item && typeof item.label === 'string' &&
      Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lng)))
      .slice(0, RECENT_ADDRESS_LIMIT);
  }

  function rememberAddress(point) {
    if (!point || typeof point.label !== 'string' ||
        !Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lng))) return;
    const entry = {
      label: point.label.slice(0, 180),
      lat: Number(point.lat),
      lng: Number(point.lng),
    };
    const sameAddress = (item) =>
      (Number(item.lat).toFixed(5) === entry.lat.toFixed(5) &&
       Number(item.lng).toFixed(5) === entry.lng.toFixed(5)) ||
      item.label.trim().toLocaleLowerCase('pt-BR') === entry.label.trim().toLocaleLowerCase('pt-BR');
    store.set('recentAddresses', [
      entry,
      ...getRecentAddresses().filter((item) => !sameAddress(item)),
    ].slice(0, RECENT_ADDRESS_LIMIT));
  }

  function selectAddress(kind, point, container) {
    if (kind === 'pickup') {
      S.pickup = point;
      pickupInput.value = point.label;
    } else {
      S.dest = point;
      destInput.value = point.label;
    }
    rememberAddress(point);
    container.replaceChildren();
    refresh();
  }

  function renderRecentAddresses(kind, container) {
    const recent = getRecentAddresses();
    if (!recent.length) {
      container.replaceChildren();
      return;
    }
    const heading = h('div', { class: 'address-history-head' },
      h('span', {}, 'Endereços recentes'),
      h('button', {
        class: 'address-history-clear',
        type: 'button',
        onclick: () => {
          store.set('recentAddresses', []);
          container.replaceChildren();
        },
      }, 'Limpar histórico'));
    container.replaceChildren(heading, ...recent.map((item) =>
      h('button', {
        class: 'address-result recent',
        type: 'button',
        role: 'option',
        onclick: () => selectAddress(kind, { lat: Number(item.lat), lng: Number(item.lng), label: item.label }, container),
      },
        h('span', { class: 'address-result-icon', 'aria-hidden': 'true' }, '↻'),
        h('span', { class: 'address-result-copy' },
          h('strong', {}, item.label),
          h('small', {}, 'Usado recentemente')))));
  }

  function describeFeature(feature, typedQuery) {
    const props = feature.properties || {};
    const coords = feature.geometry && feature.geometry.coordinates;
    const lng = coords && Number(coords[0]);
    const lat = coords && Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const street = props.street || props.name || typedQuery;
    const number = props.housenumber ? String(props.housenumber) : '';
    const main = number && props.street ? props.street + ', ' + number : street;
    const district = props.district || props.suburb || props.locality || props.city_district || '';
    const city = props.city || props.county || 'Mossoró';
    const state = props.state || 'RN';
    const typedNumber = typedQuery.match(/(?:^|\s|,)(\d+[A-Za-z]?)\b/);
    const numberConfirmed = !typedNumber || (number && number.toLowerCase() === typedNumber[1].toLowerCase());
    const displayMain = numberConfirmed ? main : typedQuery;
    const parts = [displayMain, district, city, state].filter(Boolean);
    const label = parts.filter((value, index) => parts.indexOf(value) === index).join(', ');
    const subtitle = [district, city, state].filter(Boolean).join(' · ');
    return {
      point: { lat, lng, label },
      title: main || typedQuery,
      subtitle: numberConfirmed ? subtitle : subtitle + ' · número não confirmado no mapa',
    };
  }

  async function searchAddress(kind, input, container) {
    const query = input.value.trim();
    if (query.length < 4) return;
    const cacheKey = query.toLocaleLowerCase('pt-BR');
    let results = cache.get(cacheKey);

    try {
      if (!results) {
        const wait = Math.max(0, 1100 - (Date.now() - lastSearchAt));
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        if (input.value.trim() !== query) return;
        lastSearchAt = Date.now();

        controllers[kind] = new AbortController();
        const url = new URL('/api/geocode', location.origin);
        url.searchParams.set('q', query);

        const response = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: controllers[kind].signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || ('Busca de endereço falhou (HTTP ' + response.status + ').'));
        }
        results = (data.features || [])
          .map((feature) => describeFeature(feature, query))
          .filter((item) => item && haversineKm(cfg.area.center, item.point) <= cfg.area.radiusKm);
        cache.set(cacheKey, results);
      }

      if (input.value.trim() !== query) return;
      if (!results.length) {
        renderEmpty(container, 'Não encontramos esse endereço na área de Mossoró. Confira rua, número e bairro.');
        return;
      }

      container.replaceChildren(...results.map((result) =>
        h('button', {
          class: 'address-result', type: 'button', role: 'option',
          onclick: () => selectAddress(kind, result.point, container),
        },
          h('span', { class: 'address-result-icon', 'aria-hidden': 'true' }, kind === 'pickup' ? '●' : '◆'),
          h('span', { class: 'address-result-copy' },
            h('strong', {}, result.title),
            h('small', {}, result.subtitle || 'Mossoró, RN')))));
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (input.value.trim() === query) {
        renderEmpty(container, e.message || 'Não foi possível buscar o endereço. Verifique sua conexão.');
      }
    }
  }

  function scheduleSearch(kind, input, container) {
    clearTimeout(timers[kind]);
    controllers[kind]?.abort();
    quoteRequestId += 1;
    if (kind === 'pickup') S.pickup = null;
    else S.dest = null;
    S.quote = null;
    paintQuote();
    map.update({ pickup: placePoint(S.pickup), dest: placePoint(S.dest) });

    const query = input.value.trim();
    if (query.length < 4) {
      container.replaceChildren();
      return;
    }
    renderEmpty(container, 'Buscando endereço em Mossoró…');
    timers[kind] = setTimeout(() => searchAddress(kind, input, container), 850);
  }

  pickupInput.addEventListener('focus', () => {
    if (!pickupInput.value.trim()) renderRecentAddresses('pickup', pickupResults);
  });
  destInput.addEventListener('focus', () => {
    if (!destInput.value.trim()) renderRecentAddresses('dest', destResults);
  });
  pickupInput.addEventListener('input', () => {
    scheduleSearch('pickup', pickupInput, pickupResults);
    if (!pickupInput.value.trim()) renderRecentAddresses('pickup', pickupResults);
  });
  destInput.addEventListener('input', () => {
    scheduleSearch('dest', destInput, destResults);
    if (!destInput.value.trim()) renderRecentAddresses('dest', destResults);
  });
  pickupInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timers.pickup); searchAddress('pickup', pickupInput, pickupResults); }
  });
  destInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timers.dest); searchAddress('dest', destInput, destResults); }
  });

  function useGps() {
    clearTimeout(timers.pickup);
    controllers.pickup?.abort();
    quoteRequestId += 1;
    err.textContent = '';
    if (!navigator.geolocation) {
      err.textContent = 'Este aparelho não oferece localização. Digite o endereço de embarque.';
      return;
    }
    busy(gpsBtn, true);
    navigator.geolocation.getCurrentPosition((pos) => {
      busy(gpsBtn, false);
      const point = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (haversineKm(cfg.area.center, point) > cfg.area.radiusKm) {
        err.textContent = 'Sua localização está fora da área de atendimento (' + cfg.area.name + ').';
        return;
      }
      S.pickup = { ...point, label: 'Minha localização' };
      pickupInput.value = 'Minha localização';
      pickupResults.replaceChildren();
      refresh();
    }, () => {
      busy(gpsBtn, false);
      err.textContent = 'Não foi possível obter sua localização. Libere a permissão ou digite o endereço.';
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  }

  function paintQuote() {
    const q = S.quote;
    cta.disabled = !q;
    if (!q) { quoteBox.replaceChildren(); return; }
    quoteBox.replaceChildren(h('div', { class: 'row between' },
      h('div', {}, h('div', { class: 'price' }, brl(q.total), h('small', {}, 'estimativa')),
        h('p', { class: 'muted' }, km(q.distanceKm) + ' · cerca de ' + q.durationMin + ' min de viagem')),
      h('div', { style: 'text-align:right' },
        h('span', { class: 'pill lime' }, 'Chega em ~' + q.etaMin + ' min'),
        q.etaEstimated ? h('p', { class: 'muted small' }, 'tempo estimado') : null)));
  }

  async function refresh() {
    const requestId = ++quoteRequestId;
    err.textContent = '';
    map.update({ pickup: placePoint(S.pickup), dest: placePoint(S.dest) });
    if (!S.pickup || !S.dest) {
      S.quote = null;
      paintQuote();
      return;
    }
    cta.disabled = true;
    try {
      const quote = await api('POST', '/api/quote', {
        body: { pickup: S.pickup, destination: S.dest },
      });
      if (requestId !== quoteRequestId) return;
      S.quote = quote;
    } catch (e) {
      if (requestId !== quoteRequestId) return;
      S.quote = null;
      err.textContent = e.message;
    }
    paintQuote();
  }

  frame(topbar(), h('main', { class: 'screen' },
    map.el,
    h('section', { class: 'sheet stack' },
      h('div', { class: 'booking-heading' },
        h('div', { class: 'eyebrow' }, 'SUA VIAGEM'),
        h('h1', {}, 'Informe os endereços'),
        h('p', { class: 'muted' }, 'Digite a rua, o número e o bairro para localizar os pontos no mapa.')),
      h('div', { class: 'address-panel' },
        h('label', { class: 'field address-field' },
          h('span', {}, 'Embarque'),
          h('span', { class: 'address-input-wrap' },
            h('span', { class: 'address-dot pickup-dot', 'aria-hidden': 'true' }),
            pickupInput)),
        pickupResults,
        gpsBtn,
        h('div', { class: 'address-separator' }),
        h('label', { class: 'field address-field' },
          h('span', {}, 'Destino'),
          h('span', { class: 'address-input-wrap' },
            h('span', { class: 'address-dot destination-dot', 'aria-hidden': 'true' }),
            destInput)),
        destResults),
      err, quoteBox, h('div', { class: 'cta-bar' }, cta))));
  paintQuote();
}

// ---------- solicitação ----------
function showRequest() {
  const q = S.quote;
  const v = store.get('vehicle', { model: '', color: '', plate: '' });
  const model = h('input', { value: v.model, placeholder: 'Ex.: Onix', autocomplete: 'off', maxlength: '40' });
  const color = h('input', { value: v.color, placeholder: 'Ex.: Prata', autocomplete: 'off', maxlength: '20' });
  const plate = h('input', { value: v.plate, placeholder: 'ABC-1D23', autocapitalize: 'characters', autocomplete: 'off', maxlength: '8' });
  const name = h('input', { value: me.name, autocomplete: 'name', maxlength: '60' });
  const auth = h('input', { type: 'checkbox' });
  const shareOn = h('input', { type: 'checkbox' });
  const shareName = h('input', { placeholder: 'Nome do contato de confiança', maxlength: '60' });
  const shareBox = h('div', { class: 'stack', hidden: true }, h('label', { class: 'field' }, h('span', {}, 'Contato'), shareName), h('p', { class: 'muted small' }, 'Você recebe um link de acompanhamento para enviar a essa pessoa. Ele mostra posição e status, sem dados de pagamento.'));
  shareOn.addEventListener('change', () => { shareBox.hidden = !shareOn.checked; });
  const demo = h('input', { type: 'checkbox', checked: true });
  const err = h('div', { class: 'error', role: 'alert' });
  const pay = h('div', { class: 'radio-group', role: 'radiogroup', 'aria-label': 'Forma de pagamento' }, cfg.paymentMethods.map((m) =>
    h('label', { class: 'check' }, h('input', { type: 'radio', name: 'pay', value: m.id, ...(S.pay === m.id ? { checked: true } : {}), onchange: () => { S.pay = m.id; store.set('pay', m.id); } }), m.label)));
  const go = h('button', { class: 'btn', onclick: submit }, `Confirmar e procurar motorista · ${brl(q.total)}`);

  async function submit() {
    err.textContent = '';
    me = { ...me, name: name.value.trim() }; store.set('me', me);
    const vehicle = { model: model.value.trim(), color: color.value.trim(), plate: plate.value.trim().toUpperCase() };
    store.set('vehicle', vehicle);
    busy(go, true);
    try {
      const created = await api('POST', '/api/rides', { body: {
        customer: { id: me.id, name: me.name, phone: me.phone }, pickup: S.pickup, destination: S.dest, vehicle,
        authorization: auth.checked, paymentMethod: S.pay, demoAuto: demo.checked,
        share: shareOn.checked ? { consent: true, name: shareName.value.trim() } : undefined } });
      S.ride = created.ride; S.token = created.token; store.set('ride', { id: created.ride.id, token: created.token });
      S.ride = await api('POST', `/api/rides/${S.ride.id}/confirm`, { headers: authH() });
      showTracking();
    } catch (e) {
      if (S.ride && S.token) { showTracking(); return; } // criada, mas não confirmada: o servidor mostra o estado real
      err.textContent = e.message;
    } finally { busy(go, false); }
  }

  frame(topbar(), h('section', { class: 'sheet full stack', style: 'overflow-y:auto' },
    h('div', { class: 'row between' }, h('h1', {}, 'Confirmar pedido'), h('button', { class: 'btn ghost small', onclick: showHome }, 'Voltar')),
    h('p', { class: 'muted' }, `${placeName(S.pickup)} para ${placeName(S.dest)}`),
    h('h2', {}, 'Seu carro'),
    h('div', { class: 'grid2' }, h('label', { class: 'field' }, h('span', {}, 'Modelo'), model), h('label', { class: 'field' }, h('span', {}, 'Cor'), color)),
    h('label', { class: 'field' }, h('span', {}, 'Placa'), plate),
    h('label', { class: 'field' }, h('span', {}, 'Seu nome'), name),
    h('label', { class: 'check' }, auth, h('span', {}, 'Confirmo que sou o proprietário ou tenho autorização para usar este veículo.')),
    h('h2', {}, 'Pagamento'), pay,
    h('h2', {}, 'Preço'),
    h('table', { class: 'lines' }, h('tbody', {}, q.lines.map((l) => h('tr', {}, h('td', {}, l.label), h('td', {}, brl(l.amount)))), h('tr', { class: 'total' }, h('td', {}, 'Total estimado'), h('td', {}, brl(q.total))))),
    h('p', { class: 'muted small' }, 'Valores de demonstração. O preço é fixado na confirmação, sem variação durante a corrida.'),
    h('details', {}, h('summary', {}, 'Regras de cancelamento'), h('ul', { class: 'muted' }, q.cancellationPolicy.map((p) => h('li', {}, p)))),
    h('label', { class: 'check' }, shareOn, h('span', {}, 'Compartilhar a viagem com uma pessoa de confiança')), shareBox,
    h('label', { class: 'check' }, demo, h('span', {}, 'Modo demonstração: um motorista simulado atende o pedido. Desmarque para atender pela tela do motorista (/motorista.html).')),
    err, h('div', { class: 'cta-bar' }, go)));
}

// ---------- acompanhamento ----------
const isTerminal = (r) => r && ['servico_concluido', 'cancelado'].includes(r.state);
const FLOW = ['procurando_motorista', 'motorista_encontrado', 'motorista_a_caminho', 'motorista_chegou', 'verificacao_pre_servico', 'servico_iniciado', 'em_andamento', 'servico_concluido'];
const HEADLINE = {
  aguardando_confirmacao: 'Aguardando confirmação',
  procurando_motorista: 'Procurando um motorista para você',
  motorista_encontrado: 'Motorista encontrado',
  motorista_a_caminho: 'Seu motorista está a caminho',
  motorista_chegou: 'Seu motorista chegou',
  verificacao_pre_servico: 'Verificação de segurança',
  servico_iniciado: 'Serviço iniciado',
  em_andamento: 'A caminho do destino',
};
const HINT = {
  aguardando_confirmacao: 'Seu pedido ainda não foi confirmado. Confirme para procurar um motorista.',
  procurando_motorista: 'Estamos avisando os motoristas disponíveis perto de você.',
  motorista_encontrado: 'Ele aceitou a solicitação. Se ficar 3 minutos sem avançar com GPS ativo ou atrasar 5 minutos ou mais além da previsão, você poderá cancelar sem cobrança.',
  motorista_a_caminho: 'Ele chega de bicicleta ou scooter dobrável. Se ficar 3 minutos sem avançar com GPS ativo ou atrasar pelo menos 5 minutos em relação à previsão, você poderá cancelar sem cobrança.',
  motorista_chegou: 'Confira nome e identificação antes de entregar a chave.',
  verificacao_pre_servico: 'Ele confere você, o carro e o equipamento. Só informe o código quando a identificação bater.',
  servico_iniciado: 'Tudo certo. Coloque o cinto.',
  em_andamento: 'Acompanhe a viagem no mapa. Você pode compartilhá-la com alguém.',
};

async function showTracking() {
  const map = mapView(cfg);
  const body = h('section', { class: 'sheet stack', 'aria-live': 'polite' });
  const offline = h('div', { class: 'offline', hidden: true, role: 'status' }, 'Sem conexão. Tentando reconectar…');
  frame(topbar(), offline, h('main', { class: 'screen' }, map.el, body));
  let shown = null;

  const paint = (ride) => {
    if (!ride) return;
    S.ride = ride;
    if (isTerminal(ride)) { stopLive(); return ride.state === 'servico_concluido' ? showFinished() : showCancelled(); }
    const key = JSON.stringify([ride.state, ride.etaMin, ride.pin, ride.driver?.id, ride.verificationOk, ride.cancelPolicy?.reason]);
    map.update({
      pickup: ride.pickup, dest: ride.destination, driver: ride.driverPosition,
      driverProgress: ride.driverProgress, driverPickupProgress: ride.driverPickupProgress,
      driverRouteStart: ride.driverRouteStart,
    });
    if (key === shown) return; shown = key;
    const idx = FLOW.indexOf(ride.state);
    const d = ride.driver;
    fill(body,
      h('h1', {}, HEADLINE[ride.state] || ride.stateLabel),
      h('p', { class: 'muted' }, HINT[ride.state]),
      ride.etaMin ? h('span', { class: 'pill lime', style: 'align-self:flex-start;width:fit-content' }, ride.state === 'em_andamento' ? `Chegada em ~${ride.etaMin} min` : `Chega em ~${ride.etaMin} min`) : null,
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.max(0, Math.round(((idx + 1) / FLOW.length) * 100))) }, h('i', { style: `width:${Math.max(4, ((idx + 1) / FLOW.length) * 100)}%` })),
      ride.cancelPolicy?.reason ? h('div', { class: 'banner' }, ride.cancelPolicy.reason === 'motorista_sem_progresso' ? 'Você pode cancelar sem custo: o GPS não registrou avanço do motorista por 3 minutos.' : 'Você pode cancelar sem custo: a previsão original de chegada foi ultrapassada em pelo menos 5 minutos.') : null,
      ride.driverGpsFresh === false && ['motorista_encontrado', 'motorista_a_caminho'].includes(ride.state)
        ? h('div', { class: 'banner' }, 'A localização do motorista parou de atualizar. O mapa mantém a última posição recebida até o GPS voltar.')
        : null,
      d ? h('div', { class: 'card row' },
        h('div', { class: 'avatar', 'aria-hidden': 'true' }, d.name.split(' ').map((x) => x[0]).slice(0, 2).join('')),
        h('div', { style: 'flex:1' }, h('b', {}, d.name), h('p', { class: 'muted' }, `${d.transport} · ID ${d.publicId}`),
          h('p', { class: 'muted' }, `Nota ${d.rating.toFixed(1).replace('.', ',')}${d.ratingsCount ? ` (${d.ratingsCount})` : ''} · ${ride.simulatedDriver ? 'Motorista simulado' : 'Verificação de demonstração'}`))) : null,
      ride.pin ? h('div', { class: 'keycode', role: 'group', 'aria-label': `Código de segurança ${ride.pin.split('').join(' ')}` },
        svgNode(KEY_ICON), h('div', { class: 'digits' }, ride.pin.split('').map((c) => h('b', {}, c))),
        h('p', {}, 'Seu código de segurança. Só diga ao motorista quando ele chegar e se identificar.')) : null,
      h('div', { class: 'card' }, h('p', {}, h('b', {}, 'Seu carro: '), `${ride.vehicle.model} ${ride.vehicle.color}, ${ride.vehicle.plate}`),
        h('p', { class: 'muted' }, `${ride.pickup.label} para ${ride.destination.label} · ${brl(ride.quote.total)} (demonstração)`)),
      ride.shareUrl ? h('button', { class: 'btn ghost', onclick: () => shareTrip(ride) }, 'Copiar link para quem acompanha') : null,
      h('details', {}, h('summary', {}, 'Ver todas as etapas'), h('ol', { class: 'steps' }, FLOW.map((s, i) => h('li', { class: i < idx ? 'done' : i === idx ? 'now' : '' }, cfg.states[s])))),
      ride.state === 'aguardando_confirmacao' ? h('button', { class: 'btn', onclick: async (e) => { busy(e.currentTarget, true); try { paint(await api('POST', `/api/rides/${ride.id}/confirm`, { headers: authH() })); } catch (er) { toast(root, er.message); busy(e.currentTarget, false); } } }, 'Confirmar e procurar motorista') : null,
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', style: 'flex:1', onclick: showSupport }, 'Suporte e emergência'),
        ride.canCancel ? h('button', { class: 'btn warn', style: 'flex:1', onclick: () => cancel(ride) }, 'Cancelar') : null));
  };

  async function cancel(ride) {
    const policy = ride.cancelPolicy || { fee: ride.currentCancelFee || 0 };
    const fee = policy.fee ?? ride.currentCancelFee ?? 0;
    const freeByProgress = policy.reason === 'motorista_sem_progresso';
    const freeByDelay = policy.reason === 'motorista_atrasado';
    const free = fee <= 0;
    const explanation = freeByProgress
      ? 'O GPS não registrou avanço do motorista em direção ao embarque por 3 minutos, com sinal recente.'
      : freeByDelay
        ? 'A previsão original de chegada foi ultrapassada em pelo menos 5 minutos.'
        : fee > 0
          ? 'O motorista já iniciou o deslocamento ou chegou ao embarque. A taxa cobre parte do deslocamento realizado.'
          : 'Neste momento, a solicitação pode ser encerrada sem nenhuma cobrança.';
    let closeDialog = () => {};
    const confirmCancel = h('button', {
      class: 'btn warn',
      type: 'button',
      onclick: async (event) => {
        busy(event.currentTarget, true);
        closeDialog();
        try {
          paint(await api('POST', `/api/rides/${ride.id}/cancel`, { headers: authH() }));
        } catch (error) {
          toast(root, error.message);
        }
      },
    }, 'Confirmar cancelamento');
    const content = h('div', { class: 'stack cancel-dialog' },
      h('div', { class: `cancel-summary ${free ? 'free' : 'fee'}` },
        h('div', { class: 'cancel-icon', 'aria-hidden': 'true' }, free ? '✓' : '!'),
        h('div', { class: 'cancel-copy' },
          h('span', { class: 'cancel-kicker' }, free ? 'CANCELAMENTO GRATUITO' : 'TAXA DE CANCELAMENTO'),
          h('strong', { class: 'cancel-value' }, free ? 'R$ 0,00' : brl(fee)),
          h('p', {}, explanation))),
      h('div', { class: 'cancel-trip card' },
        h('span', { class: 'muted small' }, 'SUA SOLICITAÇÃO'),
        h('b', {}, ride.pickup.label),
        h('span', { class: 'muted small' }, 'até'),
        h('b', {}, ride.destination.label)),
      h('p', { class: 'muted small' }, free
        ? 'Nenhum valor será capturado da autorização de pagamento.'
        : 'A cobrança será limitada ao valor informado acima. O restante da autorização será liberado.'),
      confirmCancel,
      h('button', { class: 'btn ghost', type: 'button', onclick: () => closeDialog() }, 'Continuar aguardando'));
    closeDialog = modal(root, 'Cancelar solicitação', content);
  }
  const refresh = async () => {
    try { paint(await api('GET', `/api/rides/${S.ride.id}`, { headers: authH() })); offline.hidden = true; }
    catch (e) { if (e.offline) offline.hidden = false; else if (e.status === 404 || e.status === 403) { store.del('ride'); showHome(); } }
  };
  paint(S.ride);
  S.poll = setInterval(refresh, 2500);
  S.stopStream = stream(`/api/stream?ride=${S.ride.id}&token=${S.token}`, (r) => r && paint(r));
}

async function shareTrip(ride) {
  const url = location.origin + ride.shareUrl;
  try { await navigator.clipboard.writeText(url); toast(root, 'Link copiado'); }
  catch { modal(root, 'Link de acompanhamento', h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Copie e envie para sua pessoa de confiança:'), h('input', { value: url, readonly: true, 'aria-label': 'Link', style: 'width:100%;min-height:52px;background:#101010;color:#fff;border:1px solid #3a3a3a;border-radius:14px;padding:0 12px' }))); }
}

function showFinished() {
  const ride = S.ride;
  let stars = 0;
  const starBtns = [1, 2, 3, 4, 5].map((n) => h('button', { 'aria-label': `${n} ${n === 1 ? 'estrela' : 'estrelas'}`, 'aria-pressed': 'false', onclick: () => { stars = n; starBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(i < n))); } }, '★'));
  const comment = h('textarea', { placeholder: 'Quer deixar um comentário? (opcional)', maxlength: '300' });
  const err = h('div', { class: 'error', role: 'alert' });
  const send = h('button', { class: 'btn', onclick: async () => {
    if (!stars) { err.textContent = 'Escolha de 1 a 5 estrelas.'; return; }
    busy(send, true);
    try { S.ride = await api('POST', `/api/rides/${ride.id}/rate`, { headers: authH(), body: { stars, comment: comment.value } }); toast(root, 'Obrigado pela avaliação!'); showFinished(); }
    catch (e) { err.textContent = e.message; busy(send, false); }
  } }, 'Enviar avaliação');
  frame(topbar(), h('section', { class: 'sheet full stack', style: 'overflow-y:auto' },
    h('h1', {}, 'Você chegou com seu carro'),
    h('p', { class: 'muted' }, `${ride.pickup.label} para ${ride.destination.label} · ${ride.code}`),
    h('div', { class: 'card' }, h('div', { class: 'price' }, brl(ride.quote.total)), h('p', { class: 'muted' }, `Pago por ${cfg.paymentMethods.find((m) => m.id === ride.paymentMethod)?.label} (simulado)`)),
    ride.rating ? h('div', { class: 'banner' }, `Você avaliou com ${ride.rating.stars} ${ride.rating.stars === 1 ? 'estrela' : 'estrelas'}. Obrigado!`)
      : h('div', { class: 'stack' }, h('h2', {}, `Como foi com ${ride.driver?.name.split(' ')[0] || 'o motorista'}?`), h('div', { class: 'stars' }, starBtns), comment, err, send),
    h('button', { class: 'btn ghost', onclick: () => openReceipt(ride.id, S.token) }, 'Ver recibo'),
    h('button', { class: 'btn ghost', onclick: showSupport }, 'Falar com o suporte'),
    h('button', { class: 'btn', onclick: showHome }, 'Voltar ao início')));
}

function showCancelled() {
  const ride = S.ride;
  const reasons = {
    equipamento_inviavel: 'O motorista identificou que não era possível transportar o equipamento com segurança.',
    falha_verificacao_identidade: 'A verificação de identidade não foi concluída corretamente. Por segurança, a solicitação foi encerrada.',
    motorista_sem_progresso: 'O motorista ficou 3 minutos sem avanço detectável em direção ao embarque. Você não pagou taxa de cancelamento.',
    motorista_atrasado: 'A previsão original de chegada foi ultrapassada em pelo menos 5 minutos. Você não pagou taxa de cancelamento.',
    cancelado_pelo_cliente: 'A solicitação foi encerrada conforme pedido.',
  };
  const fee = Number(ride.cancel?.fee || 0);
  const free = fee <= 0;
  frame(topbar(), h('section', { class: 'sheet full stack cancel-result-page' },
    h('div', { class: `cancel-result-mark ${free ? 'free' : 'fee'}` }, free ? '✓' : '!'),
    h('h1', {}, 'Solicitação cancelada'),
    h('p', { class: 'muted' }, reasons[ride.cancel?.reason] || (ride.cancel?.by === 'cliente' ? 'Você cancelou esta solicitação.' : 'A solicitação foi encerrada.')),
    h('div', { class: `cancel-summary ${free ? 'free' : 'fee'}` },
      h('span', { class: 'cancel-kicker' }, free ? 'NENHUMA COBRANÇA' : 'TAXA DE CANCELAMENTO'),
      h('strong', { class: 'cancel-value' }, free ? 'R$ 0,00' : brl(fee)),
      h('p', { class: 'muted small' }, free ? 'A autorização do pagamento foi liberada.' : 'Este é o valor final da taxa de cancelamento.')),
    h('div', { class: 'cancel-trip card' },
      h('span', { class: 'muted small' }, 'TRAJETO SOLICITADO'),
      h('b', {}, ride.pickup.label),
      h('span', { class: 'muted small' }, 'até'),
      h('b', {}, ride.destination.label)),
    h('button', { class: 'btn ghost', onclick: () => openReceipt(ride.id, S.token) }, 'Ver comprovante'),
    h('button', { class: 'btn', onclick: showHome }, 'Voltar ao início')));
}

// ---------- inicialização ----------
async function boot() {
  try {
    cfg = await api('GET', '/api/config');
  } catch (e) {
    root.replaceChildren(h('div', { class: 'sheet full stack' }, h('h1', {}, 'Não foi possível abrir o Dr!nk'), h('div', { class: 'error', role: 'alert' }, e.message), h('button', { class: 'btn', onclick: () => location.reload() }, 'Tentar de novo')));
    return;
  }
  const saved = store.get('ride', null);
  if (saved) {
    try {
      S.token = saved.token;
      S.ride = await api('GET', `/api/rides/${saved.id}`, { headers: authH() });
      if (!isTerminal(S.ride)) return showTracking();
      store.del('ride');
    } catch { store.del('ride'); }
  }
  showHome();
}
boot();
