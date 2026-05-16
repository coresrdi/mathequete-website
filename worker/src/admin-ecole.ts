/**
 * Sprint PB1 — Items 11.1 + 11.2 (admin école + liaison prof↔école)
 *
 * Endpoints exposés (cf. registre v4.6 §4ter.8) :
 *
 *   GET    /api/prof/mon-ecole                       → liste des forfaits liés au prof connecté
 *                                                      + liste profs membres si l'utilisateur est admin
 *   POST   /api/prof/mon-ecole/assigner-qr           → admin assigne N QR à un prof_membre
 *   POST   /api/prof/me-lier-ecole                   → prof saisit code_court + email_admin
 *                                                      → crée une demande en_attente
 *   POST   /api/prof/mon-ecole/valider-prof/:id      → admin valide (ou rejette) une demande
 *
 * Modèle de rôles (PB1-DEC-10) :
 *   - 'admin'  = email_admin du forfait Stripe (auto-créé au login si match exact)
 *   - 'membre' = prof inscrit qui demande à être lié à une école
 *
 * Conventions (registre v4.6 §4ter.7) :
 *   - 2 espaces (jamais tabs)
 *   - Réutilise authentifier() de prof-routes.ts + ecrireAudit() de auth-prof.ts
 *   - require2fa = true
 *   - Audit log obligatoire sur toute mutation
 */

import type { Env } from './types'
import { authentifier } from './prof-routes'
import { ecrireAudit, extraireMetadonneesRequete, jsonOk, jsonErr } from './auth-prof'

// ═════════════════════════════════════════════════════════════════════════════
// HELPER : Auto-création du lien admin au login (PB1-DEC-10 option A)
// ═════════════════════════════════════════════════════════════════════════════
//
// Appelé depuis handleMe() — vérifie si le prof connecté a des forfaits école
// achetés avec son email mais sans ligne profs_ecole_lien encore. Si oui,
// crée la liaison admin automatiquement.
//
// IMPORTANT : performance hot path. On limite à 10 forfaits max par appel
// (un prof ne devrait pas avoir plus de quelques forfaits) et on utilise
// une jointure pour ne créer que les manquantes.

export async function autoCreerLiensAdmin(env: Env, prof_id: string, prof_email: string): Promise<{ nb_crees: number }> {
  const emailNorm = prof_email.trim().toLowerCase()

  // Trouve les forfaits dont l'email_admin matche le prof mais sans lien existant
  const aLier = await env.DB.prepare(
    `SELECT f.id as forfait_id
     FROM forfaits_ecole f
     WHERE LOWER(f.email_admin) = ?
       AND NOT EXISTS (
         SELECT 1 FROM profs_ecole_lien pel
         WHERE pel.forfait_ecole_id = f.id AND pel.prof_id = ?
       )
     LIMIT 10`
  ).bind(emailNorm, prof_id).all<{ forfait_id: number }>()

  if (!aLier.results || aLier.results.length === 0) {
    return { nb_crees: 0 }
  }

  const now = Math.floor(Date.now() / 1000)
  const stmts = aLier.results.map(({ forfait_id }) =>
    env.DB.prepare(
      `INSERT INTO profs_ecole_lien (
        prof_id, forfait_ecole_id, role, statut,
        nb_qr_max, qr_cles_json,
        date_demande, date_validation, valide_par_prof_id
      ) VALUES (?, ?, 'admin', 'valide', 0, '[]', ?, ?, ?)`
    ).bind(prof_id, forfait_id, now, now, prof_id)
  )

  await env.DB.batch(stmts)
  return { nb_crees: aLier.results.length }
}

// ═════════════════════════════════════════════════════════════════════════════
// HELPER : Charger les liens du prof (utilisé par mon-ecole)
// ═════════════════════════════════════════════════════════════════════════════

interface LienForfait {
  forfait_id: number
  ecole_nom: string
  code_court: string
  commission_code: string
  role: 'admin' | 'membre'
  statut: 'en_attente' | 'valide' | 'revoque'
  nb_qr_max: number
  qr_cles_json: string
  date_demande: number
  date_validation: number | null
  nb_licences_total: number
  date_achat: number
}

