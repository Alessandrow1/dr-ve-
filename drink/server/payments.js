// Camada de pagamentos. NENHUMA integração real existe neste protótipo.
// Para conectar um provedor real: implemente a interface abaixo em server/payments/<provedor>.js,
// registre em getProvider() e guarde credenciais APENAS em variáveis de ambiente do backend.
import crypto from 'node:crypto';
import { db, persist, nextId } from './store.js';

export const METHODS = [
  { id: 'pix', label: 'Pix' },
  { id: 'cartao_credito', label: 'Cartão de crédito' },
  { id: 'cartao_debito', label: 'Cartão de débito' },
];

/**
 * Interface esperada de um provedor:
 *   authorize({rideId, amount, method}) -> {ok, ref}
 *   capture({ref, amount})              -> {ok, ref}
 *   voidAuth({ref})                     -> {ok}
 *   refund({ref, amount})               -> {ok, ref}
 *   payout({driverId, amount})          -> {ok, ref}   (repasse ao motorista)
 */
const demoProvider = {
  name: 'demo',
  authorize: ({ rideId, method }) => ({ ok: true, ref: `DEMO-AUTH-${rideId}-${method}` }),
  capture: ({ ref }) => ({ ok: true, ref: ref.replace('AUTH', 'CAPT') }),
  voidAuth: () => ({ ok: true }),
  refund: ({ ref }) => ({ ok: true, ref: ref.replace('CAPT', 'RFND') }),
  payout: ({ driverId }) => ({ ok: true, ref: `DEMO-PAYOUT-${driverId}-${crypto.randomBytes(3).toString('hex')}` }),
};

export function getProvider() {
  const name = process.env.PAYMENT_PROVIDER || 'demo';
  if (name === 'demo') return demoProvider;
  throw new Error(
    `Provedor de pagamento "${name}" não implementado. Implemente a interface em server/payments.js (veja docs/ARQUITETURA.md).`,
  );
}

export function recordTx(tx) {
  const entry = { id: nextId('tx'), at: Date.now(), demo: true, ...tx };
  db.transactions.push(entry);
  persist();
  return entry;
}

/** Código "copia e cola" do Pix — FICTÍCIO, só para a demonstração. */
export function demoPixCode(rideId, amount) {
  return `DEMO-PIX|${rideId}|${amount.toFixed(2)}|NAO-E-UM-PIX-REAL`;
}
