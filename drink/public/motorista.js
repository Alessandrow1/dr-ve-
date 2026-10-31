// Aplicativo do motorista parceiro. Login por seleção é APENAS de demonstração (autenticação real pendente).
import { $, h, api, brl, dateBR, km, store, toast, modal, pendingList, stream, mapView, haversineKm } from './common.js';

const root = $('#app');
let cfg;
let driverId = store.get('driverId', null);
let me = null;
let tab = 'painel';
let live = { stop: null, poll: null, geo: null, lastSent: 0, locationHeartbeat: null, lastPosition: null };
const H = () => ({ 'x-driver-id': driverId });

function stopLive() {
  live.stop?.(); live.stop = null;
  clearInterval(live.poll); live.poll = null;
  if (live.geo != null) navigator.geolocation?.clearWatch(live.geo);
  clearInterval(live.locationHeartbeat); live.locationHeartbeat = null;
  live.lastPosition = null;
  live.geo = null;
}
const busy = (b, on) => { b.classList.toggle('busy', on); b.disabled = on; };
const demoBar = () => h('div', { class: 'demo-bar' }, h('span', {}, 'Protótipo: login e verificações simulados'),
  h('button', { onclick: () => modal(root, 'O que falta integrar', pendingList(cfg)) }, 'Ver o que falta'));
const header = (right) => h('header', { class: 'topbar' },
  h('div', { class: 'logo' }, h('img', { src: '/logo.svg', alt: '' }), h('span', {}, 'Dr', h('span', { class: 'bang' }, '!'), 'nk'), h('span', { class: 'pill', style: 'font-size:12px;letter-spacing:0' }, 'Motorista')), right);

// ---------- entrada ----------
async function showLogin() {
  stopLive();
  const list = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Carregando…'));
  root.replaceChildren(demoBar(), header(h('a', { class: 'btn ghost small', href: '/', style: 'display:grid;place-items:center;text-decoration:none' }, 'Sou cliente')),
    h('section', { class: 'sheet full stack' }, h('h1', {}, 'Entrar como motorista'),
      h('p', { class: 'muted' }, 'Na demonstração você escolhe um perfil de motorista já cadastrado. Em produção haverá login com senha ou código e verificação de identidade.'), list,
      h('button', { class: 'btn', onclick: showApply }, 'Quero ser motorista parceiro')));
  try {
    const { drivers } = await api('GET', '/api/drivers');
    list.replaceChildren(...drivers.map((d) => h('button', { class: 'list-item', onclick: () => { driverId = d.id; store.set('driverId', d.id); boot(); } },
      h('div', { class: 'row between' }, h('b', {}, d.name), h('span', { class: d.status === 'aprovado' ? 'pill lime' : 'pill' }, { aprovado: 'Aprovado', em_analise: 'Em análise', reprovado: 'Reprovado', suspenso: 'Suspenso' }[d.status])),
      h('p', { class: 'muted' }, `${d.publicId} · ${d.transport} · nota ${d.rating.toFixed(1).replace('.', ',')}`))));
  } catch (e) { list.replaceChildren(h('div', { class: 'error', role: 'alert' }, e.message)); }
}

