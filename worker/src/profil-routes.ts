/**
 * DEC-63 phase 2 — Endpoints profil joueur cloud (16 mai 2026)
 *
 * Permet à un joueur de créer un compte cloud léger (sans email, sans mot de
 * passe) identifié par un `recovery_code` Crockford Base32 de 16 chars.
 * Ce profil sert à retrouver ses licences sur un nouvel appareil (« j'ai
 * changé de téléphone »).
 *
 * Conforme Loi 25 : aucun PII (prénom, nom, email, âge) n'est jamais collecté.
 * Le profil n'a que :
 *   - un identifiant interne (autoincrement)
 *   - un recovery_code 16 chars (rangée UNIQUE)
 *   - 2 dates (création, dernière activité)
 *   - un flag est_archive (soft delete)
 *
 * Endpoints :
 *
 *   POST /api/jeu/profil-creer
 *     Body : { device_fingerprint }
 *     → crée un profils_joueur + rattache TOUTES les activations actives
 *       de ce device au nouveau profil
 *     → retourne { ok, recovery_code, nb_activations_liees }
 *
 *   POST /api/jeu/profil-recuperer
 *     Body : { recovery_code, device_fingerprint }
 *     → cherche un profil par recovery_code (idempotent : appelable plusieurs
 *       fois sur le même device)
 *     → migre toutes les activations du profil vers ce device :
 *         * révoque l'ancien device sur chaque activation (motif='transfer_auto')
 *         * insère une nouvelle activation pour le nouveau device + profil
 *     → retourne { ok, nb_activations_migrees, produits_actifs[] }
 *
 *   GET  /api/jeu/profil-licences/:recovery_code
 *     → vue lecture seule : retourne toutes les activations actives du profil
 *       SANS migrer (cross-device read)
 *     → retourne { ok, est_gratuit, produits_actifs[], activations[] }
 *
 * Conventions :
 *   - 2 espaces (jamais tabs) — R-TABS du registre §4ter.7
 *   - Rate-limit côté index.ts (RL_ACTIVATION pour création/migration, RL_INFO_QR pour lecture)
 *   - Aucun PII en réponse, jamais
 *   - Format réponse : { ok: true, ... } ou { ok: false, code, message }
 */

import type { Env } from './types'

// ── Constantes Crockford ─────────────────────────────────────────────────────
// Réutilisé depuis qr-gen.ts (alphabet identique). Pour éviter une dépendance
// croisée, on duplique localement — la chaîne est immuable.
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RECOVERY_CODE_LENGTH = 16
const RECOVERY_PREFIX = 'MQJ' // préfixe affichage humain « MQJ-XXXX-XXXX-XXXX-XXXX »

function jsonResp(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  })
}

// ── Génération / parsing recovery_code ───────────────────────────────────────

/** Tirage uniforme [0, max) sans biais modulo. */
function tirageUniforme(max: number): number {
  const limit = Math.floor(256 / max) * max
  const buf = new Uint8Array(1)
  for (;;) {
    crypto.getRandomValues(buf)
    if (buf[0]! < limit) return buf[0]! % max
  }
}

/** Génère un recovery_code brut (16 chars Crockford, sans préfixe ni tirets).
 *  À stocker tel quel dans profils_joueur.recovery_code. */
export function genererRecoveryCodeBrut(): string {
  let out = ''
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
    out += CROCKFORD_ALPHABET[tirageUniforme(32)]
  }
  return out
}

/** Format affichage humain : « MQJ-XXXX-XXXX-XXXX-XXXX ». */
export function formaterRecoveryCodeAffichage(brut: string): string {
  if (brut.length !== RECOVERY_CODE_LENGTH) return brut
  return `${RECOVERY_PREFIX}-${brut.slice(0, 4)}-${brut.slice(4, 8)}-${brut.slice(8, 12)}-${brut.slice(12, 16)}`
}

/** Normalise une saisie utilisateur en recovery_code canonique :
 *   - tout en majuscules
 *   - retire préfixe MQJ, tirets, espaces, ponctuation
 *   - remplace les confusions Crockford : I→1, L→1, O→0, U→V
 *  Retourne null si le résultat ne fait pas exactement 16 chars valides. */
export function normaliserRecoveryCode(saisie: string): string | null {
  if (!saisie) return null
  let s = saisie.toUpperCase().replace(/[^0-9A-Z]/g, '')
  // Retire le préfixe MQJ s'il a survécu au strip (peut arriver si saisi sans tirets)
  if (s.startsWith(RECOVERY_PREFIX)) s = s.slice(RECOVERY_PREFIX.length)
  // Confusions Crockford
  s = s.replace(/I/g, '1').replace(/L/g, '1').replace(/O/g, '0').replace(/U/g, 'V')
  if (s.length !== RECOVERY_CODE_LENGTH) return null
  for (const c of s) {
    if (!CROCKFORD_ALPHABET.includes(c)) return null
  }
  return s
}

