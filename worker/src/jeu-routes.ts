/**
 * Sprint IMPORT-ELEVES — Items IE-3 + IE-3bis
 *
 * Endpoints exposés côté JEU GODOT (pas auth prof Tauri) :
 *
 *   GET  /api/jeu/info-qr/:cle_qr     → magie pré-remplissage code classe (DEC-56)
 *   POST /api/jeu/saisie-code-classe  → matching DEC-57 (item IE-3)
 *   POST /api/jeu/activer-qr          → activation initiale (item 12 PB1)
 *   POST /api/jeu/desactiver-qr       → révocation device (transfert licence)
 *   GET  /api/jeu/mes-licences/:dev   → liste produits actifs (DEC-63)
 *
 * Modèle DEC-63 (multi-licences hybride) :
 *   - Source de vérité = table activations_appareil (1 rangée active par produit)
 *   - licences_qr.device_fingerprint reste comme "vue actuelle" (rcompat)
 *   - mes-licences agrège tous les produits actifs d'un device (cumulable)
 *
 * Conventions :
 *   - 2 espaces (jamais tabs)
 *   - PUBLIC : pas de JWT, mais rate-limité par IP (RL_INFO_QR / RL_SAISIE via index.ts)
 *   - Aucun PII exposé : juste le code classe + libellé générique
 *   - Format réponse : { ok: true, ... } ou { ok: false, code, message }
 */

import type { Env } from './types'

const CLE_REGEX = /^[0-9A-HJKMNP-TV-Z]{12}$/

function jsonResp(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  })
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE : GET /api/jeu/info-qr/:cle_qr  (item IE-3bis)
// ═════════════════════════════════════════════════════════════════════════════
//
// Appelé par Godot après scan d'un QR pour pré-remplir le formulaire
// "Identifiant pour l'école" du profil joueur.
//
// Réponses :
//   - 200 OK avec { ok: true, cle_qr, produit_id, code_classe?, nom_classe_affiche? }
//     → si QR existe et n'est pas révoqué. `code_classe` présent seulement si
//       le prof a déjà attribué le QR à une classe (item 11.4 PB1).
//   - 404 si QR introuvable (mauvais format, ou pas dans la DB)
//   - 410 Gone si QR révoqué (cle_qr existe mais est_revoquee=1)
//
// IMPORTANT : pour respecter la souveraineté Loi 25, on n'expose JAMAIS
//   - l'email du prof
//   - le pseudo d'un autre élève déjà activé
//   - le code école (code_court) ni le nom de l'école

interface InfoQrReponse {
  ok: true
  cle_qr: string
  produit_id: string
  code_classe?: string
  nom_classe_affiche?: string
}