function showApply() {
  const f = {};
  const field = (key, label, attrs = {}) => { f[key] = h('input', { autocomplete: 'off', ...attrs }); return h('label', { class: 'field' }, h('span', {}, label), f[key]); };
  f.experience = h('textarea', { placeholder: 'Ex.: 4 anos como motorista de aplicativo e 2 de táxi.', maxlength: '500' });
  f.terms = h('input', { type: 'checkbox' }); f.safety = h('input', { type: 'checkbox' });
  const err = h('div', { class: 'error', role: 'alert' });
  const send = h('button', { class: 'btn', onclick: async () => {
    err.textContent = ''; busy(send, true);
    try {
      const d = await api('POST', '/api/driver/apply', { body: {
        name: f.name.value, phone: f.phone.value, email: f.email.value, cpf: f.cpf.value, cnhNumber: f.cnh.value, cnhCategory: f.cat.value,
        cnhValidity: f.val.value, experience: f.experience.value, pixKey: f.pix.value, acceptTerms: f.terms.checked, acceptSafety: f.safety.checked } });
      driverId = d.id; store.set('driverId', d.id); boot();
    } catch (e) { err.textContent = e.message; busy(send, false); }
  } }, 'Enviar cadastro para análise');
  root.replaceChildren(demoBar(), header(h('button', { class: 'btn ghost small', onclick: showLogin }, 'Voltar')),
    h('section', { class: 'sheet full stack', style: 'overflow-y:auto' }, h('h1', {}, 'Cadastro de motorista'),
      h('p', { class: 'muted' }, 'Pedimos só o necessário. Documentos são dados sensíveis: ficam com acesso restrito e nunca aparecem para clientes.'),
      field('name', 'Nome completo', { autocomplete: 'name' }), field('phone', 'Telefone', { type: 'tel', inputmode: 'tel' }),
      field('email', 'E-mail', { type: 'email', autocomplete: 'email' }), field('cpf', 'CPF', { inputmode: 'numeric', placeholder: '000.000.000-00' }),
      field('cnh', 'Número da CNH', { inputmode: 'numeric' }),
      h('div', { class: 'grid2' }, field('cat', 'Categoria da CNH', { placeholder: 'B', maxlength: '2', autocapitalize: 'characters' }), field('val', 'Validade da CNH', { type: 'date' })),
      h('label', { class: 'field' }, h('span', {}, 'Experiência profissional'), f.experience),
      field('pix', 'Chave Pix para receber os repasses'),
      h('div', { class: 'banner' }, 'Envio de foto dos documentos, consulta de antecedentes e verificação da CNH dependem de serviços externos e ainda não existem neste protótipo. Sem elas, nenhum cadastro real seria aprovado.'),
      h('label', { class: 'check' }, f.terms, h('span', {}, 'Li e aceito os termos de uso e a política de privacidade.')),
      h('label', { class: 'check' }, f.safety, h('span', {}, 'Aceito as regras de segurança: nada de álcool ou drogas, checklist e código do cliente antes de assumir o carro.')),
      err, send));
}

// ---------- shell autenticado ----------
async function boot() {
  stopLive();
  try { cfg ||= await api('GET', '/api/config'); } catch (e) { root.replaceChildren(h('div', { class: 'error', role: 'alert', style: 'margin:20px' }, e.message)); return; }
  if (!driverId) return showLogin();
  try { me = await api('GET', '/api/driver/me', { headers: H() }); } catch { driverId = null; store.del('driverId'); return showLogin(); }
  showShell();
}

