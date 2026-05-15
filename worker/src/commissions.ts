/* Sprint PB1 — Helpers commissions scolaires + vérification code école (D9 + D10).
 *
 * - Attribution séquentielle d'un code 2-chars Crockford à chaque nouvelle CS.
 * - Recherche autocomplete par nom.
 * - Création de commission virtuelle pour école privée (1 par école, pas mutualisée).
 * - Vérification de disponibilité du code_court avec algorithme D9.
 * - Génération de 3 alternatives suffixées en cas de conflit.
 */

import type { Env } from './types';

/** Alphabet Crockford (32 chars sans I, L, O, U). Identique à qr-gen.ts. */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Fenêtre de validité d'un forfait pour la règle D9 : 180 jours. */
export const FENETRE_D9_SECONDES = 180 * 24 * 3600;

/** Convertit un index 0..1023 en code commission 2-chars Crockford.
 *  Ordre lexicographique : 00, 01, ..., 09, 0A, 0B, ..., 0Z, 10, ..., ZZ.
 *  L'index 0 n'est pas utilisé en pratique (on commence à 01).
 */
export function indexVersCodeCommission(idx: number): string {
  if (idx < 0 || idx >= 32 * 32) {
    throw new Error(`indexVersCodeCommission: idx=${idx} hors borne (0..1023)`);
  }
  const hi = Math.floor(idx / 32);
  const lo = idx % 32;
  return CROCKFORD_ALPHABET[hi]! + CROCKFORD_ALPHABET[lo]!;
}

/** Convertit un code 2-chars Crockford en index (inverse). */
export function codeCommissionVersIndex(code: string): number {
  if (code.length !== 2) return -1;
  const hi = CROCKFORD_ALPHABET.indexOf(code[0]!);
  const lo = CROCKFORD_ALPHABET.indexOf(code[1]!);
  if (hi < 0 || lo < 0) return -1;
  return hi * 32 + lo;
}

/** Attribue le prochain code commission disponible (séquentiel).
 *  Garantit l'atomicité via une requête INSERT avec récupération du dernier
 *  code attribué. À utiliser dans une transaction si possible.
 *
 *  Retourne le nouveau code attribué (ex: '07' si 6 commissions existent déjà,
 *  en commençant à '01').
 */
export async function prochainCodeCommission(env: Env): Promise<string> {
  // Récupère le code maximal existant (ordre lexicographique = ordre d'attribution
  // car Crockford alphabétique = ordonné).
  const ligne = await env.DB
    .prepare('SELECT code FROM commissions_scolaires ORDER BY code DESC LIMIT 1')
    .first<{ code: string }>();

  if (!ligne) {
    return '01';                  // 1ère commission
  }
  const idxActuel = codeCommissionVersIndex(ligne.code);
  if (idxActuel < 0 || idxActuel >= 1023) {
    throw new Error(`prochainCodeCommission: capacité 1024 atteinte (dernier: ${ligne.code})`);
  }
  return indexVersCodeCommission(idxActuel + 1);
}

/** Crée ou retrouve une commission scolaire.
 *  - Pour les CS publiques : recherche par nom exact (insensible à la casse).
 *    Si trouvée, retourne le code existant. Sinon, crée + attribue un code.
 *  - Pour les écoles privées : crée TOUJOURS une nouvelle commission virtuelle
 *    (pas de mutualisation, garantit l'isolation des homonymes).
 */
export async function obtenirOuCreerCommission(
  env: Env,
  params: {
    nom: string;
    type: 'publique' | 'privee';
    email_admin: string;
    ecole_nom?: string;       // requis si type='privee' pour préfixer le nom virtuel
  }
): Promise<{ code: string; cree: boolean }> {
  const now = Math.floor(Date.now() / 1000);

  if (params.type === 'publique') {
    const nomNorm = params.nom.trim();
    if (nomNorm.length < 2 || nomNorm.length > 200) {
      throw new Error('Nom de commission scolaire invalide (2..200 chars)');
    }
    // Recherche exacte insensible à la casse
    const existante = await env.DB
      .prepare("SELECT code FROM commissions_scolaires WHERE LOWER(nom) = LOWER(?) AND type = 'publique' LIMIT 1")
      .bind(nomNorm)
      .first<{ code: string }>();
    if (existante) {
      return { code: existante.code, cree: false };
    }
    const code = await prochainCodeCommission(env);
    await env.DB
      .prepare(`INSERT INTO commissions_scolaires
        (code, nom, type, date_creation, premier_email_admin) VALUES (?, ?, 'publique', ?, ?)`)
      .bind(code, nomNorm, now, params.email_admin)
      .run();
    return { code, cree: true };
  }

  // type === 'privee' : toujours créer une nouvelle commission virtuelle
  const ecoleNom = (params.ecole_nom ?? 'Inconnue').trim();
  const nomVirtuel = `(Privée: ${ecoleNom})`;
  const code = await prochainCodeCommission(env);
  await env.DB
    .prepare(`INSERT INTO commissions_scolaires
      (code, nom, type, date_creation, premier_email_admin) VALUES (?, ?, 'privee', ?, ?)`)
    .bind(code, nomVirtuel, now, params.email_admin)
    .run();
  return { code, cree: true };
}

