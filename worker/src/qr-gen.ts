/* Sprint PB1 — Génération de clés QR Crockford Base32 (décision D1).
 *
 * Format : 12 chars Crockford Base32 (sans I, L, O, U) → 60 bits d'entropie.
 * Affichage humain : groupes de 4 séparés par tirets (« 7K9P-2QM3-RNT8 »).
 * Stockage DB : 12 chars sans tirets, en MAJUSCULES.
 *
 * Crockford Base32 est plus lisible humainement que Base32 standard :
 *   - exclut I (confondu avec 1), L (avec 1), O (avec 0), U (avec V)
 *   - tolère les fautes de frappe à la saisie (normalisation)
 *
 * Référence : https://www.crockford.com/base32.html
 */

import type { Env } from './types';

/** Alphabet Crockford Base32 : 32 caractères sans I, L, O, U. */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Tirage uniforme d'un index [0, max) via rejet (évite biais modulo). */
function tirageUniforme(max: number): number {
  // crypto.getRandomValues retourne des octets [0, 255]. Pour éviter le biais,
  // on rejette les valeurs >= floor(256/max)*max.
  const limit = Math.floor(256 / max) * max;
  const buf = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % max;
  }
}

/** Génère une clé QR Crockford Base32 de 12 caractères en MAJUSCULES.
 *  Sans tirets. À stocker tel quel dans `licences_qr.cle_qr`.
 */
export function genererCleQrBrute(): string {
  let out = '';
  for (let i = 0; i < 12; i++) {
    out += CROCKFORD_ALPHABET[tirageUniforme(32)];
  }
  return out;
}

/** Formate une clé brute (12 chars sans tirets) en affichage humain
 *  « XXXX-XXXX-XXXX ». Utilisé pour le PDF et l'email. */
export function formaterCleQrAffichage(cle: string): string {
  if (cle.length !== 12) return cle;
  return `${cle.slice(0, 4)}-${cle.slice(4, 8)}-${cle.slice(8, 12)}`;
}

/** Normalise une saisie utilisateur en clé QR canonique :
 *   - tout en majuscules
 *   - supprime tirets, espaces, ponctuation
 *   - remplace les confusions Crockford : I→1, L→1, O→0, U→V
 *  Retourne `null` si le résultat ne fait pas exactement 12 chars valides.
 */
export function normaliserSaisieQr(saisie: string): string | null {
  if (!saisie) return null;
  let s = saisie.toUpperCase().replace(/[^0-9A-Z]/g, '');
  // Confusions Crockford (lecture humaine tolérante)
  s = s.replace(/I/g, '1').replace(/L/g, '1').replace(/O/g, '0').replace(/U/g, 'V');
  if (s.length !== 12) return null;
  for (const c of s) {
    if (!CROCKFORD_ALPHABET.includes(c)) return null;
  }
  return s;
}

/** Génère une clé QR garantie unique en base D1.
 *  Boucle de protection : jusqu'à 8 tentatives. Avec 60 bits d'entropie et
 *  1300 clés par mégaécole, la probabilité de collision est ≈ 1.5×10⁻¹⁵
 *  → en pratique, la 1ère tentative passe toujours. */
export async function genererCleQrUnique(env: Env): Promise<string> {
  for (let tentative = 0; tentative < 8; tentative++) {
    const cle = genererCleQrBrute();
    const existe = await env.DB
      .prepare('SELECT 1 FROM licences_qr WHERE cle_qr = ? LIMIT 1')
      .bind(cle)
      .first();
    if (!existe) return cle;
  }
  throw new Error('genererCleQrUnique: 8 collisions consécutives (anomalie statistique)');
}

/** Génère un lot de N clés QR uniques en batch.
 *  Optimisé pour la génération de gros forfaits (1300 QR pour Méga École) :
 *  - génère N candidates en mémoire
 *  - vérifie l'unicité intra-lot (Set)
 *  - vérifie l'unicité globale via 1 seule requête D1 IN(...)
 *  - en cas de collision, régénère uniquement les conflits
 */
export async function genererLotClesQrUniques(env: Env, n: number): Promise<string[]> {
  if (n < 1 || n > 2000) {
    throw new Error(`genererLotClesQrUniques: n=${n} hors borne (1..2000)`);
  }
  const max_tentatives = 8;
  let candidates = new Set<string>();
  while (candidates.size < n) {
    candidates.add(genererCleQrBrute());
  }

  for (let tentative = 0; tentative < max_tentatives; tentative++) {
    const liste = [...candidates];
    // D1 supporte ~100 paramètres par batch raisonnable ; on chunke par 500.
    const conflits = new Set<string>();
    const chunkSize = 500;
    for (let i = 0; i < liste.length; i += chunkSize) {
      const chunk = liste.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const res = await env.DB
        .prepare(`SELECT cle_qr FROM licences_qr WHERE cle_qr IN (${placeholders})`)
        .bind(...chunk)
        .all<{ cle_qr: string }>();
      for (const row of res.results ?? []) conflits.add(row.cle_qr);
    }
    if (conflits.size === 0) return liste;
    // Régénère les conflits
    for (const c of conflits) candidates.delete(c);
    while (candidates.size < n) candidates.add(genererCleQrBrute());
  }
  throw new Error(`genererLotClesQrUniques: collisions persistantes après ${max_tentatives} tentatives`);
}