async function chargerLiensProf(env: Env, prof_id: string): Promise<LienForfait[]> {
  const res = await env.DB.prepare(
    `SELECT
       pel.forfait_ecole_id as forfait_id,
       f.ecole_nom,
       f.code_court,
       f.commission_code,
       pel.role,
       pel.statut,
       pel.nb_qr_max,
       pel.qr_cles_json,
       pel.date_demande,
       pel.date_validation,
       f.nb_licences_total,
       f.date_achat
     FROM profs_ecole_lien pel
     JOIN forfaits_ecole f ON f.id = pel.forfait_ecole_id
     WHERE pel.prof_id = ?
     ORDER BY f.date_achat DESC`
  ).bind(prof_id).all<LienForfait>()
  return res.results ?? []
}

// ═════════════════════════════════════════════════════════════════════════════
// HELPER : Vérifier qu'un prof est admin d'un forfait donné
// ═════════════════════════════════════════════════════════════════════════════

async function estAdminDuForfait(env: Env, prof_id: string, forfait_id: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM profs_ecole_lien
     WHERE prof_id = ? AND forfait_ecole_id = ? AND role = 'admin' AND statut = 'valide'`
  ).bind(prof_id, forfait_id).first()
  return row !== null
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE : GET /api/prof/mon-ecole
// ═════════════════════════════════════════════════════════════════════════════
//
// Retourne :
//   - liste de tous les forfaits liés au prof connecté (en tant qu'admin OU membre)
//   - pour chaque forfait où le prof est admin : la liste des autres profs membres
//
// Query optionnelle : ?forfait_id=N pour filtrer sur un seul forfait

export async function handleProfMonEcole(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return jsonErr('Methode non autorisee', 405)

  const auth = await authentifier(request, env, true)
  if (auth instanceof Response) return auth
  const { prof } = auth

  // Toujours faire l'auto-création au cas où des forfaits récents seraient apparus
  await autoCreerLiensAdmin(env, prof.id, prof.email)

  const url = new URL(request.url)
  const forfaitIdFiltre = url.searchParams.get('forfait_id')

  let liens = await chargerLiensProf(env, prof.id)
  if (forfaitIdFiltre) {
    const id = parseInt(forfaitIdFiltre, 10)
    if (!Number.isInteger(id)) return jsonErr('forfait_id invalide', 400)
    liens = liens.filter(l => l.forfait_id === id)
  }

  // Pour chaque forfait où le prof est admin, charger la liste des membres
  const membresParForfait: Record<number, unknown[]> = {}
  const forfaitsAdmin = liens.filter(l => l.role === 'admin' && l.statut === 'valide')

  for (const f of forfaitsAdmin) {
    const membres = await env.DB.prepare(
      `SELECT
         pel.prof_id,
         p.email,
         p.nom_affiche,
         pel.role,
         pel.statut,
         pel.nb_qr_max,
         pel.qr_cles_json,
         pel.date_demande,
         pel.date_validation
       FROM profs_ecole_lien pel
       JOIN profs p ON p.id = pel.prof_id
       WHERE pel.forfait_ecole_id = ?
         AND pel.prof_id != ?
       ORDER BY pel.date_demande DESC`
    ).bind(f.forfait_id, prof.id).all<unknown>()
    membresParForfait[f.forfait_id] = membres.results ?? []
  }

  return jsonOk({
    ok: true,
    prof_id: prof.id,
    liens,
    membres_par_forfait: membresParForfait
  })
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/prof/mon-ecole/assigner-qr
// ═════════════════════════════════════════════════════════════════════════════
//
// L'admin assigne N clés QR de son forfait à un prof membre validé.
//
// Body :
//   {
//     forfait_ecole_id: number,
//     prof_membre_id: string,
//     cles_qr: string[]   // liste des clés à assigner
//   }
//
// Règles :
//   - L'appelant doit être admin valide du forfait
//   - Le prof membre cible doit être lié et statut='valide' sur ce même forfait
//   - Chaque clé QR doit appartenir au forfait, ne pas être révoquée, et ne pas être
//     déjà dans le qr_cles_json d'un autre prof
//   - Mise à jour atomique : on remplace le qr_cles_json du membre par l'union de
//     ses clés existantes + les nouvelles

interface AssignerQrBody {
  forfait_ecole_id?: number
  prof_membre_id?: string
  cles_qr?: string[]
}

const MAX_CLES_PAR_ASSIGNATION = 200  // ample marge, mais protection DoS

export async function handleProfAssignerQr(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return jsonErr('Methode non autorisee', 405)

  const auth = await authentifier(request, env, true)
  if (auth instanceof Response) return auth
  const { prof } = auth

  let body: AssignerQrBody
  try { body = await request.json() }
  catch { return jsonErr('JSON invalide', 400) }

  // Validation entrée
  if (!Number.isInteger(body.forfait_ecole_id) || (body.forfait_ecole_id as number) <= 0) {
    return jsonErr('forfait_ecole_id requis (entier positif)', 400, 'BAD_FORFAIT_ID')
  }
  if (typeof body.prof_membre_id !== 'string' || body.prof_membre_id.length === 0) {
    return jsonErr('prof_membre_id requis', 400, 'BAD_MEMBRE_ID')
  }
  if (!Array.isArray(body.cles_qr) || body.cles_qr.length === 0) {
    return jsonErr('cles_qr requis (tableau non vide)', 400, 'BAD_CLES')
  }
  if (body.cles_qr.length > MAX_CLES_PAR_ASSIGNATION) {
    return jsonErr(`Max ${MAX_CLES_PAR_ASSIGNATION} cles par assignation`, 400, 'TOO_MANY_CLES')
  }
  // Format Crockford Base32 12 chars
  const CLE_REGEX = /^[0-9A-HJKMNP-TV-Z]{12}$/
  for (const cle of body.cles_qr) {
    if (typeof cle !== 'string' || !CLE_REGEX.test(cle)) {
      return jsonErr(`Cle QR invalide : ${cle}`, 400, 'BAD_CLE_FORMAT')
    }
  }
  // Pas de doublons dans la requête
  const clesUniques = new Set(body.cles_qr)
  if (clesUniques.size !== body.cles_qr.length) {
    return jsonErr('Cles QR dupliquees dans la requete', 400, 'DUPLICATE_CLES')
  }

  const forfaitId = body.forfait_ecole_id as number
  const membreId = body.prof_membre_id

  // Vérifier que l'appelant est admin du forfait
  if (!(await estAdminDuForfait(env, prof.id, forfaitId))) {
    return jsonErr('Vous n\'etes pas administrateur de ce forfait', 403, 'NOT_ADMIN')
  }

  // Vérifier que le membre cible est lié et validé sur le même forfait
  const membre = await env.DB.prepare(
    `SELECT qr_cles_json, nb_qr_max FROM profs_ecole_lien
     WHERE prof_id = ? AND forfait_ecole_id = ? AND statut = 'valide' AND role = 'membre'`
  ).bind(membreId, forfaitId).first<{ qr_cles_json: string; nb_qr_max: number }>()

  if (!membre) {
    return jsonErr('Prof membre introuvable ou non valide sur ce forfait', 404, 'MEMBRE_GONE')
  }

  // Vérifier que chaque clé appartient bien au forfait, n'est pas révoquée,
  // et n'est pas déjà assignée à un autre prof
  const placeholders = body.cles_qr.map(() => '?').join(',')
  const clesVerif = await env.DB.prepare(
    `SELECT cle_qr, est_revoquee
     FROM licences_qr
     WHERE cle_qr IN (${placeholders}) AND forfait_ecole_id = ?`
  ).bind(...body.cles_qr, forfaitId).all<{ cle_qr: string; est_revoquee: number }>()

  if (!clesVerif.results || clesVerif.results.length !== body.cles_qr.length) {
    const trouvees = new Set(clesVerif.results?.map(r => r.cle_qr) ?? [])
    const manquantes = body.cles_qr.filter(c => !trouvees.has(c))
    return jsonErr(`Cles introuvables sur ce forfait : ${manquantes.slice(0, 5).join(', ')}`, 404, 'CLES_GONE')
  }

  const revoquees = clesVerif.results.filter(r => r.est_revoquee === 1).map(r => r.cle_qr)
  if (revoquees.length > 0) {
    return jsonErr(`Cles revoquees : ${revoquees.slice(0, 5).join(', ')}`, 409, 'CLES_REVOKED')
  }

  // Vérifier qu'aucune clé n'est déjà dans le qr_cles_json d'un autre prof
  const autresAssignations = await env.DB.prepare(
    `SELECT prof_id, qr_cles_json FROM profs_ecole_lien
     WHERE forfait_ecole_id = ? AND prof_id != ? AND statut = 'valide'`
  ).bind(forfaitId, membreId).all<{ prof_id: string; qr_cles_json: string }>()

  const dejaAssignees: string[] = []
  for (const ligne of autresAssignations.results ?? []) {
    try {
      const cles = JSON.parse(ligne.qr_cles_json) as string[]
      for (const c of cles) {
        if (clesUniques.has(c)) dejaAssignees.push(c)
      }
    } catch {
      // qr_cles_json corrompu, on ignore
    }
  }
  if (dejaAssignees.length > 0) {
    return jsonErr(`Cles deja assignees a un autre prof : ${dejaAssignees.slice(0, 5).join(', ')}`, 409, 'CLES_TAKEN')
  }

  // Calculer le nouveau qr_cles_json : union des existantes du membre + nouvelles
  let clesExistantes: string[] = []
  try {
    clesExistantes = JSON.parse(membre.qr_cles_json) as string[]
    if (!Array.isArray(clesExistantes)) clesExistantes = []
  } catch {
    clesExistantes = []
  }
  const nouveauTotal = Array.from(new Set([...clesExistantes, ...body.cles_qr]))
  const nouveauJson = JSON.stringify(nouveauTotal)
  const nouveauMax = Math.max(membre.nb_qr_max, nouveauTotal.length)

  await env.DB.prepare(
    `UPDATE profs_ecole_lien
     SET qr_cles_json = ?, nb_qr_max = ?
     WHERE prof_id = ? AND forfait_ecole_id = ?`
  ).bind(nouveauJson, nouveauMax, membreId, forfaitId).run()

  // Audit
  const meta = extraireMetadonneesRequete(request)
  await ecrireAudit(env, {
    prof_id: prof.id,
    action: 'admin_assigner_qr',
    cible: `forfait:${forfaitId};membre:${membreId}`,
    ip_pays: meta.ip_pays,
    user_agent: meta.user_agent,
    meta: { nb_assignees: body.cles_qr.length, nb_total_membre: nouveauTotal.length }
  })

  return jsonOk({
    ok: true,
    forfait_ecole_id: forfaitId,
    prof_membre_id: membreId,
    nb_cles_assignees: body.cles_qr.length,
    nb_cles_total_membre: nouveauTotal.length
  })
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/prof/me-lier-ecole  (item 11.2)
// ═════════════════════════════════════════════════════════════════════════════
//
// Un prof inscrit demande à être lié à une école (en tant que 'membre').
// Il fournit le code_court + email_admin → on crée une ligne 'en_attente'.
// L'admin verra cette demande dans son dashboard et pourra valider.
//
// Body :
//   {
//     code_court: string,        // ex 'vjolie'
//     commission_code: string,   // ex '01' (récupéré via autocomplete côté UI)
//     email_admin: string        // confirmation que le prof connait le bon admin
//   }

interface MeLierBody {
  code_court?: string
  commission_code?: string
  email_admin?: string
}

export async function handleProfMeLierEcole(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return jsonErr('Methode non autorisee', 405)

  const auth = await authentifier(request, env, true)
  if (auth instanceof Response) return auth
  const { prof } = auth

  let body: MeLierBody
  try { body = await request.json() }
  catch { return jsonErr('JSON invalide', 400) }

  if (typeof body.code_court !== 'string' || body.code_court.length < 3) {
    return jsonErr('code_court requis (3 chars min)', 400, 'BAD_CODE')
  }
  if (typeof body.commission_code !== 'string' || body.commission_code.length !== 2) {
    return jsonErr('commission_code requis (2 chars Crockford)', 400, 'BAD_COMMISSION')
  }
  if (typeof body.email_admin !== 'string' || !/.+@.+/.test(body.email_admin)) {
    return jsonErr('email_admin requis', 400, 'BAD_EMAIL')
  }

  const codeCourt = body.code_court.trim().toLowerCase()
  const commissionCode = body.commission_code.trim().toUpperCase()
  const emailAdminNorm = body.email_admin.trim().toLowerCase()

  // Si le prof tente de se lier à un forfait dont l'email_admin = son propre email,
  // l'auto-création aurait déjà créé un lien admin. On bloque pour éviter doublon.
  if (emailAdminNorm === prof.email.toLowerCase()) {
    return jsonErr(
      'Vous etes deja l\'admin de cette ecole (lien cree automatiquement). Verifiez votre dashboard.',
      409, 'ALREADY_ADMIN'
    )
  }

  // Trouver le forfait correspondant
  const forfait = await env.DB.prepare(
    `SELECT id, email_admin FROM forfaits_ecole
     WHERE code_court = ? AND commission_code = ?
     ORDER BY date_achat DESC
     LIMIT 1`
  ).bind(codeCourt, commissionCode).first<{ id: number; email_admin: string }>()

  if (!forfait) {
    return jsonErr('Forfait introuvable avec ces informations', 404, 'FORFAIT_GONE')
  }

  // Vérifier que l'email_admin saisi correspond bien à celui du forfait (preuve faible
  // mais suffisante : le prof doit connaître le bon admin pour saisir son email)
  if (forfait.email_admin.toLowerCase() !== emailAdminNorm) {
    // Réponse 404 (pas 403) pour ne pas révéler que le forfait existe
    return jsonErr('Forfait introuvable avec ces informations', 404, 'FORFAIT_GONE')
  }

  // Vérifier qu'il n'existe pas déjà une demande/lien actif sur ce forfait
  const existant = await env.DB.prepare(
    `SELECT statut FROM profs_ecole_lien
     WHERE prof_id = ? AND forfait_ecole_id = ?`
  ).bind(prof.id, forfait.id).first<{ statut: string }>()

  if (existant) {
    if (existant.statut === 'valide') {
      return jsonErr('Vous etes deja lie a cette ecole', 409, 'ALREADY_LINKED')
    }
    if (existant.statut === 'en_attente') {
      return jsonErr('Une demande est deja en attente pour cette ecole', 409, 'ALREADY_PENDING')
    }
    if (existant.statut === 'revoque') {
      return jsonErr('Votre acces a cette ecole a ete revoque par l\'administrateur. Contactez-le directement.', 403, 'REVOKED')
    }
  }

  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO profs_ecole_lien (
      prof_id, forfait_ecole_id, role, statut,
      nb_qr_max, qr_cles_json, date_demande
    ) VALUES (?, ?, 'membre', 'en_attente', 0, '[]', ?)`
  ).bind(prof.id, forfait.id, now).run()

  // Audit
  const meta = extraireMetadonneesRequete(request)
  await ecrireAudit(env, {
    prof_id: prof.id,
    action: 'membre_demande_liaison',
    cible: `forfait:${forfait.id}`,
    ip_pays: meta.ip_pays,
    user_agent: meta.user_agent,
    meta: { code_court: codeCourt, commission_code: commissionCode }
  })

  return jsonOk({
    ok: true,
    forfait_ecole_id: forfait.id,
    statut: 'en_attente',
    message: 'Demande envoyee. L\'administrateur de l\'ecole doit valider votre liaison.'
  }, 201)
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/prof/mon-ecole/valider-prof/:lien_prof_id  (item 11.2 suite)
// ═════════════════════════════════════════════════════════════════════════════
//
// L'admin valide (ou rejette) une demande 'en_attente' d'un prof membre.
//
// URL param : prof_id du membre demandeur (pas un id auto-increment car la PK
//             de profs_ecole_lien est composite (prof_id, forfait_ecole_id))
//
// Body :
//   {
//     forfait_ecole_id: number,
//     decision: 'valider' | 'rejeter',
//     raison?: string   // requis si rejeter
//   }