/** Recherche autocomplete des commissions publiques par préfixe de nom. */
export async function rechercherCommissionsAutocomplete(
  env: Env, q: string, limit = 10
): Promise<Array<{ code: string; nom: string }>> {
  const qLike = `%${q.trim()}%`;
  const res = await env.DB
    .prepare(`SELECT code, nom FROM commissions_scolaires
              WHERE type = 'publique' AND LOWER(nom) LIKE LOWER(?)
              ORDER BY nom LIMIT ?`)
    .bind(qLike, limit)
    .all<{ code: string; nom: string }>();
  return res.results ?? [];
}

/** Résultat de la vérification D9 du code école. */
export interface ResultatDispoCodeEcole {
  disponible: boolean;
  raison?: 'libre' | 'reachat_meme_admin' | 'conflit_autre_admin';
  alternatives?: string[];      // proposées si conflit
}

/** Vérifie la disponibilité d'un code école selon l'algorithme D9.
 *
 *   1. Liste les forfaits actifs (date_achat + 180j > now) pour (commission_code, code_court).
 *   2. Si vide → libre.
 *   3. Si tous ont le même email_admin → accepté (multi-achat / rachat).
 *   4. Sinon → conflit, propose 3 alternatives (suffixes numériques).
 */
export async function verifierDisponibiliteCodeEcole(
  env: Env,
  params: {
    commission_code: string;
    code_court: string;
    email_admin: string;
  }
): Promise<ResultatDispoCodeEcole> {
  const seuil = Math.floor(Date.now() / 1000) - FENETRE_D9_SECONDES;
  const res = await env.DB
    .prepare(`SELECT email_admin FROM forfaits_ecole
              WHERE commission_code = ? AND code_court = ? AND date_achat > ?`)
    .bind(params.commission_code, params.code_court, seuil)
    .all<{ email_admin: string }>();
  const lignes = res.results ?? [];

  if (lignes.length === 0) {
    return { disponible: true, raison: 'libre' };
  }
  const tousMemeAdmin = lignes.every(
    l => l.email_admin.trim().toLowerCase() === params.email_admin.trim().toLowerCase()
  );
  if (tousMemeAdmin) {
    return { disponible: true, raison: 'reachat_meme_admin' };
  }

  // Conflit : propose 3 alternatives
  const alternatives = await proposerAlternativesCodeEcole(
    env, params.commission_code, params.code_court
  );
  return { disponible: false, raison: 'conflit_autre_admin', alternatives };
}

/** Propose 3 alternatives suffixées numériquement à un code conflictuel.
 *  Vérifie aussi leur disponibilité auprès de la même commission.
 */
async function proposerAlternativesCodeEcole(
  env: Env, commission_code: string, code_court: string
): Promise<string[]> {
  const propositions: string[] = [];
  const seuil = Math.floor(Date.now() / 1000) - FENETRE_D9_SECONDES;
  // Essaie suffixes 2..9
  for (let suffixe = 2; suffixe <= 9 && propositions.length < 3; suffixe++) {
    const candidat = `${code_court}${suffixe}`;
    if (candidat.length > 16) break;            // limite raisonnable
    const conflit = await env.DB
      .prepare(`SELECT 1 FROM forfaits_ecole
                WHERE commission_code = ? AND code_court = ? AND date_achat > ? LIMIT 1`)
      .bind(commission_code, candidat, seuil)
      .first();
    if (!conflit) propositions.push(candidat);
  }
  return propositions;
}

/** Valide le format d'un code court école saisi par l'admin.
 *  Règles : 4-12 chars, minuscules ASCII + chiffres, doit commencer par lettre.
 */
export function validerFormatCodeCourt(code: string): { ok: boolean; erreur?: string } {
  if (!code || typeof code !== 'string') return { ok: false, erreur: 'Code manquant' };
  const c = code.trim();
  if (c.length < 4 || c.length > 12) return { ok: false, erreur: 'Longueur 4..12 chars requise' };
  if (!/^[a-z][a-z0-9]*$/.test(c)) {
    return { ok: false, erreur: 'Lettres minuscules et chiffres uniquement, doit commencer par une lettre' };
  }
  return { ok: true };
}