function showShell() {
  stopLive();
  const sw = h('button', { class: 'switch', role: 'switch', 'aria-checked': String(me.online), 'aria-label': 'Disponível para corridas', onclick: toggleOnline }, h('i', {}), me.online ? 'Online' : 'Offline');
  const body = h('div', { class: 'screen', style: 'min-height:0' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, [['painel', 'Painel'], ['ganhos', 'Ganhos'], ['sair', 'Sair']].map(([k, l]) =>
    h('button', { role: 'tab', 'aria-selected': String(tab === k), onclick: () => { if (k === 'sair') { driverId = null; store.del('driverId'); return showLogin(); } tab = k; showShell(); } }, l)));
  root.replaceChildren(demoBar(), header(sw), tabs, body);
  if (tab === 'ganhos') return showEarnings(body);
  showPanel(body);
}

async function toggleOnline() {
  try {
    const pos = await currentPos();
    me = await api('POST', '/api/driver/online', { headers: H(), body: { online: !me.online, pos } });
    showShell();
  } catch (e) { toast(root, e.message); }
}
function currentPos() {
  return new Promise((res) => {
    if (!navigator.geolocation) return res(undefined);
    navigator.geolocation.getCurrentPosition((p) => {
      const pt = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
      res(haversineKm(cfg.area.center, pt) <= cfg.area.radiusKm ? pt : undefined);
    }, () => res(undefined), { timeout: 4000 });
  });
}
function sendDriverLocation(pt) {
  if (!pt || Date.now() - live.lastSent < 6000) return;
  live.lastSent = Date.now();
  api('POST', '/api/driver/location', { headers: H(), body: pt }).catch(() => {});
}
function startGeo() {
  if (!navigator.geolocation || live.geo != null) return;
  live.geo = navigator.geolocation.watchPosition((p) => {
    const pt = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
    if (haversineKm(cfg.area.center, pt) > cfg.area.radiusKm) return;
    live.lastPosition = pt;
    sendDriverLocation(pt);
  }, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
  // Reenvia a última posição como sinal de vida mesmo quando o ciclista está parado.
  live.locationHeartbeat = setInterval(() => {
    if (live.lastPosition) sendDriverLocation(live.lastPosition);
  }, 6000);
}

// ---------- painel ----------
async function showPanel(body) {
  const view = h('div', { class: 'scroll stack' });
  body.replaceChildren(view);
  const load = async () => {
    try {
      const { ride } = await api('GET', '/api/driver/active', { headers: H() });
      if (ride) return paintActive(view, ride);
      if (!me.online) return view.replaceChildren(h('div', { class: 'banner' }, 'Você está offline. Ative a chave Online quando quiser receber solicitações. Você decide quando trabalhar.'));
      const { requests } = await api('GET', '/api/driver/requests', { headers: H() });
      paintRequests(view, requests);
    } catch (e) { view.replaceChildren(h('div', { class: 'error', role: 'alert' }, e.message)); }
  };
  await load();
  if (me.online) startGeo();
  live.poll = setInterval(load, 3000);
  live.stop = stream(`/api/stream?driver=${driverId}`, () => load());
}

function paintRequests(view, requests) {
  if (!requests.length) {
    return view.replaceChildren(h('div', { class: 'card stack' }, h('b', {}, 'Nenhuma solicitação por enquanto'),
      h('p', { class: 'muted' }, 'Fique online. Assim que um cliente pedir, aparece aqui. Pedidos em modo demonstração são atendidos pelo motorista simulado: para vê-los aqui, desmarque essa opção na tela de confirmação do cliente.')));
  }
  view.replaceChildren(...requests.map((r) => h('article', { class: 'card stack' },
    h('div', { class: 'row between' }, h('b', {}, `${r.pickup.label} para ${r.destination.label}`), h('span', { class: 'pill lime' }, brl(r.earning))),
    h('p', { class: 'muted' }, `${km(r.distanceToClientKm)} até o cliente (~${r.etaToClientMin} min) · serviço de ${km(r.serviceKm)}, ~${r.serviceMin} min`),
    h('p', { class: 'muted' }, `${r.customerFirstName} · ${r.vehicle.model} ${r.vehicle.color} · valor líquido estimado, simulado`),
    h('div', { class: 'row' },
      h('button', { class: 'btn ghost', style: 'flex:1', onclick: async () => { await act(`/api/driver/rides/${r.id}/decline`); } }, 'Recusar'),
      h('button', { class: 'btn', style: 'flex:2', onclick: async (e) => { busy(e.currentTarget, true); await act(`/api/driver/rides/${r.id}/accept`); } }, 'Aceitar')))));
}

async function act(url, body) {
  try { const r = await api('POST', url, { headers: H(), body }); showShell(); return r; }
  catch (e) { toast(root, e.message); showShell(); }
}

const navLink = (p) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=${p.mode || 'driving'}`;

function paintActive(view, ride) {
  // O mapa é atualizado a cada consulta, sem redesenhar o checklist em preenchimento.
  const key = `${ride.id}|${ride.state}|${ride.verification?.ok}`;
  const headingToPickup = ['motorista_encontrado', 'motorista_a_caminho'].includes(ride.state);
  if (view.dataset.key === key) {
    if (view.pickupMap) {
      view.pickupMap.update({
        pickup: ride.pickup, dest: ride.destination,
        driver: ride.driverPosition, driverProgress: ride.driverProgress,
      });
    }
    return;
  }
  view.dataset.key = key;
  const steps = {
    motorista_encontrado: ['Iniciar deslocamento até o cliente', 'depart', 'Você aceitou. Saia em direção ao carro do cliente.'],
    motorista_a_caminho: ['Cheguei ao local', 'arrive', 'Siga até o cliente. Atualizamos sua posição se o GPS estiver liberado.'],
    motorista_chegou: ['Iniciar verificação de segurança', 'verification', 'Confira nome, identificação e veículo antes de pegar a chave.'],
    servico_iniciado: ['Iniciar trajeto até o destino', 'drive', 'Ajuste o banco, retrovisores e cinto. Cliente a bordo e de cinto.'],
    em_andamento: ['Finalizar atendimento', 'finish', 'Ao chegar, estacione com segurança e finalize.'],
  };
  const head = h('div', { class: 'stack' },
    h('div', { class: 'row between' }, h('h2', {}, `Atendimento ${ride.code}`), h('span', { class: 'pill lime' }, ride.stateLabel)),
    h('p', {}, h('b', {}, `${ride.pickup.label} para ${ride.destination.label}`)),
    h('p', { class: 'muted' }, `${ride.customer.firstName} · ${ride.vehicle.model} ${ride.vehicle.color}, placa ${ride.vehicle.plate} · você recebe ${brl(ride.driverEarning)} (simulado)`));
  const out = [head];
  if (headingToPickup) {
    if (!view.pickupMap) view.pickupMap = mapView(cfg);
    view.pickupMap.update({
      pickup: ride.pickup, dest: ride.destination,
      driver: ride.driverPosition, driverProgress: ride.driverProgress,
    });
    out.push(h('div', { class: 'pickup-navigation stack' },
      h('div', { class: 'banner' }, 'Siga a linha azul tracejada: ela mostra o caminho de bicicleta até o embarque. Sua posição é atualizada pelo GPS e acompanha a rota no mapa.'),
      view.pickupMap.el,
      h('a', { class: 'btn ghost', href: navLink({ ...ride.pickup, mode: 'bicycling' }), target: '_blank', rel: 'noopener', style: 'display:grid;place-items:center;text-decoration:none' }, 'Abrir navegação externa (a rota pode variar)')));
  } else if (view.pickupMap) {
    view.pickupMap.update({ pickup: null, dest: null, driver: null });
    view.pickupMap = null;
  }
  const target = ['servico_iniciado', 'em_andamento'].includes(ride.state) ? ride.destination : null;
  if (target) out.push(h('a', { class: 'btn ghost', href: navLink({ ...target, mode: 'driving' }), target: '_blank', rel: 'noopener', style: 'display:grid;place-items:center;text-decoration:none' }, 'Abrir navegação no app de mapas'));

  if (ride.state === 'verificacao_pre_servico') out.push(verificationForm(ride));
  else if (steps[ride.state]) {
    const [label, action, hint] = steps[ride.state];
    out.push(h('p', { class: 'muted' }, hint));
    if (['motorista_encontrado', 'motorista_a_caminho'].includes(ride.state)) {
      out.push(h('div', { class: 'banner' }, 'A contagem começa no aceite. Mantenha o GPS ativo e siga até o embarque. Sem avanço detectável por 3 minutos ou com atraso de 5 minutos ou mais além da previsão original, o cliente poderá cancelar sem custo. Registre acidente, emergência ou avaria pelo suporte para análise e isenção da penalidade automática.'));
      if (ride.driverGpsFresh === false) {
        out.push(h('div', { class: 'error', role: 'alert' }, 'Seu GPS não está enviando atualizações. Confira a permissão de localização e mantenha o Dr!nk aberto durante o deslocamento.'));
      }
    }
    out.push(h('button', { class: 'btn', onclick: async (e) => { busy(e.currentTarget, true); await act(`/api/driver/rides/${ride.id}/${action}`); } }, label));
    if (['motorista_encontrado', 'motorista_a_caminho'].includes(ride.state)) out.push(h('button', { class: 'btn warn', onclick: async () => { if (confirm('Liberar esta solicitação para outro motorista?')) await act(`/api/driver/rides/${ride.id}/release`); } }, 'Liberar solicitação'));
  }
  out.push(h('button', { class: 'btn ghost', onclick: () => incidentModal(ride) }, 'Registrar ocorrência ou emergência'));
  view.replaceChildren(...out);
}

function verificationForm(ride) {
  const boxes = {};
  const items = ride.checklist.map((c) => { boxes[c.key] = h('input', { type: 'checkbox', checked: false }); return h('label', { class: 'check' }, boxes[c.key], h('span', {}, c.label)); });
  const plan = h('select', { 'aria-label': 'Equipamento' }, h('option', { value: '' }, 'Escolha…'), ride.equipmentPlans.map((p) => h('option', { value: p.id }, p.label)));
  const pin = h('input', { inputmode: 'numeric', maxlength: '4', placeholder: '0000', autocomplete: 'off', 'aria-label': 'Código de segurança do cliente', style: 'font-size:28px;letter-spacing:.4em;text-align:center' });
  const notes = h('textarea', { placeholder: 'Avarias existentes e observações (opcional)', maxlength: '500' });
  const err = h('div', { class: 'error', role: 'alert' });
  const ok = ride.verification?.ok;
  const verify = h('button', { class: 'btn', onclick: async () => {
    err.textContent = ''; busy(verify, true);
    try {
      await api('POST', `/api/driver/rides/${ride.id}/verify`, { headers: H(), body: { checks: Object.fromEntries(Object.entries(boxes).map(([k, el]) => [k, el.checked])), equipmentPlan: plan.value, pin: pin.value, notes: notes.value } });
      showShell();
    } catch (e) { err.textContent = e.message + (e.data?.missing ? ' Marque todos os itens.' : ''); busy(verify, false); if (e.data?.cancelled || e.status === 409) showShell(); }
  } }, 'Confirmar verificação');
  if (ok) return h('div', { class: 'stack' }, h('div', { class: 'banner' }, 'Verificação concluída. Você já pode iniciar o serviço.'),
    h('button', { class: 'btn', onclick: async (e) => { busy(e.currentTarget, true); await act(`/api/driver/rides/${ride.id}/start`); } }, 'Iniciar serviço'));
  return h('div', { class: 'stack' }, h('h2', {}, 'Checklist pré-serviço'),
    h('p', { class: 'muted' }, 'Esta tela não comprova habilitação nem seguro: isso é verificado no seu cadastro. Aqui você confirma a situação deste atendimento.'),
    ...items, h('label', { class: 'field' }, h('span', {}, 'Seu equipamento (bicicleta ou scooter)'), plan),
    h('p', { class: 'muted small' }, 'Se o equipamento não couber com segurança, escolha "Não foi possível levar": o pedido é cancelado sem custo para o cliente.'),
    h('label', { class: 'field' }, h('span', {}, 'Código de segurança (o cliente mostra no app dele)'), pin), h('label', { class: 'field' }, h('span', {}, 'Observações'), notes), err, verify);
}

function incidentModal(ride) {
  const kind = h('select', {}, [['emergencia', 'Emergência'], ['acidente', 'Acidente'], ['avaria', 'Avaria'], ['conduta', 'Conduta do cliente'], ['outro', 'Outro']].map(([v, l]) => h('option', { value: v }, l)));
  const text = h('textarea', { maxlength: '1000', placeholder: 'O que aconteceu?' });
  const err = h('div', { class: 'error', role: 'alert' });
  const send = h('button', { class: 'btn', onclick: async () => { busy(send, true); try { await api('POST', `/api/driver/rides/${ride.id}/incident`, { headers: H(), body: { kind: kind.value, text: text.value } }); close(); toast(root, 'Ocorrência registrada'); } catch (e) { err.textContent = e.message; busy(send, false); } } }, 'Registrar');
  const close = modal(root, 'Ocorrência', h('div', { class: 'stack' }, h('div', { class: 'grid2' },
    h('a', { class: 'btn warn', href: 'tel:190', style: 'display:grid;place-items:center;text-decoration:none' }, 'Polícia 190'), h('a', { class: 'btn warn', href: 'tel:192', style: 'display:grid;place-items:center;text-decoration:none' }, 'SAMU 192')),
    h('label', { class: 'field' }, h('span', {}, 'Tipo'), kind), h('label', { class: 'field' }, h('span', {}, 'Descrição'), text), err, send));
}

// ---------- ganhos ----------
async function showEarnings(body) {
  const view = h('div', { class: 'scroll stack' }, h('p', { class: 'muted' }, 'Carregando…'));
  body.replaceChildren(view);
  try {
    const e = await api('GET', '/api/driver/earnings', { headers: H() });
    const stat = (l, x) => h('div', { class: 'stat' }, h('span', { class: 'muted small' }, l), h('b', {}, brl(x.total)), h('span', { class: 'muted small' }, `${x.rides} ${x.rides === 1 ? 'corrida' : 'corridas'}`));
    view.replaceChildren(h('div', { class: 'banner' }, 'Valores de demonstração, sem repasse real.'),
      h('div', { class: 'grid2' }, stat('Hoje', e.day), stat('Últimos 7 dias', e.week)), stat('Últimos 30 dias', e.month),
      h('h2', {}, 'Histórico de corridas'),
      ...(e.history.length ? e.history.map((r) => h('div', { class: 'card' }, h('div', { class: 'row between' }, h('b', {}, `${r.pickup} para ${r.destination}`), h('span', { class: 'pill lime' }, brl(r.earning))), h('p', { class: 'muted' }, `${dateBR(r.finishedAt)} · ${r.code} · ${km(r.km)}`)))
        : [h('p', { class: 'muted' }, 'Nenhuma corrida concluída ainda. Seus ganhos aparecem aqui depois do primeiro atendimento.')]));
  } catch (er) { view.replaceChildren(h('div', { class: 'error', role: 'alert' }, er.message)); }
}

boot();
