/**
 * Génération et vérification de codes de licence Mathéquête (DEC-30 / DEC-31).
 *
 * Format interne :   MQLIC:v1:TYPE:ID:EXPIRY:SIGNATURE
 * Format affiché :   MQ-CLAS-X7K9-RP2M-8VHD-3NQF
 *
 * Cryptographie :
 *   HMAC-SHA256 tronqué à 12 caractères hex (96 bits — collision résistante)
 *   Clé HMAC_SECRET_KEY : 32 bytes hex (généré une fois via `openssl rand -hex 32`)
 *
 * Vérification offline :
 *   Le jeu Godot embarque la même clé HMAC et peut valider sans appel serveur.
 *   On recalcule simplement le HMAC du payload et on compare aux 12 hex.
 */

export type LicenceType =
  | 'CLASSE'
  | 'ECOLE'
  | 'CONTINENT'
  | 'LIFETIME'
  | 'PROMO'
  | 'ESSAI';

export interface LicenceData {
  type: LicenceType;
  id: string;          // identifiant unique (ex: c1748131200a3f9)
  expire_le: number;   // timestamp Unix (0 = jamais)
}

export interface CodeGenere {
  code_brut: string;       // MQLIC:v1:CLASSE:c12345678:1748131200:a3f9b2e1c4d5
  code_affiche: string;    // MQ-CLAS-X7K9-RP2M-8VHD-3NQF
  id: string;
}

/* ===== Constantes ===== */

const PREFIXES_AFFICHE: Record<LicenceType, string> = {
  CLASSE:    'CLAS',
  ECOLE:     'ECOL',
  CONTINENT: 'CONT',
  LIFETIME:  'LIFE',
  PROMO:     'PROM',
  ESSAI:     'ESSA'
};

// Base32 sans 0/O/1/I (Crockford-like) pour éviter confusion lecture orale
const BASE32_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* ===== Helpers HMAC (Web Crypto API — disponible dans Workers) ===== */

async function importHmacKey(secretHex: string): Promise<CryptoKey> {
  if (!/^[0-9a-fA-F]{64}$/.test(secretHex)) {
    throw new Error('HMAC_SECRET_KEY doit être 64 caractères hex (32 bytes)');
  }
  const keyBytes = new Uint8Array(
    secretHex.match(/.{2}/g)!.map(b => parseInt(b, 16))
  );
  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function hmacHex(key: CryptoKey, message: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message)
  );
  return [...new Uint8Array(sig)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/* ===== Génération ID unique (12 chars hex) ===== */

export function genererId(prefixe: string = 'c'): string {
  const ts = Math.floor(Date.now() / 1000).toString(16);
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(3)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return (prefixe + ts + rand).slice(0, 13);
}

/* ===== Encodage payload → 20 caractères Base32 ===== */

/**
 * Convertit le payload (TYPE:ID:EXPIRY) + signature en une chaîne Base32
 * affichable de 20 caractères, groupée par 4 avec tirets.
 *
 * Stratégie simple : on prend les 12 hex de la signature + premiers 8 hex
 * de l'ID, puis on convertit en Base32 sans 0/O/1/I.
 *
 * 20 caractères × 5 bits = 100 bits encodés.
 */
function hexToBase32Bytes(hex: string, longueurChars: number): string {
  // Pad/truncate à `longueurChars * 5` bits = `longueurChars * 5 / 8` bytes
  const nbBytes = Math.ceil(longueurChars * 5 / 8);
  const padded = hex.padEnd(nbBytes * 2, '0').slice(0, nbBytes * 2);
  const bytes = padded.match(/.{2}/g)!.map(b => parseInt(b, 16));

  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');

  let out = '';
  for (let i = 0; i < longueurChars; i++) {
    const chunk = bits.slice(i * 5, i * 5 + 5).padEnd(5, '0');
    out += BASE32_CHARS[parseInt(chunk, 2)];
  }
  return out;
}

function grouperParQuatre(s: string): string {
  return s.match(/.{1,4}/g)!.join('-');
}

/* ===== Génération principale ===== */

export async function genererCode(
  data: LicenceData,
  hmacSecretHex: string
): Promise<CodeGenere> {
  const key = await importHmacKey(hmacSecretHex);
  const payload = `MQLIC:v1:${data.type}:${data.id}:${data.expire_le}`;
  const sigFull = await hmacHex(key, payload);
  const sig12 = sigFull.slice(0, 12);

  const code_brut = `${payload}:${sig12}`;

  // Format affiché (DEC-30 §4.2) : MQ-CLAS-X7K9-RP2M-8VHD-3NQF
  // 16 caractères Base32 (= 80 bits) couvrant les 48 bits du HMAC tronqué.
  // Source des 80 bits : 12 hex sig + 8 premiers hex de l'id = 20 hex = 80 bits.
  const idHex8 = data.id.replace(/[^0-9a-f]/gi, '').padEnd(8, '0').slice(0, 8);
  const baseStr = hexToBase32Bytes(sig12 + idHex8, 16);

  const code_affiche =
    'MQ-' + PREFIXES_AFFICHE[data.type] + '-' + grouperParQuatre(baseStr);

  return { code_brut, code_affiche, id: data.id };
}

/* ===== Vérification (offline-compatible — même algo dans Godot) ===== */

export async function verifierCodeBrut(
  codeBrut: string,
  hmacSecretHex: string
): Promise<{ valide: boolean; raison?: string; data?: LicenceData }> {
  const parts = codeBrut.split(':');
  if (parts.length !== 6) {
    return { valide: false, raison: 'Format invalide (attendu 6 segments)' };
  }
  const [marker, version, type, id, expireStr, sig] = parts;
  if (marker !== 'MQLIC') return { valide: false, raison: 'Marker manquant' };
  if (version !== 'v1')   return { valide: false, raison: 'Version inconnue' };
  if (!(type in PREFIXES_AFFICHE)) {
    return { valide: false, raison: 'Type inconnu' };
  }
  const expire_le = parseInt(expireStr, 10);
  if (isNaN(expire_le)) return { valide: false, raison: 'Expiration invalide' };

  const key = await importHmacKey(hmacSecretHex);
  const payload = `MQLIC:v1:${type}:${id}:${expire_le}`;
  const sigCalc = (await hmacHex(key, payload)).slice(0, 12);

  if (sigCalc !== sig) return { valide: false, raison: 'Signature invalide' };

  if (expire_le !== 0 && expire_le < Math.floor(Date.now() / 1000)) {
    return { valide: false, raison: 'Code expiré' };
  }

  return {
    valide: true,
    data: { type: type as LicenceType, id, expire_le }
  };
}

/* ===== Helpers métier ===== */

export function nbElevesPourTier(tier: string): number {
  const map: Record<string, number> = {
    'classe_petite':   30,
    'classe_moyenne':  100,
    'petite_ecole':    300,
    'ecole_standard':  500,
    'grande_ecole':    1000,
    'mega_ecole':      1300
  };
  return map[tier] ?? 30;
}

export function tierVersType(tier: string): LicenceType {
  if (tier.startsWith('classe')) return 'CLASSE';
  return 'ECOLE';
}

export function expirationParDefaut(type: LicenceType): number {
  const now = Math.floor(Date.now() / 1000);
  switch (type) {
    case 'CLASSE':
    case 'ECOLE':
      return now + 365 * 24 * 3600;
    case 'ESSAI':
      return now + 30 * 24 * 3600;
    case 'LIFETIME':
    case 'PROMO':
      return 0;
    case 'CONTINENT':
      return 0;
  }
}
