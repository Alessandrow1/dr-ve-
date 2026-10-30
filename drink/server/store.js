// Persistência de demonstração: objeto em memória salvo em arquivo JSON.
// Em produção: PostgreSQL (ver docs/ARQUITETURA.md). Documentos sensíveis NUNCA ficam aqui.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FILE = process.env.DRINK_DB || path.resolve('data/db.json');
const PERSIST = process.env.DRINK_PERSIST !== '0';

function seed() {
  const mk = (id, publicId, name, rating, ridesDone, lat, lng, extra = {}) => ({
    id,
    publicId,
    name,
    rating,
    ratingsCount: ridesDone,
    ridesDone,
    transport: 'Bicicleta elétrica dobrável',
    status: 'aprovado', // aprovado | em_analise | reprovado | suspenso
    // Verificações reais (CNH, antecedentes, seguro) dependem de provedores externos: aqui são DEMO.
    compliance: { cnh: 'demo', antecedentes: 'demo', seguro: 'demo' },
    online: false,
    pos: { lat, lng },
    posAt: 0,
    isBot: false,
    createdAt: Date.now(),
    ...extra,
  });
  return {
    rides: {},
    drivers: {
      d_rafael: mk('d_rafael', 'DRK-0231', 'Rafael Menezes (demo)', 4.9, 128, -5.19, -37.341),
      d_camila: mk('d_camila', 'DRK-0307', 'Camila Dantas (demo)', 4.8, 76, -5.205, -37.33, {
        transport: 'Scooter elétrica dobrável',
      }),
      d_bot: mk('d_bot', 'DRK-DEMO', 'Motorista simulado', 5, 0, -5.192, -37.346, {
        isBot: true,
        transport: 'Bicicleta elétrica dobrável (simulada)',
      }),
    },
    applications: {},
    transactions: [],
    incidents: [],
    audit: [],
    seq: 1,
  };
}

export let db = seed();

export function load() {
  if (!PERSIST) return;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    db = { ...seed(), ...raw, drivers: { ...seed().drivers, ...raw.drivers } };
  } catch {
    db = seed();
  }
}

let timer = null;
export function persist() {
  if (!PERSIST) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(db));
    } catch (e) {
      console.error('[store] falha ao salvar:', e.message);
    }
  }, 150);
  timer.unref?.();
}

export function resetForTests() {
  db = seed();
}

export function nextId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${db.seq++}${crypto.randomBytes(2).toString('hex')}`;
}

export function audit(actor, action, target, detail = {}) {
  db.audit.push({ at: Date.now(), actor, action, target, detail });
  persist();
}