interface ValiderProfBody {
  forfait_ecole_id?: number
  decision?: 'valider' | 'rejeter'
  raison?: string
}

export async function handleProfValiderMembre(
  request: Request, env: Env, prof_membre_id: string
): Promise<Response> {
  if (request.method !== 'POST') return jsonErr('Methode non autorisee', 405)
  if (!prof_membre_id || prof_membre_id.length === 0) {
    return jsonErr('prof_membre_id manquant dans URL', 400, 'BAD_URL')
  }

  const auth = await authentifier(request, env, true)
  if (auth instanceof Response) return auth
  const { prof } = auth

  let body: ValiderProfBody
  try { body = await request.json() }
  catch { return jsonErr('JSON invalide', 400) }

  if (!Number.isInteger(body.forfait_ecole_id) || (body.forfait_ecole_id as number) <= 0) {
    return jsonErr('forfait_ecole_id requis', 400, 'BAD_FORFAIT')
  }
  if (body.decision !== 'valider' && body.decision !== 'rejeter') {
    return jsonErr('decision doit etre "valider" ou "rejeter"', 400, 'BAD_DECISION')
  }
  if (body.decision === 'rejeter' && (!body.raison || body.raison.trim().length === 0)) {
    return jsonErr('raison requise pour un rejet', 400, 'RAISON_REQUIRED')
  }

  const forfaitId = body.forfait_ecole_id as number

  // Vérifier que l'appelant est admin du forfait
  if (!(await estAdminDuForfait(env, prof.id, forfaitId))) {
    return jsonErr('Vous n\'etes pas administrateur de ce forfait', 403, 'NOT_ADMIN')
  }

  // Vérifier que la demande existe et est en_attente
  const demande = await env.DB.prepare(
    `SELECT role, statut FROM profs_ecole_lien
     WHERE prof_id = ? AND forfait_ecole_id = ?`
  ).bind(prof_membre_id, forfaitId).first<{ role: string; statut: string }>()

  if (!demande) {
    return jsonErr('Demande introuvable', 404, 'DEMANDE_GONE')
  }
  if (demande.role !== 'membre') {
    return jsonErr('On ne peut valider que des liens de type membre', 400, 'NOT_MEMBRE')
  }
  if (demande.statut !== 'en_attente') {
    return jsonErr(`Cette demande n'est plus en attente (statut actuel: ${demande.statut})`, 409, 'NOT_PENDING')
  }

  const now = Math.floor(Date.now() / 1000)

  if (body.decision === 'valider') {
    await env.DB.prepare(
      `UPDATE profs_ecole_lien
       SET statut = 'valide', date_validation = ?, valide_par_prof_id = ?
       WHERE prof_id = ? AND forfait_ecole_id = ?`
    ).bind(now, prof.id, prof_membre_id, forfaitId).run()
  } else {
    await env.DB.prepare(
      `UPDATE profs_ecole_lien
       SET statut = 'revoque', date_revocation = ?, raison_revocation = ?
       WHERE prof_id = ? AND forfait_ecole_id = ?`
    ).bind(now, body.raison ?? null, prof_membre_id, forfaitId).run()
  }

  // Audit
  const meta = extraireMetadonneesRequete(request)
  await ecrireAudit(env, {
    prof_id: prof.id,
    action: body.decision === 'valider' ? 'admin_valider_membre' : 'admin_rejeter_membre',
    cible: `forfait:${forfaitId};membre:${prof_membre_id}`,
    ip_pays: meta.ip_pays,
    user_agent: meta.user_agent,
    meta: body.decision === 'rejeter' ? { raison: body.raison } : {}
  })

  return jsonOk({
    ok: true,
    forfait_ecole_id: forfaitId,
    prof_membre_id,
    nouveau_statut: body.decision === 'valider' ? 'valide' : 'revoque'
  })
}