export async function handleJeuInfoQr(
  request: Request, env: Env, cle_qr: string
): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResp({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405)
  }

  // Normalisation : majuscules + suppression tirets éventuels
  const cleNorm = cle_qr.toUpperCase().replace(/-/g, '')
  if (!CLE_REGEX.test(cleNorm)) {
    // Format invalide = QR introuvable côté élève (404 plutôt que 400 pour ne pas
    // donner d'indice sur la structure)
    return jsonResp({ ok: false, code: 'NOT_FOUND' }, 404)
  }

  const row = await env.DB.prepare(
    `SELECT
       lq.cle_qr,
       lq.produit_id,
       lq.est_revoquee,
       lq.classe_id,
       c.code_classe,
       c.nom_affiche
     FROM licences_qr lq
     LEFT JOIN classes c ON c.id = lq.classe_id AND c.est_archivee = 0
     WHERE lq.cle_qr = ?`
  ).bind(cleNorm).first<{
    cle_qr: string
    produit_id: string
    est_revoquee: number
    classe_id: number | null
    code_classe: string | null
    nom_affiche: string | null
  }>()

  if (!row) {
    return jsonResp({ ok: false, code: 'NOT_FOUND' }, 404)
  }

  if (row.est_revoquee === 1) {
    return jsonResp({
      ok: false,
      code: 'REVOKED',
      message: 'Ce code QR a ete desactive par votre enseignant. Contactez-le pour obtenir un nouveau code.'
    }, 410)
  }

  const reponse: InfoQrReponse = {
    ok: true,
    cle_qr: row.cle_qr,
    produit_id: row.produit_id
  }

  // Magie pré-remplissage : si le QR est attribué à une classe non archivée,
  // on inclut le code_classe + un libellé d'affichage
  if (row.classe_id !== null && row.code_classe !== null) {
    reponse.code_classe = row.code_classe
    // nom_affiche peut être NULL si le prof n'a pas saisi de libellé custom
    reponse.nom_classe_affiche = row.nom_affiche ?? `Classe ${row.code_classe.split('-').slice(0, 2).join(' - ')}`
  }

  return jsonResp(reponse)
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/jeu/saisie-code-classe  (item IE-3, DEC-57 matching)
// ══════════════════════════════════════════════════════════════════════════════
//
// L'élève dans Godot envoie sa cle_qr + code_classe saisi + infos d'identité.
// Le Worker fait :
//   1. Vérifie que la cle_qr existe et n'est pas révoquée
//   2. Vérifie que le code_classe saisi correspond bien à la classe attribuée
//      au QR (ou que le QR n'a pas encore de classe → on l'attribue)
//   3. Calcule l'empreinte hash des champs saisis (même algo que IE-2)
//   4. Cherche dans eleves_pre_crees de la classe :
//      - 1 match exact (par hashs disponibles) → 'auto' + lier eleve_pre_cree_id
//      - N matches sur prenom_hash seulement → 'conflit'
//      - 0 match → 'non_associe'
// Le tout est public (pas de JWT) mais rate-limité par IP.
//
// Bloc 4 du QUESTIONS-POUR-JEFF : politique NULL = ignoré côté prof (option C).
// Si le prof n'a pas importé le nom, on n'exige pas le nom dans le matching.

interface SaisieCodeClasseBody {
  cle_qr?: string
  code_classe?: string
  prenom_hash?: string
  nom_hash?: string | null
  niveau_hash?: string | null
  code_court_hash?: string | null
  // Le pseudo élève (saisi par lui dans Godot) est stocké en clair dans
  // licences_qr.eleve_pseudo pour traabilité (champ existant migration 0010).
  // Ce n'est PAS un PII enfant au sens Loi 25 strict car c'est un pseudonyme
  // choisi par l'élève, pas son vrai nom.
  eleve_pseudo?: string
  device_fingerprint?: string
}

interface SaisieReponse {
  ok: true
  match_statut: 'auto' | 'conflit' | 'non_associe'
  eleve_pre_cree_id: number | null
  candidats_homonymes?: number  // si conflit, nombre de candidats
  message?: string
}

const HASH_REGEX_LOWER = /^[0-9a-f]{64}$/

function validerHashOpt(v: unknown): string | null {
  if (v == null) return null
  if (typeof v !== 'string') return null
  return HASH_REGEX_LOWER.test(v) ? v : null
}

