// Geografia de demonstração para Mossoró/RN.
// ATENÇÃO: as coordenadas dos bairros são APROXIMADAS e servem só para o protótipo.
// Em produção, endereços e rotas vêm de um provedor de geocodificação/rotas (pendente).

export const SERVICE_AREA = {
  name: 'Mossoró (RN)',
  center: { lat: -5.1875, lng: -37.344 },
  radiusKm: 22,
};

export const MAP_BOUNDS = { latMin: -5.265, latMax: -5.11, lngMin: -37.42, lngMax: -37.265 };

export const PLACES = [
  { id: 'centro', name: 'Centro', lat: -5.1875, lng: -37.344 },
  { id: 'nova-betania', name: 'Nova Betânia', lat: -5.2065, lng: -37.322 },
  { id: 'costa-e-silva', name: 'Presidente Costa e Silva', lat: -5.162, lng: -37.356 },
  { id: 'alto-sao-manoel', name: 'Alto de São Manoel', lat: -5.2, lng: -37.368 },
  { id: 'abolicao', name: 'Abolição', lat: -5.178, lng: -37.322 },
  { id: 'bom-jardim', name: 'Bom Jardim', lat: -5.215, lng: -37.352 },
  { id: 'santo-antonio', name: 'Santo Antônio', lat: -5.196, lng: -37.337 },
  { id: 'aeroporto', name: 'Aeroporto', lat: -5.2, lng: -37.31 },
  { id: 'doze-anos', name: 'Doze Anos', lat: -5.17, lng: -37.375 },
  { id: 'lagoa-do-mato', name: 'Lagoa do Mato', lat: -5.148, lng: -37.33 },
  { id: 'barrocas', name: 'Barrocas', lat: -5.223, lng: -37.372 },
  { id: 'planalto-13-maio', name: 'Planalto 13 de Maio', lat: -5.233, lng: -37.335 },
  { id: 'redencao', name: 'Redenção', lat: -5.185, lng: -37.39 },
  { id: 'santa-delmira', name: 'Santa Delmira', lat: -5.155, lng: -37.305 },
];

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** Distância viária estimada: linha reta x fator urbano. Substituir por provedor de rotas. */
export function roadKm(a, b) {
  return Math.round(haversineKm(a, b) * 1.35 * 10) / 10;
}

export function insideServiceArea(p) {
  return haversineKm(SERVICE_AREA.center, p) <= SERVICE_AREA.radiusKm;
}

export function lerp(a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  return { lat: a.lat + (b.lat - a.lat) * k, lng: a.lng + (b.lng - a.lng) * k };
}

/** Resolve {placeId} ou {lat,lng,label} para um ponto válido. */
export function resolvePoint(input) {
  if (!input || typeof input !== 'object') return null;
  if (input.placeId) {
    const p = PLACES.find((x) => x.id === input.placeId);
    return p ? { placeId: p.id, label: p.name, lat: p.lat, lng: p.lng } : null;
  }
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }
  return { placeId: null, label: String(input.label || 'Minha localização').slice(0, 80), lat, lng };
}
