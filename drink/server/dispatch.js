// Motorista SIMULADO (modo demonstração). Usa exatamente as mesmas funções e validações do
// motorista real — inclusive checklist e código de segurança — apenas automatiza os cliques.
// Em produção este arquivo não existe: o despacho escolhe motoristas reais por proximidade/disponibilidade.
import * as R from './rides.js';

const BOT = 'd_bot';
const speed = () => Number(process.env.DEMO_SPEED || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * speed()));

const ALL_CHECKS = Object.fromEntries(R.CHECKLIST.map((c) => [c.key, true]));

export function scheduleBot(rideId) {
  (async () => {
    // O motorista simulado atende uma corrida por vez: se estiver ocupado, espera a vez em vez de desistir.
    let accepted = false;
    for (let i = 0; i < 90 && !accepted; i++) {
      await sleep(i === 0 ? 3000 : 2000);
      const ride = R.getRide(rideId);
      if (ride.state !== 'procurando_motorista') return; // cancelada ou aceita por um motorista humano
      try {
        R.acceptRide(rideId, BOT);
        accepted = true;
      } catch (e) {
        if (e.status !== 409) { console.error(`[bot] ${rideId}: ${e.message}`); return; }
      }
    }
    if (!accepted) return;
    const steps = [
      [2500, 'motorista_encontrado', () => R.departRide(rideId, BOT)],
      [12500, 'motorista_a_caminho', () => R.arriveRide(rideId, BOT)],
      [3000, 'motorista_chegou', () => R.beginVerification(rideId, BOT)],
      [
        4000,
        'verificacao_pre_servico',
        () => {
          const ride = R.getRide(rideId);
          return R.submitVerification(rideId, BOT, {
            checks: ALL_CHECKS,
            equipmentPlan: 'porta_malas',
            notes: 'Verificação simulada (demonstração).',
            pin: ride.pin,
          });
        },
      ],
      [2500, 'verificacao_pre_servico', () => R.startService(rideId, BOT)],
      [2500, 'servico_iniciado', () => R.driveRide(rideId, BOT)],
      [12500, 'em_andamento', () => R.finishRide(rideId, BOT)],
    ];
    for (const [wait, expected, action] of steps) {
      await sleep(wait);
      try {
        const ride = R.getRide(rideId);
        if (ride.state !== expected || (ride.driverId && ride.driverId !== BOT)) return; // cancelada ou assumida por humano
        await action();
      } catch (e) {
        console.error(`[bot] ${rideId}: ${e.message}`);
        return;
      }
    }
  })();
}