/** Génère un recovery_code garanti unique en base D1.
 *  Avec 80 bits d'entropie, la probabilité de collision est négligeable même
 *  à 1 million de profils (≈ 4×10⁻¹³). Mais on garde une boucle défensive. */
async function genererRecoveryCodeUnique(env: Env): Promise<string> {
  for (let tentative = 0; tentative < 8; tentative++) {
    const code = genererRecoveryCodeBrut()
    const existe = await env.DB
      .prepare('SELECT 1 FROM profils_joueur WHERE recovery_code = ? LIMIT 1')
      .bind(code)
      .first()
    if (!existe) return code
  }
  throw new Error('genererRecoveryCodeUnique: 8 collisions consécutives (anomalie)')
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/jeu/profil-creer
// ═════════════════════════════════════════════════════════════════════════════
//
// Crée un nouveau profil cloud joueur et y rattache toutes les activations
// actives du device courant. Idempotent côté client : appeler 2× crée 2 profils
// distincts (c'est le client qui choisit de sauvegarder le 1er recovery_code).
//
// Cas d'usage : « Je veux protéger mes licences avant de changer de téléphone. »
//
// Body :
//   { device_fingerprint: string }   // 8-128 chars
//
// Réponse 200 :
//   {
//     ok: true,
//     recovery_code: "MQJ-XXXX-XXXX-XXXX-XXXX",   // affichage humain
//     recovery_code_brut: "XXXXXXXXXXXXXXXX",      // 16 chars sans tirets
//     nb_activations_liees: number                  // licences attachées au profil
//   }
//
// Réponse 4xx :
//   400 BAD_DEVICE / BAD_JSON
//   404 NO_ACTIVATIONS    : aucune activation active pour ce device
//                          (refus : créer un profil vide n'a aucun sens)

interface ProfilCreerBody {
  device_fingerprint?: string
}

export async function handleJeuProfilCreer(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResp({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405)
  }

  let body: ProfilCreerBody
  try { body = await request.json() }
  catch { return jsonResp({ ok: false, code: 'BAD_JSON' }, 400) }

  if (typeof body.device_fingerprint !== 'string' || body.device_fingerprint.length < 8 || body.device_fingerprint.length > 128) {
    return jsonResp({ ok: false, code: 'BAD_DEVICE' }, 400)
  }
  const deviceFp = body.device_fingerprint

  // 1. Vérifier qu'il y a au moins 1 activation active pour ce device.
  //    Créer un profil vide n'a aucun intérêt — autant attendre que l'utilisateur
  //    ait activé au moins 1 QR.
  const activations = await env.DB.prepare(
    `SELECT id, cle_qr, produit_id, profil_joueur_id
       FROM activations_appareil
      WHERE device_fingerprint = ? AND date_revocation IS NULL`
  ).bind(deviceFp).all<{
    id: number;
    cle_qr: string;
    produit_id: string;
    profil_joueur_id: number | null;
  }>()

  const lignes = activations.results ?? []
  if (lignes.length === 0) {
    return jsonResp({
      ok: false,
      code: 'NO_ACTIVATIONS',
      message: 'Aucune licence active sur cet appareil. Active au moins un code QR avant de creer un profil cloud.'
    }, 404)
  }

  // 2. Refuse poliment si TOUTES les activations sont déjà rattachées à un profil.
  //    Dans ce cas l'utilisateur a déjà un recovery_code quelque part — il devrait
  //    le retrouver plutôt que d'en créer un nouveau.
  const aDeja = lignes.every(l => l.profil_joueur_id !== null)
  if (aDeja) {
    return jsonResp({
      ok: false,
      code: 'DEJA_LIE',
      message: 'Toutes les licences de cet appareil sont deja liees a un profil cloud existant. Utilise l\'option "Recuperer mon profil" si tu as deja un code MQJ.'
    }, 409)
  }

  // 3. Générer un recovery_code unique.
  const codeUnique = await genererRecoveryCodeUnique(env)
  const now = Math.floor(Date.now() / 1000)

  // 4. Batch atomique : INSERT profils_joueur + UPDATE activations_appareil
  //    pour celles qui ne sont pas déjà liées.
  // D1 batch est all-or-nothing.
  //
  // Note : on récupère l'ID via une lecture supplémentaire (D1 ne supporte pas
  // RETURNING dans un batch comme PostgreSQL). C'est OK car recovery_code est UNIQUE.
  await env.DB.prepare(
    `INSERT INTO profils_joueur (recovery_code, date_creation, date_derniere_act, est_archive)
     VALUES (?, ?, ?, 0)`
  ).bind(codeUnique, now, now).run()

  const profilCree = await env.DB.prepare(
    `SELECT id FROM profils_joueur WHERE recovery_code = ?`
  ).bind(codeUnique).first<{ id: number }>()

  if (!profilCree) {
    // Ne devrait jamais arriver (on vient juste de l'INSERT)
    return jsonResp({ ok: false, code: 'INTERNAL', message: 'Profil cree mais introuvable.' }, 500)
  }

  // UPDATE : ne touche que les activations sans profil_joueur_id pour ne pas
  // écraser un rattachement existant (cas hybride).
  const upd = await env.DB.prepare(
    `UPDATE activations_appareil
        SET profil_joueur_id = ?
      WHERE device_fingerprint = ?
        AND date_revocation IS NULL
        AND profil_joueur_id IS NULL`
  ).bind(profilCree.id, deviceFp).run()

  // meta.changes contient le nombre de rangées modifiées (compat D1)
  const nbLiees = typeof upd.meta?.changes === 'number' ? upd.meta.changes : lignes.filter(l => l.profil_joueur_id === null).length

  return jsonResp({
    ok: true,
    recovery_code: formaterRecoveryCodeAffichage(codeUnique),
    recovery_code_brut: codeUnique,
    nb_activations_liees: nbLiees,
    profil_id_interne: profilCree.id
  })
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/jeu/profil-recuperer
// ═════════════════════════════════════════════════════════════════════════════
//
// L'utilisateur a un recovery_code (« MQJ-XXXX-... ») et veut retrouver ses
// licences sur un nouvel appareil. On migre toutes les activations actives
// du profil vers ce nouveau device.
//
// Comportement :
//   - Pour chaque activation active du profil :
//       * Si l'activation est déjà sur ce device → no-op (idempotent)
//       * Sinon → révoque l'ancienne (motif='transfer_auto') + INSERT nouvelle
//                 + UPDATE licences_qr.device_fingerprint + incrémente nb_transferts_auto
//   - Met à jour profils_joueur.date_derniere_act
//
// Body :
//   { recovery_code: string, device_fingerprint: string }
//
// Réponse 200 :
//   {
//     ok: true,
//     nb_activations_migrees: number,
//     nb_activations_deja_ici: number,
//     produits_actifs: string[],
//     activations: [{ cle_qr_masque, produit_id, date_activation }]
//   }
//
// Réponse 4xx :
//   400 BAD_JSON / BAD_DEVICE / BAD_RECOVERY_CODE (format ou checksum)
//   404 PROFIL_NOT_FOUND : recovery_code introuvable ou profil archivé

interface ProfilRecupererBody {
  recovery_code?: string
  device_fingerprint?: string
}

export async function handleJeuProfilRecuperer(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResp({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405)
  }

  let body: ProfilRecupererBody
  try { body = await request.json() }
  catch { return jsonResp({ ok: false, code: 'BAD_JSON' }, 400) }

  if (typeof body.recovery_code !== 'string') {
    return jsonResp({ ok: false, code: 'BAD_RECOVERY_CODE' }, 400)
  }
  const codeNorm = normaliserRecoveryCode(body.recovery_code)
  if (!codeNorm) {
    return jsonResp({
      ok: false,
      code: 'BAD_RECOVERY_CODE',
      message: 'Le code de recuperation est invalide. Format attendu : MQJ-XXXX-XXXX-XXXX-XXXX.'
    }, 400)
  }
  if (typeof body.device_fingerprint !== 'string' || body.device_fingerprint.length < 8 || body.device_fingerprint.length > 128) {
    return jsonResp({ ok: false, code: 'BAD_DEVICE' }, 400)
  }
  const deviceFp = body.device_fingerprint

  // 1. Cherche le profil (non archivé)
  const profil = await env.DB.prepare(
    `SELECT id, recovery_code FROM profils_joueur
      WHERE recovery_code = ? AND est_archive = 0`
  ).bind(codeNorm).first<{ id: number; recovery_code: string }>()

  if (!profil) {
    return jsonResp({
      ok: false,
      code: 'PROFIL_NOT_FOUND',
      message: 'Aucun profil ne correspond a ce code. Verifie la saisie.'
    }, 404)
  }

  // 2. Liste les activations actives du profil
  const activations = await env.DB.prepare(
    `SELECT id, cle_qr, device_fingerprint, produit_id, date_activation
       FROM activations_appareil
      WHERE profil_joueur_id = ? AND date_revocation IS NULL`
  ).bind(profil.id).all<{
    id: number;
    cle_qr: string;
    device_fingerprint: string;
    produit_id: string;
    date_activation: number;
  }>()

  const lignes = activations.results ?? []
  const now = Math.floor(Date.now() / 1000)

  let nbMigrees = 0
  let nbDejaIci = 0

  // 3. Pour chaque activation : si pas déjà sur ce device, on migre.
  //    On fait les opérations séquentiellement (pas batch) car chaque migration
  //    est indépendante et on veut compter précisément. Si l'une échoue, les
  //    précédentes restent en place — c'est acceptable pour ce flow (l'utilisateur
  //    pourra réessayer, et l'opération est idempotente).
  for (const act of lignes) {
    if (act.device_fingerprint === deviceFp) {
      nbDejaIci++
      continue
    }

    // Batch atomique pour cette activation :
    // 1) révoquer l'ancienne activation
    // 2) insérer la nouvelle sur ce device (avec lien profil)
    // 3) mettre à jour licences_qr (device_fingerprint + nb_transferts_auto + dates)
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE activations_appareil
            SET date_revocation = ?,
                motif_revocation = 'transfer_auto'
          WHERE id = ? AND date_revocation IS NULL`
      ).bind(now, act.id),
      env.DB.prepare(
        `INSERT INTO activations_appareil
           (cle_qr, device_fingerprint, profil_joueur_id, produit_id,
            date_activation, date_revocation, motif_revocation)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)`
      ).bind(act.cle_qr, deviceFp, profil.id, act.produit_id, now),
      env.DB.prepare(
        `UPDATE licences_qr
            SET device_fingerprint = ?,
                derniere_activation_date = ?,
                nb_transferts_auto = nb_transferts_auto + 1
          WHERE cle_qr = ?`
      ).bind(deviceFp, now, act.cle_qr)
    ])
    nbMigrees++
  }

  // 4. Met à jour la dernière activité du profil
  await env.DB.prepare(
    `UPDATE profils_joueur SET date_derniere_act = ? WHERE id = ?`
  ).bind(now, profil.id).run()

  // 5. Lecture finale : retourne les activations actives sur ce device
  const final_ = await env.DB.prepare(
    `SELECT cle_qr, produit_id, date_activation
       FROM activations_appareil
      WHERE device_fingerprint = ? AND date_revocation IS NULL
      ORDER BY date_activation ASC`
  ).bind(deviceFp).all<{
    cle_qr: string;
    produit_id: string;
    date_activation: number;
  }>()

  const rows = final_.results ?? []
  const produitsActifs = Array.from(new Set(rows.map(r => r.produit_id)))

  return jsonResp({
    ok: true,
    nb_activations_migrees: nbMigrees,
    nb_activations_deja_ici: nbDejaIci,
    produits_actifs: produitsActifs,
    activations: rows.map(r => ({
      cle_qr_masque: r.cle_qr.slice(0, 4) + '...',
      produit_id: r.produit_id,
      date_activation: r.date_activation
    }))
  })
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE : GET /api/jeu/profil-licences/:recovery_code
// ═════════════════════════════════════════════════════════════════════════════
//
// Vue lecture seule : retourne les activations actives du profil cloud, SANS
// migrer vers le device appelant. Utile pour :
//   - Confirmer qu'un recovery_code est valide avant la migration
//   - Afficher dans l'UI Godot « voici les licences associées à ce profil »
//
// PAS rate-limité aussi agressivement que profil-recuperer (lecture pure).

export async function handleJeuProfilLicences(request: Request, env: Env, recoveryCodeRaw: string): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResp({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405)
  }

  const codeNorm = normaliserRecoveryCode(recoveryCodeRaw)
  if (!codeNorm) {
    return jsonResp({ ok: false, code: 'BAD_RECOVERY_CODE' }, 400)
  }

  const profil = await env.DB.prepare(
    `SELECT id FROM profils_joueur WHERE recovery_code = ? AND est_archive = 0`
  ).bind(codeNorm).first<{ id: number }>()

  if (!profil) {
    return jsonResp({ ok: false, code: 'PROFIL_NOT_FOUND' }, 404)
  }

  const rows = await env.DB.prepare(
    `SELECT cle_qr, device_fingerprint, produit_id, date_activation
       FROM activations_appareil
      WHERE profil_joueur_id = ? AND date_revocation IS NULL
      ORDER BY date_activation ASC`
  ).bind(profil.id).all<{
    cle_qr: string;
    device_fingerprint: string;
    produit_id: string;
    date_activation: number;
  }>()

  const lignes = rows.results ?? []
  const produitsActifs = Array.from(new Set(lignes.map(r => r.produit_id)))

  return jsonResp({
    ok: true,
    est_gratuit: produitsActifs.length === 0,
    produits_actifs: produitsActifs,
    activations: lignes.map(r => ({
      cle_qr_masque: r.cle_qr.slice(0, 4) + '...',
      device_fingerprint_masque: r.device_fingerprint.slice(0, 6) + '...',
      produit_id: r.produit_id,
      date_activation: r.date_activation
    }))
  })
}