export async function handleJeuSaisieCodeClasse(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResp({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405)
  }

  let body: SaisieCodeClasseBody
  try { body = await request.json() }
  catch { return jsonResp({ ok: false, code: 'BAD_JSON' }, 400) }

  // Validation entrées
  if (typeof body.cle_qr !== 'string') {
    return jsonResp({ ok: false, code: 'BAD_CLE_QR' }, 400)
  }
  const cleNorm = body.cle_qr.toUpperCase().replace(/-/g, '')
  if (!CLE_REGEX.test(cleNorm)) {
    return jsonResp({ ok: false, code: 'BAD_CLE_FORMAT' }, 400)
  }
  if (typeof body.code_classe !== 'string' || body.code_classe.length < 5) {
    return jsonResp({ ok: false, code: 'BAD_CODE_CLASSE' }, 400)
  }
  if (!validerHashOpt(body.prenom_hash)) {
    return jsonResp({ ok: false, code: 'BAD_PRENOM_HASH', message: 'prenom_hash requis (SHA-256 hex)' }, 400)
  }
  if (typeof body.eleve_pseudo !== 'string' || body.eleve_pseudo.length === 0 || body.eleve_pseudo.length > 64) {
    return jsonResp({ ok: false, code: 'BAD_PSEUDO' }, 400)
  }
  if (typeof body.device_fingerprint !== 'string' || body.device_fingerprint.length < 8) {
    return jsonResp({ ok: false, code: 'BAD_DEVICE' }, 400)
  }

  const prenom_hash = body.prenom_hash as string
  const nom_hash = validerHashOpt(body.nom_hash)
  const niveau_hash = validerHashOpt(body.niveau_hash)
  const code_court_hash = validerHashOpt(body.code_court_hash)

  // 1. Vérifier la cle_qr
  const lqr = await env.DB.prepare(
    `SELECT cle_qr, classe_id, est_revoquee, eleve_pseudo, device_fingerprint, match_statut
     FROM licences_qr WHERE cle_qr = ?`
  ).bind(cleNorm).first<{
    cle_qr: string; classe_id: number | null; est_revoquee: number;
    eleve_pseudo: string | null; device_fingerprint: string | null;
    match_statut: string
  }>()

  if (!lqr) return jsonResp({ ok: false, code: 'CLE_NOT_FOUND' }, 404)
  if (lqr.est_revoquee === 1) {
    return jsonResp({
      ok: false,
      code: 'REVOKED',
      message: 'Ce code QR a ete desactive par votre enseignant.'
    }, 410)
  }

  // 2. Vérifier le code_classe
  const classeNorm = body.code_classe.trim()
  const classe = await env.DB.prepare(
    `SELECT id, est_archivee FROM classes WHERE code_classe = ?`
  ).bind(classeNorm).first<{ id: number; est_archivee: number }>()

  if (!classe) return jsonResp({ ok: false, code: 'CLASSE_NOT_FOUND' }, 404)
  if (classe.est_archivee === 1) {
    return jsonResp({ ok: false, code: 'CLASSE_ARCHIVED' }, 410)
  }

  // 3. Cohérence : si le QR a déjà une classe_id, elle doit matcher
  if (lqr.classe_id !== null && lqr.classe_id !== classe.id) {
    return jsonResp({
      ok: false,
      code: 'CLASSE_MISMATCH',
      message: 'Ce code QR est associe a une autre classe. Verifiez avec votre enseignant.'
    }, 409)
  }

  // 4. Matching DEC-57 dans eleves_pre_crees
  // Bloc 4 question Jeff : on considère les champs comme optionnels côté prof.
  // Stratégie :
  //   a) Cherche les candidats avec prenom_hash exact + match strict sur les autres
  //      champs SI fournis par l'élève ET par le prof. Si NULL côté prof, accepté.
  //   b) Compte les résultats :
  //      - 1 ligne → 'auto'
  //      - 2+ lignes → 'conflit'
  //      - 0 ligne → 'non_associe'
  //
  // SQL : on récupère tous les candidats avec prenom_hash matching et est_archive=0,
  // puis on filtre en JS sur les champs optionnels.

  const candidats = await env.DB.prepare(
    `SELECT id, nom_hash, niveau_hash, code_court_hash
     FROM eleves_pre_crees
     WHERE classe_id = ? AND prenom_hash = ? AND est_archive = 0`
  ).bind(classe.id, prenom_hash).all<{
    id: number;
    nom_hash: string | null;
    niveau_hash: string | null;
    code_court_hash: string | null
  }>()

  const cands = candidats.results ?? []

  // Filtre : pour chaque champ optionnel, si l'élève l'a fourni ET le prof l'a fourni,
  // les deux doivent matcher. Si NULL côté prof, on considère que c'est compatible.
  function compatible(c: { nom_hash: string|null; niveau_hash: string|null; code_court_hash: string|null }): boolean {
    if (c.nom_hash !== null && nom_hash !== null && c.nom_hash !== nom_hash) return false
    if (c.niveau_hash !== null && niveau_hash !== null && c.niveau_hash !== niveau_hash) return false
    if (c.code_court_hash !== null && code_court_hash !== null && c.code_court_hash !== code_court_hash) return false
    return true
  }

  const compatibles = cands.filter(compatible)

  let match_statut: 'auto' | 'conflit' | 'non_associe'
  let eleve_pre_cree_id: number | null = null
  let candidats_homonymes: number | undefined

  if (compatibles.length === 1) {
    match_statut = 'auto'
    eleve_pre_cree_id = compatibles[0].id
  } else if (compatibles.length >= 2) {
    match_statut = 'conflit'
    candidats_homonymes = compatibles.length
  } else {
    match_statut = 'non_associe'
  }

  // 5. UPDATE licences_qr
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `UPDATE licences_qr
     SET classe_id = ?,
         eleve_pseudo = ?,
         device_fingerprint = ?,
         activation_initiale_date = COALESCE(activation_initiale_date, ?),
         derniere_activation_date = ?,
         match_statut = ?,
         eleve_pre_cree_id = ?
     WHERE cle_qr = ?`
  ).bind(
    classe.id,
    body.eleve_pseudo,
    body.device_fingerprint,
    now, now,
    match_statut,
    eleve_pre_cree_id,
    cleNorm
  ).run()

  const reponse: SaisieReponse = {
    ok: true,
    match_statut,
    eleve_pre_cree_id
  }
  if (candidats_homonymes !== undefined) {
    reponse.candidats_homonymes = candidats_homonymes
    reponse.message = 'Votre enseignant verifiera votre identite manuellement. Vous pouvez quand meme jouer.'
  } else if (match_statut === 'non_associe') {
    reponse.message = 'Aucune correspondance trouvee. Votre enseignant vous associera manuellement.'
  }

  return jsonResp(reponse)
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/jeu/activer-qr  (item 12 PB1)
// ══════════════════════════════════════════════════════════════════════════════
//
// 1ère activation d'un QR sur un appareil. Cas d'usage :
//   - Licences individuelles achetées par les parents (pas de prof / classe)
//   - Licences école où l'élève veut juste utiliser le QR sans encore saisir
//     son identifiant école (qui peut être fait plus tard via saisie-code-classe)
//
// Bloc 11 du QUESTIONS-POUR-JEFF : Jeff doit confirmer si cet endpoint reste
// (option B) ou si on fusionne avec saisie-code-classe (option A).
// Codé ici pour le cas (B) qui couvre le plus de scénarios.
//
// Body :
//   {
//     cle_qr: string,
//     device_fingerprint: string,
//     eleve_pseudo?: string   // facultatif à cette étape
//   }
//
// Réponse :
//   {
//     ok: true,
//     produit_id: string,
//     premiere_activation: boolean,  // false si déjà activé ailleurs
//     transfert_requis?: boolean     // si device != device_existant, signal transfert
//   }

