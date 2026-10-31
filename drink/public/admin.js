// Painel administrativo da operação. Autenticação por chave (demo); RBAC e MFA pendentes.
import { $, h, api, brl, dateBR, km, fill, modal } from './common.js';

const root = $('#root');
let key = '';
try { key = sessionStorage.getItem('drink.admin') || ''; } catch { /* sem armazenamento */ }
const A = (m, u, body) => api(m, '/api/admin' + u, { body, headers: { 'x-admin-key': key } });

const TABS = [['indicadores', 'Indicadores'], ['motoristas', 'Motoristas'], ['corridas', 'Corridas'], ['clientes', 'Clientes'],
  ['pagamentos', 'Pagamentos'], ['incidentes', 'Incidentes'], ['tarifas', 'Tarifas'], ['areas', 'Áreas'], ['auditoria', 'Auditoria']];
let tab = 'indicadores';
let badges = {};

const DRIVER_STATUS = { aprovado: 'Aprovado', em_analise: 'Em análise', reprovado: 'Reprovado', suspenso: 'Suspenso' };
const COMPLIANCE = { demo: 'demo', pendente_verificacao: 'pendente' };
const TX = { autorizacao: 'Autorização', autorizacao_cancelada: 'Autorização cancelada', cobranca: 'Cobrança', taxa_cancelamento: 'Taxa de cancelamento', comissao_plataforma: 'Comissão da plataforma', repasse_motorista: 'Repasse ao motorista', reembolso: 'Reembolso' };
const KIND = { emergencia: 'Emergência', acidente: 'Acidente', avaria: 'Avaria', conduta: 'Conduta', cobranca: 'Cobrança', outro: 'Outro', equipamento_inviavel: 'Equipamento inviável', pin_invalido_reiterado: 'Código inválido (3x)', motorista_sem_progresso: 'Motorista sem avanço', motorista_atrasado: 'Motorista atrasado' };
const PAY = { nao_autorizado: 'Não autorizado', autorizado: 'Autorizado', pago: 'Pago', taxa_cobrada: 'Taxa cobrada', cancelado: 'Sem cobrança', reembolsado: 'Reembolsado' };
const CANCEL = { cliente: 'Cliente', motorista: 'Motorista', sistema: 'Sistema' };
const REASON = { equipamento_inviavel: 'Equipamento inviável', falha_verificacao_identidade: 'Falha na verificação', cancelado_pelo_cliente: 'Cancelado pelo cliente', motorista_sem_progresso: 'Motorista sem avanço', motorista_atrasado: 'Motorista atrasado' };

const table = (heads, rows, empty = 'Nada por aqui ainda.') =>
  rows.length ? h('div', { class: 'tablewrap' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, heads.map((x) => h('th', { scope: 'col' }, x)))), h('tbody', {}, rows)))
    : h('div', { class: 'banner' }, empty);
