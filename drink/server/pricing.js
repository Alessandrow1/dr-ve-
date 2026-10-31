// Cálculo de preço transparente. TODOS os valores são SIMULADOS (demonstração).
import { roadKm } from './geo.js';

export const DEFAULT_TARIFF = {
  version: 'demo-2026-10-acessivel',
  // Modelo inicial mais acessível para validar aceitação em Mossoró.
  // Valores simulados: precisam ser validados com motoristas e custos reais antes do lançamento.
  baseFee: 7,
  perKm: 1.85,
  perMin: 0.25,
  minimum: 18,
  freePickupKm: 3, // deslocamento de bicicleta até o cliente: grátis até 3 km
  pickupFeePerKm: 0.65,
  nightSurchargePct: 10,
  nightStartHour: 22,
  nightEndHour: 5,
  commissionPct: 20,
  cancelFeeEnRoute: 8,
  cancelFeeArrived: 12,
  avgCarKmh: 28,
  avgBikeKmh: 14,
};

const r2 = (n) => Math.round(n * 100) / 100;

export function localHour(date = new Date()) {
  return (
    Number(
      new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        hour12: false,
        timeZone: 'America/Fortaleza',
      }).format(date),
    ) % 24
  );
}

function isNight(t, hour) {
  return t.nightStartHour > t.nightEndHour
    ? hour >= t.nightStartHour || hour < t.nightEndHour
    : hour >= t.nightStartHour && hour < t.nightEndHour;
}

export function cancellationPolicy(t) {
  return [
    'Cancelamento gratuito até um motorista aceitar a solicitação.',
    'Com o motorista a caminho: taxa de R$ ' + t.cancelFeeEnRoute.toFixed(2).replace('.', ',') + '.',
    'Com o motorista no local: taxa de R$ ' + t.cancelFeeArrived.toFixed(2).replace('.', ',') + '.',
    'Sem custo se o motorista não puder prestar o serviço com segurança (ex.: equipamento sem como ser levado).',
    'Após o início do serviço não há cancelamento: use o suporte/emergência.',
  ];
}

export function buildQuote({ pickup, dest, tariff = DEFAULT_TARIFF, onlineDrivers = [], now = new Date() }) {
  const distanceKm = Math.max(1, roadKm(pickup, dest));
  const durationMin = Math.max(5, Math.ceil((distanceKm / tariff.avgCarKmh) * 60));

  let pickupKm = 3;
  let etaEstimated = true;
  if (onlineDrivers.length) {
    pickupKm = Math.min(...onlineDrivers.map((d) => roadKm(d.pos, pickup)));
    etaEstimated = false;
  }
  const etaMin = Math.ceil((pickupKm / tariff.avgBikeKmh) * 60) + 3;

  const lines = [];
  lines.push({ key: 'base', label: 'Tarifa base', amount: tariff.baseFee });
  lines.push({
    key: 'distance',
    label: `Distância (${distanceKm.toFixed(1).replace('.', ',')} km × R$ ${tariff.perKm.toFixed(2).replace('.', ',')})`,
    amount: r2(distanceKm * tariff.perKm),
  });
  lines.push({
    key: 'time',
    label: `Tempo (${durationMin} min × R$ ${tariff.perMin.toFixed(2).replace('.', ',')})`,
    amount: r2(durationMin * tariff.perMin),
  });
  const pickupExtra = r2(Math.max(0, pickupKm - tariff.freePickupKm) * tariff.pickupFeePerKm);
  if (pickupExtra > 0) {
    lines.push({
      key: 'pickup',
      label: `Deslocamento do motorista (${pickupKm.toFixed(1).replace('.', ',')} km, ${tariff.freePickupKm} km grátis)`,
      amount: pickupExtra,
    });
  }
  let subtotal = r2(lines.reduce((s, l) => s + l.amount, 0));
  if (isNight(tariff, localHour(now))) {
    const extra = r2((subtotal * tariff.nightSurchargePct) / 100);
    lines.push({ key: 'night', label: `Adicional noturno (${tariff.nightSurchargePct}%)`, amount: extra });
    subtotal = r2(subtotal + extra);
  }
  let total = subtotal;
  if (subtotal < tariff.minimum) {
    lines.push({ key: 'minimum', label: 'Ajuste para tarifa mínima', amount: r2(tariff.minimum - subtotal) });
    total = tariff.minimum;
  }
  const platformFee = r2((total * tariff.commissionPct) / 100);
  return {
    currency: 'BRL',
    demo: true,
    tariffVersion: tariff.version,
    distanceKm,
    durationMin,
    pickupKm: Math.round(pickupKm * 10) / 10,
    etaMin,
    etaEstimated,
    lines,
    total: r2(total),
    commissionPct: tariff.commissionPct,
    platformFee,
    driverEarning: r2(total - platformFee),
    cancellationPolicy: cancellationPolicy(tariff),
  };
}

export function cancelFee(state, tariff = DEFAULT_TARIFF) {
  if (state === 'motorista_a_caminho') return tariff.cancelFeeEnRoute;
  if (state === 'motorista_chegou' || state === 'verificacao_pre_servico') return tariff.cancelFeeArrived;
  return 0;
}
