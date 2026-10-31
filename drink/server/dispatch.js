// Motorista SIMULADO (modo demonstração). Usa exatamente as mesmas funções e validações do
// motorista real — inclusive checklist e código de segurança — apenas automatiza os cliques.
// Em produção este arquivo não existe: o despacho escolhe motoristas reais por proximidade/disponibilidade.
import * as R from './rides.js';

const BOT = 'd_bot';
const speed = () => Number(process.env.DEMO_SPEED || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * speed()));

const ALL_CHECKS = Object.fromEntries(R.CHECKLIST.map((c) => [c.key, true]));

async function continueBot(rideId) {
  try {
    while (true) {
      const ride = R.getRide(rideId);
      if (ride.driverId !== BOT || !R.isActive(ride)) return;

      const expectedState = ride.state;
      let waitMs;
      let action;

      switch (ride.state) {
        case 'motorista_encontrado':
          waitMs = 2500;
          action = () => R.departRide(rideId, BOT);
          break;
        case 'motorista_a_caminho':
          waitMs = 12500;
          action = () => R.arriveRide(rideId, BOT);
          break;
        case 'motorista_chegou':
          waitMs = 3000;
          action = () => R.beginVerification(rideId, BOT);
          break;
        case 'verificacao_pre_servico':
          if (!ride.verification?.ok) {
            waitMs = 4000;
            action = () => R.submitVerification(rideId, BOT, {
              checks: ALL_CHECKS,
              equipmentPlan: 'porta_malas',
              notes: 'Verificação simulada (demonstração).',
              pin: R.getRide(rideId).pin,
            });
          } else {
            waitMs = 2500;
            action = () => R.startService(rideId, BOT);
          }
          break;
        case 'servico_iniciado':
          waitMs = 2500;
          action = () => R.driveRide(rideId, BOT);
          break;
        case 'em_andamento':
          waitMs = 12500;
          action = () => R.finishRide(rideId, BOT);
          break;
        default:
          return;
      }

      await sleep(waitMs);
      const latest = R.getRide(rideId);
      if (latest.driverId !== BOT || latest.state !== expectedState) return;
      await action();
    }
  } catch (e) {
    console.error(`[bot] ${rideId}: ${e.message}`);
  }
}

/** Retoma uma etapa interrompida quando o servidor reinicia. */
export function resumeBot(rideId) {
  void continueBot(rideId);
}

/** Retoma todos os pedidos que já estavam atribuídos ao motorista simulado. */
export function resumeActiveBots(rides) {
  for (const ride of rides || []) {
    if (ride.driverId === BOT && R.isActive(ride)) resumeBot(ride.id);
  }
}

/** Agenda o motorista automático para uma solicitação recém-confirmada. */
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
    await continueBot(rideId);
  })();
}