const td = (c, cls) => h('td', { class: cls }, c);
const stat = (label, value, hint) => h('div', { class: 'stat' }, h('span', { class: 'muted small' }, label), h('b', {}, value), hint ? h('span', { class: 'muted small' }, hint) : null);
const sec = (s) => (s == null ? 'sem dados' : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`);
const pl = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
const busy = (b, on) => { b.classList.toggle('busy', on); b.disabled = on; };

// ---------- entrada ----------
function showLogin(msg) {
  const input = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Chave exibida no terminal ao iniciar o servidor' });
  const err = h('div', { class: 'error', role: 'alert' }, msg || '');
  const go = h('button', { class: 'btn', onclick: async () => {
    key = input.value.trim(); busy(go, true);
    try { await A('GET', '/metrics'); try { sessionStorage.setItem('drink.admin', key); } catch { /* ok */ } start(); }
    catch (e) { err.textContent = e.status === 401 ? 'Chave inválida.' : e.message; busy(go, false); }
  } }, 'Entrar');
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go.click());
  fill(root, h('main', { class: 'login' },
    h('div', { class: 'logo' }, h('img', { src: '/logo.svg', alt: '' }), h('span', {}, 'Dr', h('span', { class: 'bang' }, '!'), 'nk Operação')),
    h('p', { class: 'muted' }, 'Acesso da equipe. Neste protótipo o acesso é por uma chave única; login individual e permissões por perfil ainda não existem.'),
    h('label', { class: 'field' }, h('span', {}, 'Chave administrativa'), input), err, go));
  input.focus();
}

async function start() {
  try { const m = await A('GET', '/metrics'); badges = { motoristas: m.drivers.pending, incidentes: m.openIncidents }; }
  catch (e) { if (e.status === 401) { try { sessionStorage.removeItem('drink.admin'); } catch { /* ok */ } return showLogin(); } }
  shell();
}

function shell() {
  const main = h('main', { id: 'main' });
  const nav = h('nav', { 'aria-label': 'Seções' },
    h('div', { class: 'logo' }, h('img', { src: '/logo.svg', alt: '' }), h('span', {}, 'Dr', h('span', { class: 'bang' }, '!'), 'nk')),
    TABS.map(([k, l]) => h('button', { ...(k === tab ? { 'aria-current': 'page' } : {}), onclick: () => { tab = k; start(); } }, l, badges[k] ? h('span', { class: 'badge', 'aria-label': `${badges[k]} pendentes` }, badges[k]) : null)),
    h('div', { style: 'flex:1' }),
    h('button', { onclick: () => { key = ''; try { sessionStorage.removeItem('drink.admin'); } catch { /* ok */ } showLogin(); } }, 'Sair'));
  fill(root, h('div', { class: 'adm' }, nav, main));
  const views = { indicadores, motoristas, corridas, clientes, pagamentos, incidentes, tarifas, areas, auditoria };
  main.append(h('p', { class: 'muted' }, 'Carregando…'));
  views[tab](main).catch((e) => { if (e.status === 401) return showLogin('Sessão expirada.'); fill(main, h('div', { class: 'error', role: 'alert' }, e.message)); });
}

const head = (title, ...extra) => h('div', { class: 'toolbar', style: 'justify-content:space-between' }, h('h1', {}, title), h('div', { class: 'toolbar' }, extra));
const demoNote = () => h('div', { class: 'banner' }, 'Dados de demonstração. Valores, comissões e repasses são simulados.');

// ---------- indicadores ----------
async function indicadores(main) {
  const m = await A('GET', '/metrics');
  const max = Math.max(1, ...m.byHour);
  const reasons = Object.entries(m.cancelReasons);
  fill(main, head('Indicadores', h('button', { class: 'btn ghost small', onclick: start }, 'Atualizar')), demoNote(),
    h('div', { class: 'cards' },
      stat('Corridas', m.rides.total, pl(m.rides.active, 'em andamento', 'em andamento')),
      stat('Conversão', m.conversionPct == null ? 'sem dados' : `${m.conversionPct}%`, pl(m.rides.completed, 'concluída', 'concluídas')),
      stat('Cancelamentos', m.cancelPct == null ? 'sem dados' : `${m.cancelPct}%`, pl(m.rides.cancelled, 'corrida', 'corridas')),
      stat('Tempo para achar motorista', sec(m.avgSearchSec)), stat('Tempo de chegada ao cliente', sec(m.avgArrivalSec)),
      stat('Clientes recorrentes', m.recurringCustomers, `de ${pl(m.totalCustomers, 'cliente', 'clientes')}`),
      stat('Motoristas online', m.drivers.online, `${pl(m.drivers.total, 'cadastrado', 'cadastrados')} · ${m.drivers.pending} em análise`),
      stat('Ocorrências abertas', m.openIncidents)),
    h('h2', {}, 'Financeiro (simulado)'),
    h('div', { class: 'cards' }, stat('Cobrado', brl(m.money.gross)), stat('Reembolsos', brl(m.money.refunds)), stat('Líquido', brl(m.money.net)), stat('Comissão da plataforma', brl(m.money.platformFees))),
    h('h2', {}, 'Pedidos por hora do dia'),
    h('div', {}, h('div', { class: 'bars', role: 'img', 'aria-label': 'Pedidos por hora: ' + m.byHour.map((n, i) => `${i}h: ${n}`).join(', ') }, m.byHour.map((n) => h('i', { style: `height:${(n / max) * 100}%`, ...(n ? {} : { 'data-zero': '1' }) }))),
      h('div', { class: 'hours', 'aria-hidden': 'true' }, m.byHour.map((_, i) => h('span', {}, i % 3 === 0 ? i : '')))),
    h('h2', {}, 'Motivos de cancelamento'),
    reasons.length ? h('ul', {}, reasons.map(([r, n]) => h('li', {}, `${REASON[r] || r}: ${n}`))) : h('p', { class: 'muted' }, 'Nenhum cancelamento.'));
}

// ---------- motoristas ----------
async function motoristas(main) {
  const { drivers } = await A('GET', '/drivers');
  const set = async (d, action, label) => {
    if (!confirm(`${label} ${d.name}?`)) return;
    try { await A('POST', `/drivers/${d.id}/${action}`); start(); } catch (e) { alert(e.message); }
  };
  const rows = drivers.filter((d) => !d.isBot).map((d) => h('tr', {},
    td(h('b', {}, d.name)), td(d.publicId), td(h('span', { class: d.status === 'aprovado' ? 'pill lime' : 'pill' }, DRIVER_STATUS[d.status])),
    td(`CNH ${COMPLIANCE[d.compliance.cnh] || d.compliance.cnh} · antecedentes ${COMPLIANCE[d.compliance.antecedentes] || d.compliance.antecedentes} · seguro ${COMPLIANCE[d.compliance.seguro] || d.compliance.seguro}`),
    td(d.application ? `Cat. ${d.application.cnhCategory}, validade ${new Date(d.application.cnhValidity).toLocaleDateString('pt-BR')}, tel. ${d.application.phoneMasked}` : 'Cadastro anterior ao protótipo'),
    td(`${d.ridesDone} · ${d.rating.toFixed(1).replace('.', ',')}`, 'num'),
    td(d.pickupReliability?.issues30d
      ? `${d.pickupReliability.issues30d} alerta(s) em 30 dias${d.pickupReliability.cooldownUntil > Date.now() ? ' · pausa temporária' : ''}`
      : 'Sem alertas recentes'),
    td(d.online ? 'Online' : 'Offline'),
    td(h('div', { class: 'row-actions' },
      d.status !== 'aprovado' ? h('button', { class: 'btn small', onclick: () => set(d, 'approve', 'Aprovar') }, 'Aprovar') : null,
      d.status === 'em_analise' ? h('button', { class: 'btn warn small', onclick: () => set(d, 'reject', 'Reprovar') }, 'Reprovar') : null,
      d.status === 'aprovado' ? h('button', { class: 'btn warn small', onclick: () => set(d, 'suspend', 'Suspender') }, 'Suspender') : null))));
  fill(main, head('Motoristas'),
    h('div', { class: 'banner' }, 'Aprovar aqui não comprova habilitação nem seguro. Confira CNH, antecedentes e cobertura por fora do protótipo antes de aprovar, e registre isso no cadastro quando houver provedor para essas verificações.'),
    table(['Nome', 'ID', 'Situação', 'Verificações', 'Dados enviados', 'Corridas · nota', 'Pontualidade', 'Agora', 'Ações'], rows, 'Nenhum motorista cadastrado.'));
}

// ---------- corridas ----------
async function corridas(main) {
  const sel = h('select', { 'aria-label': 'Filtrar por estado', onchange: () => load(sel.value) }, h('option', { value: '' }, 'Todos os estados'),
    ...Object.entries({ procurando_motorista: 'Procurando motorista', motorista_encontrado: 'Motorista encontrado', motorista_a_caminho: 'Motorista a caminho', motorista_chegou: 'Motorista chegou', verificacao_pre_servico: 'Verificação pré-serviço', servico_iniciado: 'Serviço iniciado', em_andamento: 'Em andamento', servico_concluido: 'Serviço concluído', cancelado: 'Cancelado' }).map(([v, l]) => h('option', { value: v }, l)));
  const out = h('div', {});
  fill(main, head('Corridas', sel, h('button', { class: 'btn ghost small', onclick: () => load(sel.value) }, 'Atualizar')), out);
  async function load(state) {
    const { rides } = await A('GET', '/rides' + (state ? `?state=${state}` : ''));
    fill(out, table(['Código', 'Data', 'Cliente', 'Motorista', 'Trajeto', 'Estado', 'Total', 'Pagamento', ''], rides.map((r) => h('tr', {},
      td(r.code), td(dateBR(r.createdAt)), td(r.customer), td(r.driver ? `${r.driver}${r.simulated ? '' : ''}` : '—'), td(`${r.pickup} para ${r.destination}`),
      td(h('span', { class: r.active ? 'pill lime' : 'pill' }, r.stateLabel), r.cancel ? h('div', { class: 'muted small' }, `por ${CANCEL[r.cancel.by] || r.cancel.by}: ${REASON[r.cancel.reason] || r.cancel.reason}`) : null),
      td(brl(r.total), 'num'), td(PAY[r.paymentStatus] || '—'),
      td(r.paymentStatus === 'pago' ? h('button', { class: 'btn ghost small', onclick: () => refundDialog(r, () => load(state)) }, 'Reembolsar') : null))), 'Nenhuma corrida com esse filtro.'));
  }
  await load('');
}

function refundDialog(r, done) {
  const amount = h('input', { inputmode: 'decimal', placeholder: String(r.total).replace('.', ','), 'aria-label': 'Valor a reembolsar' });
  const reason = h('textarea', { maxlength: '200', placeholder: 'Ex.: avaria confirmada no carro do cliente' });
  const err = h('div', { class: 'error', role: 'alert' });
  const go = h('button', { class: 'btn', onclick: async () => {
    busy(go, true); err.textContent = '';
    try { await A('POST', `/rides/${r.id}/refund`, { amount: amount.value ? amount.value.replace(',', '.') : undefined, reason: reason.value }); close(); done(); }
    catch (e) { err.textContent = e.message; busy(go, false); }
  } }, 'Confirmar reembolso');
  const close = modal(document.body, `Reembolso ${r.code}`, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, `Total cobrado: ${brl(r.total)} (simulado). Deixe o valor em branco para reembolsar tudo.`),
    h('label', { class: 'field' }, h('span', {}, 'Valor (R$)'), amount), h('label', { class: 'field' }, h('span', {}, 'Motivo'), reason), err, go));
}

// ---------- clientes ----------
async function clientes(main) {
  const { customers } = await A('GET', '/customers');
  fill(main, head('Clientes'), h('p', { class: 'muted' }, 'Sem login real ainda: cada aparelho é um cliente. Telefone e documentos não são exibidos aqui.'),
    table(['Nome', 'Identificação', 'Corridas', 'Concluídas', 'Canceladas', 'Total pago', 'Última corrida'], customers.map((c) => h('tr', {},
      td(h('b', {}, c.name)), td(c.id + '…'), td(c.rides, 'num'), td(c.completed, 'num'), td(c.cancelled, 'num'), td(brl(c.spent), 'num'), td(dateBR(c.last)))), 'Nenhum cliente ainda.'));
}

// ---------- pagamentos ----------
async function pagamentos(main) {
  const { transactions } = await A('GET', '/transactions');
  fill(main, head('Pagamentos e comissões'), demoNote(),
    table(['Data', 'Tipo', 'Corrida', 'Valor', 'Referência', 'Observação'], transactions.map((t) => h('tr', {},
      td(dateBR(t.at)), td(TX[t.type] || t.type), td(t.rideId.slice(0, 10) + '…'), td(brl(t.amount), 'num'), td(t.ref || '—'), td(t.reason || (t.status === 'simulado' ? 'repasse simulado' : '')))), 'Nenhuma transação ainda.'));
}

// ---------- incidentes ----------
async function incidentes(main) {
  const { incidents } = await A('GET', '/incidents');
  const resolve = (i) => {
    const note = h('textarea', { maxlength: '500', placeholder: 'Como foi resolvido?' });
    const err = h('div', { class: 'error', role: 'alert' });
    const go = h('button', { class: 'btn', onclick: async () => { busy(go, true); try { await A('POST', `/incidents/${i.id}/resolve`, { note: note.value }); close(); start(); } catch (e) { err.textContent = e.message; busy(go, false); } } }, 'Marcar como resolvido');
    const close = modal(document.body, 'Resolver ocorrência', h('div', { class: 'stack' }, h('p', { class: 'muted' }, `${KIND[i.kind] || i.kind} · corrida ${i.rideCode || '—'}`), h('p', {}, i.text || 'Sem descrição.'), note, err, go));
  };
  fill(main, head('Incidentes e reclamações'),
    table(['Data', 'Tipo', 'Corrida', 'Origem', 'Descrição', 'Situação', ''], incidents.map((i) => h('tr', {},
      td(dateBR(i.at)), td(h('b', {}, KIND[i.kind] || i.kind)), td(i.rideCode || '—'), td(i.by), td(i.text || '—'),
      td(h('span', { class: i.status === 'resolvido' ? 'pill' : 'pill lime' }, i.status === 'resolvido' ? 'Resolvido' : i.status === 'em_analise' ? 'Em análise' : 'Aberto'), i.resolution ? h('div', { class: 'muted small' }, i.resolution.note) : null),
      td(i.status !== 'resolvido' ? h('div', { class: 'row-actions' },
        i.status === 'aberto' ? h('button', { class: 'btn ghost small', onclick: async () => { await A('POST', `/incidents/${i.id}/resolve`, { status: 'em_analise' }); start(); } }, 'Analisar') : null,
        h('button', { class: 'btn small', onclick: () => resolve(i) }, 'Resolver')) : null))), 'Nenhuma ocorrência registrada.'));
}

// ---------- tarifas ----------
const LABELS = { baseFee: 'Tarifa base (R$)', perKm: 'Por km (R$)', perMin: 'Por minuto (R$)', minimum: 'Tarifa mínima (R$)', freePickupKm: 'Km de deslocamento grátis', pickupFeePerKm: 'Deslocamento extra por km (R$)', nightSurchargePct: 'Adicional noturno (%)', commissionPct: 'Comissão da plataforma (%)', cancelFeeEnRoute: 'Taxa: motorista a caminho (R$)', cancelFeeArrived: 'Taxa: motorista no local (R$)' };
async function tarifas(main) {
  const t = await A('GET', '/tariff');
  const inputs = {};
  const err = h('div', { class: 'error', role: 'alert' });
  const save = h('button', { class: 'btn', onclick: async () => {
    busy(save, true); err.textContent = '';
    try { await A('PUT', '/tariff', Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.replace(',', '.')]))); start(); }
    catch (e) { err.textContent = e.message; busy(save, false); }
  } }, 'Salvar tarifas');
  fill(main, head('Tarifas'), h('div', { class: 'banner' }, `Versão atual: ${t.version}. A alteração vale só para novos pedidos; corridas já confirmadas mantêm o preço combinado. Toda alteração fica na auditoria.`),
    h('div', { class: 'formgrid' }, t.editable.map((k) => { inputs[k] = h('input', { inputmode: 'decimal', value: String(t[k]).replace('.', ',') }); return h('label', { class: 'field' }, h('span', {}, LABELS[k] || k), inputs[k]); })), err, h('div', { style: 'max-width:260px' }, save));
}

// ---------- áreas ----------
async function areas(main) {
  const a = await A('GET', '/areas');
  fill(main, head('Áreas de atendimento'), h('div', { class: 'banner' }, a.note),
    table(['Área', 'Centro', 'Raio', 'Situação'], a.areas.map((x) => h('tr', {}, td(h('b', {}, x.name)), td(`${x.center.lat.toFixed(4)}, ${x.center.lng.toFixed(4)}`), td(km(x.radiusKm)), td(h('span', { class: 'pill lime' }, x.active ? 'Ativa' : 'Inativa'))))),
    h('h2', {}, 'Bairros disponíveis no protótipo'), h('div', { class: 'chips' }, a.neighborhoods.map((n) => h('span', { class: 'pill' }, n))),
    h('button', { class: 'btn ghost', style: 'max-width:320px', disabled: true }, 'Adicionar área (indisponível no protótipo)'));
}

// ---------- auditoria ----------
async function auditoria(main) {
  const { audit } = await A('GET', '/audit');
  fill(main, head('Auditoria'), h('p', { class: 'muted' }, 'Registro das ações administrativas e eventos de segurança, do mais recente ao mais antigo.'),
    table(['Quando', 'Quem', 'Ação', 'Alvo', 'Detalhes'], audit.map((a) => h('tr', {}, td(dateBR(a.at)), td(a.actor), td(h('b', {}, a.action.replaceAll('_', ' '))), td(String(a.target).slice(0, 18)), td(Object.keys(a.detail || {}).length ? JSON.stringify(a.detail) : '—'))), 'Nenhuma ação registrada ainda.'));
}

if (key) start(); else showLogin();
