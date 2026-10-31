// Página somente leitura para o contato de confiança. Mostra status e posição; nunca dados de pagamento.
import { $, h, api, stream, mapView } from './common.js';

const root = $('#app');
const token = new URLSearchParams(location.search).get('t') || '';

async function boot() {
  let cfg;
  try { cfg = await api('GET', '/api/config'); } catch (e) { return fail(e.message); }
  const map = mapView(cfg);
  const title = h('h1', {});
  const sub = h('p', { class: 'muted' });
  const eta = h('span', { class: 'pill lime', hidden: true });
  const gpsWarning = h('p', { class: 'muted small', hidden: true }, 'A localização do motorista parou de atualizar. O mapa mostra a última posição recebida.');
  root.replaceChildren(
    h('div', { class: 'demo-bar' }, h('span', {}, 'Acompanhamento de demonstração')),
    h('header', { class: 'topbar' }, h('div', { class: 'logo' }, h('img', { src: '/logo.svg', alt: '' }), h('span', {}, 'Dr', h('span', { class: 'bang' }, '!'), 'nk'))),
    h('main', { class: 'screen' }, map.el, h('section', { class: 'sheet stack' }, title, sub, eta, gpsWarning,
      h('p', { class: 'muted small' }, 'Você recebeu este link porque alguém compartilhou a viagem com você. Em risco imediato, ligue 190 ou 192.'))));
  const paint = (r) => {
    if (!r) return;
    title.textContent = r.stateLabel;
    const itinerary = [r.pickup.label, ...(r.stops || []).map((point) => point.label), r.destination.label].join(' → ');
    const stopStatus = r.stops?.length ? ` Paradas concluídas: ${r.completedStops || 0}/${r.stops.length}.` : '';
    sub.textContent = `${r.customerFirstName} segue por ${itinerary}, no ${r.vehicle.model} ${r.vehicle.color}.${stopStatus}${r.driverFirstName ? ` Motorista: ${r.driverFirstName}.` : ''}`;
    eta.hidden = !r.etaMin; eta.textContent = `~${r.etaMin} min`;
    gpsWarning.hidden = r.driverGpsFresh !== false;
    map.update({
      pickup: r.pickup, dest: r.destination, stops: r.stops, driver: r.driverPosition, state: r.state,
      driverProgress: r.driverProgress, driverPickupProgress: r.driverPickupProgress,
      driverRouteStart: r.driverRouteStart,
    });
  };
  const load = async () => { try { paint(await api('GET', `/api/share/${token}`)); } catch (e) { if (e.status === 404) fail(e.message); } };
  await load();
  setInterval(load, 3000);
  stream(`/api/stream?share=${token}`, paint);
}
function fail(msg) { root.replaceChildren(h('section', { class: 'sheet full stack' }, h('h1', {}, 'Link indisponível'), h('div', { class: 'error', role: 'alert' }, msg))); }
boot();
