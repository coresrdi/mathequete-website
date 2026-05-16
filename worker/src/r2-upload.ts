/**
 * Helpers R2 — stockage et accès aux PDFs de forfaits école.
 *
 * Sprint PB1 — D5 + D8.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DÉCISION : pas de R2 signed URL natif
 * ─────────────────────────────────────────────────────────────────────────────
 * Cloudflare R2 n'expose pas nativement de "signed URL" à courte durée comme
 * S3 sans passer par la S3-compat API (qui nécessiterait un Access Key ID +
 * Secret stockés en clair côté Worker — risque inutile).
 *
 * À la place, on génère un *jeton HMAC* {forfait_id, expire_at} signé avec
 * HMAC_SECRET_KEY, qu'on inclut dans une URL Worker :
 *
 *     https://mathequete-api.coresrdi.workers.dev/api/pdf/{forfait_id}?t={jeton}
 *
 * Avantages :
 *   - Aucune clé S3 supplémentaire à gérer (réutilise HMAC_SECRET_KEY existant).
 *   - Révocabilité : on peut blacklister un forfait côté DB si fuite.
 *   - Audit : chaque téléchargement passe par le Worker → loggable.
 *   - Le bucket R2 reste 100% privé (pas d'access public).
 *
 * TTL par défaut : 30 jours (D5). L'email d'achat embarque l'URL avec jeton.
 * Si l'admin perd l'email passé 30j, l'endpoint admin POST
 * /api/admin/forfaits/{id}/regenerer-pdf peut régénérer un nouveau lien.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Env } from './types';

/** TTL par défaut d'un lien de téléchargement PDF : 30 jours en secondes. */
export const TTL_LIEN_PDF_SECONDES = 30 * 24 * 3600;

/** Construit la clé R2 canonique pour le PDF d'un forfait école.
 *  Format : `forfaits/{annee}/{forfait_id}/codes-qr.pdf`
 *  L'année permet de partitionner pour purge éventuelle (>5 ans).
 */
export function cheminR2Pdf(forfaitId: number, dateAchatEpoch: number): string {
  const annee = new Date(dateAchatEpoch * 1000).getUTCFullYear();
  return `forfaits/${annee}/${forfaitId}/codes-qr.pdf`;
}

/** Upload d'un PDF dans R2 avec content-type fixé. */
export async function uploaderPdfR2(
  env: Env,
  cheminR2: string,
  pdfBytes: Uint8Array,
  metadonnees: { forfait_id: number; ecole_nom: string; code_court: string }
): Promise<void> {
  await env.R2_PDFS.put(cheminR2, pdfBytes, {
    httpMetadata: {
      contentType: 'application/pdf',
      contentDisposition: `attachment; filename="mathequete-${metadonnees.code_court}.pdf"`
    },
    customMetadata: {
      forfait_id: String(metadonnees.forfait_id),
      ecole_nom: metadonnees.ecole_nom,
      code_court: metadonnees.code_court,
      upload_ts: String(Math.floor(Date.now() / 1000))
    }
  });
}

/* ───────────────────────── Jetons HMAC de téléchargement ───────────────── */

interface PayloadJetonPdf {
  fid: number;            // forfait_ecole.id
  exp: number;            // unix epoch d'expiration
}

/** Encode bytes en base64url (sans padding, sans + ni /). */
function base64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode base64url vers bytes. */
function base64urlDecode(s: string): Uint8Array {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSign(secretKey: string, message: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return new Uint8Array(sigBuf);
}

/** Génère un jeton HMAC autoportant pour téléchargement PDF d'un forfait.
 *  Format : `{payloadB64}.{signatureB64}`  (style JWT-allégé).
 */
export async function genererJetonPdf(
  env: Env, forfaitId: number, ttlSecondes: number = TTL_LIEN_PDF_SECONDES
): Promise<string> {
  const payload: PayloadJetonPdf = {
    fid: forfaitId,
    exp: Math.floor(Date.now() / 1000) + ttlSecondes
  };
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = base64urlEncode(new TextEncoder().encode(payloadStr));
  const sigBytes = await hmacSign(env.HMAC_SECRET_KEY, payloadB64);
  const sigB64 = base64urlEncode(sigBytes);
  return `${payloadB64}.${sigB64}`;
}

/** Vérifie un jeton PDF et retourne le forfait_id si valide, sinon null.
 *  Vérifications :
 *   - signature HMAC SHA-256 constante en temps
 *   - non expiré
 *   - parsing JSON OK + champs présents
 */
export async function verifierJetonPdf(
  env: Env, jeton: string
): Promise<{ forfait_id: number } | null> {
  const parts = jeton.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;

  // Recalcule la signature attendue, comparaison constant-time
  const sigAttendueBytes = await hmacSign(env.HMAC_SECRET_KEY, payloadB64);
  const sigFournieBytes = base64urlDecode(sigB64);
  if (sigAttendueBytes.length !== sigFournieBytes.length) return null;
  let diff = 0;
  for (let i = 0; i < sigAttendueBytes.length; i++) {
    diff |= sigAttendueBytes[i] ^ sigFournieBytes[i];
  }
  if (diff !== 0) return null;

  // Parse le payload
  let payload: PayloadJetonPdf;
  try {
    const json = new TextDecoder().decode(base64urlDecode(payloadB64));
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof payload.fid !== 'number' || typeof payload.exp !== 'number') return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;

  return { forfait_id: payload.fid };
}

/** Construit l'URL publique complète de téléchargement à inclure dans l'email. */
export function urlTelechargementPdf(env: Env, forfaitId: number, jeton: string): string {
  // PUBLIC_SITE_URL = site Pages. On utilise plutôt l'URL Worker directe car
  // c'est le Worker qui sert le PDF (pas le site).
  // En prod, idéalement on route mathequete.ca/api/pdf/... → Worker.
  const base = `https://mathequete-api.coresrdi.workers.dev`;
  return `${base}/api/pdf/${forfaitId}?t=${encodeURIComponent(jeton)}`;
}

/** Lit un PDF depuis R2 et le retourne en Response. Renvoie null si absent. */
export async function servirPdfR2(env: Env, cheminR2: string): Promise<Response | null> {
  const obj = await env.R2_PDFS.get(cheminR2);
  if (!obj) return null;
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'private, max-age=0, no-store');
  headers.set('etag', obj.httpEtag);
  return new Response(obj.body, { headers });
}
