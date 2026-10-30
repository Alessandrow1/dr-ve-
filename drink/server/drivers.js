// Cadastro de motoristas e ações administrativas mínimas (aprovar/reprovar/suspender) com auditoria.
// Verificações reais (CNH no órgão de trânsito, antecedentes, seguro) dependem de provedores externos — PENDENTES.
import { db, persist, nextId, audit } from './store.js';
import { HttpError } from './rides.js';
import { publish } from './events.js';

export function validCPF(cpf) {
  const s = String(cpf).replace(/\D/g, '');
  if (s.length !== 11 || /^(\d)\1+$/.test(s)) return false;
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(s[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(s[9]) && calc(10) === Number(s[10]);
}

const CNH_OK = ['B', 'C', 'D', 'E', 'AB', 'AC', 'AD', 'AE'];

export function applyDriver(body) {
  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').replace(/\D/g, '');
  const email = String(body.email || '').trim();
  if (name.length < 5) throw new HttpError(422, 'Informe seu nome completo.');
  if (phone.length < 10) throw new HttpError(422, 'Telefone inválido.');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(422, 'E-mail inválido.');
  if (!validCPF(body.cpf)) throw new HttpError(422, 'CPF inválido.');
  const cat = String(body.cnhCategory || '').toUpperCase();
  if (!CNH_OK.includes(cat)) throw new HttpError(422, 'A categoria da CNH deve ser B ou superior.');
  const validity = new Date(body.cnhValidity);
  if (Number.isNaN(validity.getTime()) || validity.getTime() < Date.now()) {
    throw new HttpError(422, 'CNH vencida ou data inválida.');
  }
  if (String(body.cnhNumber || '').replace(/\D/g, '').length < 9) throw new HttpError(422, 'Número da CNH inválido.');
  if (String(body.experience || '').trim().length < 10) throw new HttpError(422, 'Conte sua experiência profissional.');
  if (String(body.pixKey || '').trim().length < 5) throw new HttpError(422, 'Informe a chave Pix para repasses.');
  if (body.acceptTerms !== true || body.acceptSafety !== true) {
    throw new HttpError(422, 'É necessário aceitar os termos e as regras de segurança.');
  }
  const id = nextId('d');
  const publicId = 'DRK-' + String(1000 + Object.keys(db.drivers).length * 7).slice(-4);
  db.drivers[id] = {
    id, publicId, name, rating: 5, ratingsCount: 0, ridesDone: 0,
    transport: String(body.transport || 'Bicicleta elétrica dobrável').slice(0, 60),
    status: 'em_analise',
    compliance: { cnh: 'pendente_verificacao', antecedentes: 'pendente_verificacao', seguro: 'pendente_verificacao' },
    online: false, pos: { lat: -5.1875, lng: -37.344 }, posAt: 0, isBot: false, createdAt: Date.now(),
  };
  // Dados sensíveis separados e NUNCA devolvidos pela API. Em produção: cofre/criptografia + upload de documentos.
  db.applications[id] = {
    driverId: id, phone, email, cpf: String(body.cpf).replace(/\D/g, ''),
    cnhNumber: String(body.cnhNumber).replace(/\D/g, ''), cnhCategory: cat, cnhValidity: validity.toISOString(),
    experience: String(body.experience).slice(0, 500), pixKey: String(body.pixKey).slice(0, 80),
    acceptedAt: Date.now(),
  };
  audit('motorista', 'cadastro_enviado', id);
  persist();
  return db.drivers[id];
}

export function publicDriver(d) {
  return {
    id: d.id, publicId: d.publicId, name: d.name, status: d.status, online: d.online, isBot: d.isBot,
    rating: Math.round(d.rating * 10) / 10, ridesDone: d.ridesDone, transport: d.transport, compliance: d.compliance,
  };
}

export function adminListDrivers() {
  return Object.values(db.drivers).map((d) => {
    const a = db.applications[d.id];
    return {
      ...publicDriver(d),
      application: a
        ? { phoneMasked: a.phone.replace(/\d(?=\d{4})/g, '•'), cnhCategory: a.cnhCategory, cnhValidity: a.cnhValidity }
        : null,
    };
  });
}

export function adminSetStatus(id, action, actor = 'admin') {
  const d = db.drivers[id];
  if (!d) throw new HttpError(404, 'Motorista não encontrado.');
  const map = { approve: 'aprovado', reject: 'reprovado', suspend: 'suspenso' };
  if (!map[action]) throw new HttpError(422, 'Ação inválida.');
  d.status = map[action];
  if (d.status !== 'aprovado') d.online = false;
  audit(actor, `motorista_${map[action]}`, id);
  persist();
  publish('drivers', 'requests', {});
  return d;
}