interface ActiverQrBody {
  cle_qr?: string
  device_fingerprint?: string
  eleve_pseudo?: string
}

export async function handleJeuActiverQr(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResp({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405)
  }

  let body: ActiverQrBody
  try { body = await request.json() }
  catch { return jsonResp({ ok: false, code: 'BAD_JSON' }, 400) }

  if (typeof body.cle_qr !== 'string') {
    return jsonResp({ ok: false, code: 'BAD_CLE_QR' }, 400)
  }
  const cleNorm = body.cle_qr.toUpperCase().replace(/-/g, '')
  if (!CLE_REGEX.test(cleNorm)) {
    return jsonResp({ ok: false, code: 'BAD_CLE_FORMAT' }, 400)
  }
  if (typeof body.device_fingerprint !== 'string' || body.device_fingerprint.length < 8) {
    return jsonResp({ ok: false, code: 'BAD_DEVICE' }, 400)
  }
  if (body.eleve_pseudo !== undefined) {
    if (typeof body.eleve_pseudo !== 'string' || body.eleve_pseudo.length === 0 || body.eleve_pseudo.length > 64) {
      return jsonResp({ ok: false, code: 'BAD_PSEUDO' }, 400)
    }
  }

  // Vérifier la cle_qr
  const lqr = await env.DB.prepare(
    `SELECT cle_qr, produit_id, est_revoquee,
            device_fingerprint, activation_initiale_date,
            nb_transferts_auto,
            expire_le, duree_apres_activation_jours
     FROM licences_qr WHERE cle_qr = ?`
  ).bind(cleNorm).first<{
    cle_qr: string;
    produit_id: string;
    est_revoquee: number;
    device_fingerprint: string | null;
    activation_initiale_date: number | null;
    nb_transferts_auto: number;
    expire_le: number | null;
    duree_apres_activation_jours: number | null;
  }>()

  if (!lqr) return jsonResp({ ok: false, code: 'CLE_NOT_FOUND' }, 404)
  if (lqr.est_revoquee === 1) {
    return jsonResp({
      ok: false,
      code: 'REVOKED',
      message: 'Ce code QR a ete desactive.'
    }, 410)
  }

  const now = Math.floor(Date.now() / 1000)

  // ───────────────────────────────────────────────────────────────────
  // Sprint EXP-QR (17 mai 2026) : vérif expiration AVANT activation
  // ───────────────────────────────────────────────────────────────────
  if (lqr.expire_le !== null && now >= lqr.expire_le) {
    return jsonResp({
      ok: false,
      code: 'EXPIRED',
      message: 'Ce code a expire.',
      expire_le: lqr.expire_le
    }, 410)
  }

  const premiereActivation = lqr.activation_initiale_date === null
  const memeDevice = lqr.device_fingerprint === body.device_fingerprint
  const transfertRequis = !premiereActivation && !memeDevice

  if (transfertRequis) {
    // Item 13 PB1 : logique transfert D2 — pas encore implémentée en détail.
    // Pour l'instant on bloque et on demande au prof / support de gérer.
    return jsonResp({
      ok: false,
      code: 'TRANSFER_REQUIRED',
      message: 'Cette licence est deja active sur un autre appareil. Contactez votre enseignant ou le support.',
      nb_transferts_auto: lqr.nb_transferts_auto
    }, 409)
  }

  // UPDATE : activation initiale OU re-confirm même device
  if (premiereActivation) {
    // Sprint EXP-QR : si durée glissante définie, calculer expire_le maintenant
    let expire_le_final = lqr.expire_le;
    if (lqr.duree_apres_activation_jours !== null) {
      expire_le_final = now + lqr.duree_apres_activation_jours * 86400;
    }
    await env.DB.prepare(
      `UPDATE licences_qr
       SET device_fingerprint = ?,
           activation_initiale_date = ?,
           derniere_activation_date = ?,
           eleve_pseudo = COALESCE(?, eleve_pseudo),
           expire_le = ?
       WHERE cle_qr = ?`
    ).bind(
      body.device_fingerprint,
      now, now,
      body.eleve_pseudo ?? null,
      expire_le_final,
      cleNorm
    ).run()
  } else {
    // Même device, on update juste derniere_activation_date
    await env.DB.prepare(
      `UPDATE licences_qr
       SET derniere_activation_date = ?,
           eleve_pseudo = COALESCE(?, eleve_pseudo)
       WHERE cle_qr = ?`
    ).bind(now, body.eleve_pseudo ?? null, cleNorm).run()
  }

  // DEC-63 : double-écriture dans activations_appareil pour le modèle hybride.
  // On garde licences_qr.device_fingerprint (rcompat) mais la source de vérité
  // pour "quels produits sont actifs sur cet appareil" devient activations_appareil.
  if (premiereActivation) {
    await env.DB.prepare(
      `INSERT INTO activations_appareil
         (cle_qr, device_fingerprint, profil_joueur_id, produit_id,
          date_activation, date_revocation, motif_revocation)
       VALUES (?, ?, NULL, ?, ?, NULL, NULL)`
    ).bind(cleNorm, body.device_fingerprint, lqr.produit_id, now).run()
  }
  // Cas "même device" : pas besoin de créer une nouvelle activation (la précédente est
  // toujours active). Si elle a été révoquée (rare), on en crée une nouvelle.
  else {
    const dejaActive = await env.DB.prepare(
      `SELECT 1 FROM activations_appareil
        WHERE cle_qr = ? AND device_fingerprint = ? AND date_revocation IS NULL
        LIMIT 1`
    ).bind(cleNorm, body.device_fingerprint).first()
    if (!dejaActive) {
      await env.DB.prepare(
        `INSERT INTO activations_appareil
           (cle_qr, device_fingerprint, profil_joueur_id, produit_id,
            date_activation, date_revocation, motif_revocation)
         VALUES (?, ?, NULL, ?, ?, NULL, NULL)`
      ).bind(cleNorm, body.device_fingerprint, lqr.produit_id, now).run()
    }
  }

  // Renvoyer expire_le si applicable (mode B : on vient juste de le calculer)
  let expire_le_response: number | null = lqr.expire_le;
  if (premiereActivation && lqr.duree_apres_activation_jours !== null) {
    expire_le_response = now + lqr.duree_apres_activation_jours * 86400;
  }

  return jsonResp({
    ok: true,
    produit_id: lqr.produit_id,
    premiere_activation: premiereActivation,
    expire_le: expire_le_response
  })
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/jeu/desactiver-qr
// ══════════════════════════════════════════════════════════════════════════════
//
// Révoque l'association device ↔ licence dans activations_appareil.
// Après cet appel, GET /api/jeu/mes-licences ne retournera plus ce produit
// pour ce device → l'accès premium ne se réactive PLUS automatiquement.
//
// Body :
//   {
//     cle_qr_masque: string,       // ex: "JF40G..." (4 premiers chars + "...")
//     device_fingerprint: string,
//     produit_id: string           // ex: "continent_1"
//   }
//
// Notes sécurité :
//   - On accepte le masque (4 chars) ET la clé complète (12 chars normalisée)
//     pour flexibilité côté Godot.
//   - On ne vérifie PAS de JWT : la possession du device_fingerprint + cle_qr
//     est suffisante (le device_fingerprint est un secret local généré par Godot).
//   - Rate-limité RL_ACTIVATION côté index.ts (anti-spam révocations).
//
// Réponse 200 :
//   { ok: true, revocations: N }   // N = nombre de rangées révoquées (0 ou 1+)
//
// Réponse 404 si la cle_qr est introuvable ou ne correspond pas au device.

interface DesactiverQrBody {
  cle_qr_masque?: string
  device_fingerprint?: string
  produit_id?: string
}

export async function handleJeuDesactiverQr(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResp({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405)
  }

  let body: DesactiverQrBody
  try { body = await request.json() }
  catch { return jsonResp({ ok: false, code: 'BAD_JSON' }, 400) }

  if (typeof body.device_fingerprint !== 'string' || body.device_fingerprint.length < 8) {
    return jsonResp({ ok: false, code: 'BAD_DEVICE' }, 400)
  }
  if (typeof body.cle_qr_masque !== 'string' || body.cle_qr_masque.length < 4) {
    return jsonResp({ ok: false, code: 'BAD_CLE_QR_MASQUE' }, 400)
  }
  if (typeof body.produit_id !== 'string' || body.produit_id.length === 0) {
    return jsonResp({ ok: false, code: 'BAD_PRODUIT_ID' }, 400)
  }

  const now = Math.floor(Date.now() / 1000)
  const prefixe = body.cle_qr_masque.replace(/\.\.\..*$/, '').toUpperCase().slice(0, 4)

  // Résoudre la cle_qr complète : chercher dans activations_appareil
  // toutes les activations actives de ce device+produit dont la cle_qr commence
  // par le préfixe fourni.
  const candidates = await env.DB.prepare(
    `SELECT aa.id, aa.cle_qr
       FROM activations_appareil aa
      WHERE aa.device_fingerprint = ?
        AND aa.produit_id = ?
        AND aa.date_revocation IS NULL
        AND UPPER(SUBSTR(aa.cle_qr, 1, 4)) = ?`
  ).bind(body.device_fingerprint, body.produit_id, prefixe)
   .all<{ id: number; cle_qr: string }>()

  const rows = candidates.results ?? []

  if (rows.length === 0) {
    // Aucune activation active trouvée pour ce device+produit+préfixe
    return jsonResp({
      ok: false,
      code: 'NOT_FOUND',
      message: 'Aucune licence active trouvee pour ce device et ce produit.'
    }, 404)
  }

  // Révoquer toutes les entrées correspondantes (normalement 1)
  let revocations = 0
  for (const row of rows) {
    await env.DB.prepare(
      `UPDATE activations_appareil
          SET date_revocation = ?,
              motif_revocation = 'transfert_joueur'
        WHERE id = ?`
    ).bind(now, row.id).run()

    // Compatibilité rétro : remettre licences_qr.device_fingerprint à NULL
    // pour que l'ancienne logique de activer-qr voie la licence comme "libre"
    // (transfert_requis = false sur le prochain appareil)
    await env.DB.prepare(
      `UPDATE licences_qr
          SET device_fingerprint = NULL,
              activation_initiale_date = NULL
        WHERE cle_qr = ?
          AND device_fingerprint = ?`
    ).bind(row.cle_qr, body.device_fingerprint).run()

    revocations++
  }

  return jsonResp({ ok: true, revocations })
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE : GET /api/jeu/mes-licences/:device_fingerprint  (DEC-63)
// ═══════════════════════════════════════════════════════════════════════════
//
// Appelé par Godot au démarrage du jeu (et après chaque activation réussie)
// pour savoir quels produits sont actuellement débloqués sur cet appareil.
//
// L'état "version gratuite" est CALCULÉ : si `produits_actifs` est vide, le jeu
// affiche Continent 1 (toujours gratuit) et bloque tout le reste.
//
// Réponse :
//   {
//     ok: true,
//     device_fingerprint: string,
//     est_gratuit: boolean,           // = (produits_actifs.length === 0)
//     produits_actifs: string[],      // ex: ["continent_1"] ou ["continent_1","continent_2"]
//     activations: [                  // détail pour UI optionnelle ("mes codes")
//       { cle_qr_masque: "K7P2-...", produit_id: "continent_1", date_activation: 1234 }
//     ]
//   }
//
// Endpoint PUBLIC (pas de JWT) mais rate-limité par device_fingerprint côté index.ts.
// Aucun PII exposé : on masque la cle_qr (4 premiers chars + "...") au cas où.

export async function handleJeuMesLicences(request: Request, env: Env, deviceFp: string): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResp({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405)
  }
  if (typeof deviceFp !== 'string' || deviceFp.length < 8 || deviceFp.length > 128) {
    return jsonResp({ ok: false, code: 'BAD_DEVICE' }, 400)
  }

  // Sprint UNIFY-PHASE2 (17 mai 2026) : JOIN avec licences_qr pour filtrer
  // les QR expirés ou révoqués + inclure expire_le dans la réponse.
  const now_sec = Math.floor(Date.now() / 1000)
  const rows = await env.DB.prepare(
    `SELECT aa.cle_qr, aa.produit_id, aa.date_activation,
            lqr.expire_le, lqr.est_revoquee
       FROM activations_appareil aa
       JOIN licences_qr lqr ON lqr.cle_qr = aa.cle_qr
      WHERE aa.device_fingerprint = ?
        AND aa.date_revocation IS NULL
        AND lqr.est_revoquee = 0
        AND (lqr.expire_le IS NULL OR lqr.expire_le > ?)
      ORDER BY aa.date_activation ASC`
  ).bind(deviceFp, now_sec).all<{
    cle_qr: string;
    produit_id: string;
    date_activation: number;
    expire_le: number | null;
    est_revoquee: number;
  }>()

  const activations = (rows.results ?? []).map(r => ({
    cle_qr_masque: r.cle_qr.slice(0, 4) + '...',
    produit_id: r.produit_id,
    date_activation: r.date_activation,
    expire_le: r.expire_le
  }))
  // Dédoublonnage des produits (un device pourrait avoir 2 QR débloquant le même produit ;
  // rare mais possible, ex: 1 QR école + 1 QR cadeau pour le même continent).
  const produitsActifs = Array.from(new Set(activations.map(a => a.produit_id)))

  return jsonResp({
    ok: true,
    device_fingerprint: deviceFp,
    est_gratuit: produitsActifs.length === 0,
    produits_actifs: produitsActifs,
    activations
  })
}
