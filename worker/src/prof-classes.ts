/**
 * Sprint PB1 — Item 11.3 (créer / lister / archiver classes)
 *
 * Endpoints exposés (cf. registre v4.3 §4ter.8) :
 *
 *   POST   /api/prof/classes              → crée une classe pour le prof connecté
 *   GET    /api/prof/classes              → liste les classes du prof (actives par défaut)
 *   POST   /api/prof/classes/:id/archiver → archive (soft delete) une classe du prof
 *
 * Items 11.4 (attribuer-qr) et 11.5 (mes-qr) seront ajoutés ensuite dans ce
 * même fichier.
 *
 * Conventions (registre v4.3 §4ter.7) :
 *   - 2 espaces (jamais tabs)
 *   - Réutilise authentifier() de prof-routes.ts et ecrireAudit() de auth-prof.ts
 *   - Audit log obligatoire sur toute mutation
 *   - PB1-DEC-12 : code_classe = `Prenom-Groupe-Annee-<6chars Crockford aleatoire>`
 *     Prénom conserve sa capitalisation (sans accents NFD), groupe alphanumérique.
 *
 * Sécurité :
 *   - require2fa = true (cohérent avec eleves-routes.ts)
 *   - Toute requête vérifie que la classe appartient au prof connecté (prof_id = sub)
 *   - Si forfait_ecole_id fourni, on NE valide PAS encore la liaison avec
 *     profs_ecole_lien (PB1 item 11.0 livre la table, items 11.1-11.2 livreront
 *     la liaison effective). En 11.3, forfait_ecole_id reste NULL pour le
 *     "prof solo" — c'est ok, la colonne est nullable (migration 0010).
 */

import type { Env } from './types'
import { authentifier } from './prof-routes'
import { ecrireAudit, extraireMetadonneesRequete, jsonOk, jsonErr } from './auth-prof'

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS — Normalisation & génération code_classe (PB1-DEC-12)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Alphabet Crockford Base32 — sans I, L, O, U pour éviter les confusions.
 * Source : https://www.crockford.com/base32.html (idem qr-gen.ts).
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * Génère 6 caractères Crockford via crypto.getRandomValues + rejet anti-biais.
 * Pattern identique à qr-gen.ts (registre §4ter.7).
 */
function genererSuffixeCrockford6(): string {
  const out: string[] = []
  while (out.length < 6) {
    const buf = new Uint8Array(8)
    crypto.getRandomValues(buf)
    for (let i = 0; i < buf.length && out.length < 6; i++) {
      const b = buf[i]
      // Rejet anti-biais : on accepte 0..223 (256 - (256 % 32))
      if (b < 224) {
        out.push(CROCKFORD[b % 32])
      }
    }
  }
  return out.join('')
}

/**
 * Nettoie une composante du code classe :
 *   - retire les accents (NFD + suppression des diacritiques U+0300-036F)
 *   - garde [A-Za-z0-9] uniquement
 *   - longueur max 32 (sécurité contre payloads géants)
 * Conserve la capitalisation (PB1-DEC-12 : "Prenom" garde sa majuscule).
 */
function normaliserComposante(s: string): string {
  if (typeof s !== 'string') return ''
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 32)
}

/**
 * Construit le code_classe complet :
 *   `Prenom-Groupe-Annee-XXXXXX`
 * Exemple : `Nadia-3A-2026-K7P2RM`
 */
function construireCodeClasse(prenom: string, groupe: string, annee: number): string {
  const p = normaliserComposante(prenom)
  const g = normaliserComposante(groupe)
  const suffixe = genererSuffixeCrockford6()
  return `${p}-${g}-${annee}-${suffixe}`
}

// ═════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═════════════════════════════════════════════════════════════════════════════

const PRENOM_MIN = 1
const PRENOM_MAX = 32
const GROUPE_MIN = 1
const GROUPE_MAX = 16
const ANNEE_MIN = 2024
const ANNEE_MAX = 2050
const NOM_AFFICHE_MAX = 128
const MAX_TENTATIVES_UNICITE = 5

interface ClasseCreerBody {
  prenom?: string
  groupe?: string
  annee_scolaire?: number
  nom_affiche?: string | null
  forfait_ecole_id?: number | null
}

function validerCreerBody(body: ClasseCreerBody): { ok: true; data: Required<Omit<ClasseCreerBody, 'forfait_ecole_id' | 'nom_affiche'>> & { nom_affiche: string | null; forfait_ecole_id: number | null } } | { ok: false; raison: string } {
  if (typeof body.prenom !== 'string') return { ok: false, raison: 'prenom requis (texte)' }
  const prenomNorm = normaliserComposante(body.prenom)
  if (prenomNorm.length < PRENOM_MIN) {
    return { ok: false, raison: 'prenom doit contenir au moins 1 caractere alphanumerique' }
  }

  if (typeof body.groupe !== 'string') return { ok: false, raison: 'groupe requis (texte)' }
  const groupeNorm = normaliserComposante(body.groupe)
  if (groupeNorm.length < GROUPE_MIN || groupeNorm.length > GROUPE_MAX) {
    return { ok: false, raison: `groupe doit contenir entre ${GROUPE_MIN} et ${GROUPE_MAX} caracteres alphanumeriques` }
  }

  if (typeof body.annee_scolaire !== 'number' || !Number.isInteger(body.annee_scolaire)) {
    return { ok: false, raison: 'annee_scolaire requise (entier)' }
  }
  if (body.annee_scolaire < ANNEE_MIN || body.annee_scolaire > ANNEE_MAX) {
    return { ok: false, raison: `annee_scolaire doit etre entre ${ANNEE_MIN} et ${ANNEE_MAX}` }
  }

  let nom_affiche: string | null = null
  if (body.nom_affiche !== undefined && body.nom_affiche !== null) {
    if (typeof body.nom_affiche !== 'string') return { ok: false, raison: 'nom_affiche doit etre texte ou null' }
    const trim = body.nom_affiche.trim()
    if (trim.length === 0) {
      nom_affiche = null
    } else if (trim.length > NOM_AFFICHE_MAX) {
      return { ok: false, raison: `nom_affiche max ${NOM_AFFICHE_MAX} caracteres` }
    } else {
      nom_affiche = trim
    }
  }

  let forfait_ecole_id: number | null = null
  if (body.forfait_ecole_id !== undefined && body.forfait_ecole_id !== null) {
    if (typeof body.forfait_ecole_id !== 'number' || !Number.isInteger(body.forfait_ecole_id) || body.forfait_ecole_id <= 0) {
      return { ok: false, raison: 'forfait_ecole_id doit etre un entier positif ou null' }
    }
    forfait_ecole_id = body.forfait_ecole_id
  }

  return {
    ok: true,
    data: { prenom: body.prenom, groupe: body.groupe, annee_scolaire: body.annee_scolaire, nom_affiche, forfait_ecole_id }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/prof/classes
// ═════════════════════════════════════════════════════════════════════════════

export async function handleProfClasseCreer(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return jsonErr('Methode non autorisee', 405)

  const auth = await authentifier(request, env, true)
  if (auth instanceof Response) return auth
  const { prof } = auth

  let body: ClasseCreerBody
  try { body = await request.json() }
  catch { return jsonErr('JSON invalide', 400) }

  const valid = validerCreerBody(body)
  if (!valid.ok) return jsonErr(valid.raison, 400, 'BAD_INPUT')

  const { prenom, groupe, annee_scolaire, nom_affiche, forfait_ecole_id } = valid.data

  // Si forfait_ecole_id fourni : vérification minimale d'existence.
  // La vérif d'autorisation prof <-> forfait sera ajoutée en item 11.2
  // (profs_ecole_lien) — en 11.3, on n'autorise QUE NULL ou un forfait dont
  // l'email_admin est celui du prof connecté (cas prof solo qui a acheté).
  if (forfait_ecole_id !== null) {
    const forfait = await env.DB.prepare(
      'SELECT email_admin FROM forfaits_ecole WHERE id = ?'
    ).bind(forfait_ecole_id).first<{ email_admin: string }>()
    if (!forfait) return jsonErr('forfait_ecole_id introuvable', 404, 'FORFAIT_GONE')
    if (forfait.email_admin.toLowerCase() !== prof.email.toLowerCase()) {
      // Pas encore lié via profs_ecole_lien : on refuse en 11.3.
      // Item 11.2 ouvrira ce flux pour les profs membres.
      return jsonErr('Vous n\'etes pas administrateur de ce forfait ecole', 403, 'NOT_ADMIN_FORFAIT')
    }
  }

  // Génération code_classe avec retry sur collision UNIQUE
  const now = Math.floor(Date.now() / 1000)
  let codeClasse = ''
  let classeId: number | null = null

  for (let tentative = 0; tentative < MAX_TENTATIVES_UNICITE; tentative++) {
    codeClasse = construireCodeClasse(prenom, groupe, annee_scolaire)
    try {
      // INSERT puis SELECT par UNIQUE code_classe (pattern cohérent avec
      // webhook-school.ts qui utilise stripe_session_id pour récupérer l'ID).
      // D1 supporte RETURNING mais le code existant n'en dépend pas — on garde
      // la même approche.
      await env.DB.prepare(
        `INSERT INTO classes (
          code_classe, prof_id, forfait_ecole_id, nom_affiche,
          annee_scolaire, date_creation, est_archivee
        ) VALUES (?, ?, ?, ?, ?, ?, 0)`
      ).bind(codeClasse, prof.id, forfait_ecole_id, nom_affiche, annee_scolaire, now)
        .run()
      const ligne = await env.DB.prepare(
        'SELECT id FROM classes WHERE code_classe = ?'
      ).bind(codeClasse).first<{ id: number }>()
      if (!ligne) {
        console.error('[prof-classes] classe introuvable apres INSERT', codeClasse)
        return jsonErr('Erreur interne creation classe', 500, 'POST_INSERT_LOOKUP_FAIL')
      }
      classeId = ligne.id
      break
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('UNIQUE') && msg.includes('code_classe')) {
        // Collision rarissime (32^6 = ~1 milliard) — on retente.
        continue
      }
      throw err
    }
  }

  if (classeId === null) {
    return jsonErr('Impossible de generer un code_classe unique apres plusieurs tentatives', 500, 'UNIQUE_RETRY_EXHAUSTED')
  }

  // Audit Loi 25
  const meta = extraireMetadonneesRequete(request)
  await ecrireAudit(env, {
    prof_id: prof.id,
    action: 'classe_creer',
    cible: String(classeId),
    ip_pays: meta.ip_pays,
    user_agent: meta.user_agent,
    meta: { code_classe: codeClasse, annee_scolaire, forfait_ecole_id }
  })

  return jsonOk({ ok: true, id: classeId, code_classe: codeClasse, date_creation: now }, 201)
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE : GET /api/prof/classes
// ═════════════════════════════════════════════════════════════════════════════

interface ClasseListItem {
  id: number
  code_classe: string
  forfait_ecole_id: number | null
  nom_affiche: string | null
  annee_scolaire: number
  date_creation: number
  est_archivee: number
}

export async function handleProfClasseLister(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return jsonErr('Methode non autorisee', 405)

  const auth = await authentifier(request, env, true)
  if (auth instanceof Response) return auth
  const { prof } = auth

  const url = new URL(request.url)
  const inclureArchivees = url.searchParams.get('inclure_archivees') === '1'

  const sql = inclureArchivees
    ? `SELECT id, code_classe, forfait_ecole_id, nom_affiche, annee_scolaire, date_creation, est_archivee
       FROM classes
       WHERE prof_id = ?
       ORDER BY est_archivee ASC, date_creation DESC`
    : `SELECT id, code_classe, forfait_ecole_id, nom_affiche, annee_scolaire, date_creation, est_archivee
       FROM classes
       WHERE prof_id = ? AND est_archivee = 0
       ORDER BY date_creation DESC`

  const res = await env.DB.prepare(sql).bind(prof.id).all<ClasseListItem>()
  return jsonOk({ ok: true, classes: res.results ?? [] })
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/prof/classes/:id/archiver
// ═════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/prof/classes/:id/attribuer-qr  (item 11.4 PB1)
// ══════════════════════════════════════════════════════════════════════════════
//
// Le prof attribue N clés QR de ses QR assignés (via assigner-qr côté admin)
// à une classe spécifique. Cela déclenche aussi la magie pré-remplissage
// côté élève (DEC-56 / info-qr).
//
// Règles :
//   - Le prof doit être propriétaire de la classe
//   - Chaque cle_qr doit être dans le `qr_cles_json` du `profs_ecole_lien`
//     où ce prof est valide sur le forfait correspondant
//     OU le prof est admin du forfait (auto-accès)
//   - Chaque cle_qr ne doit pas être déjà attribuée à une autre classe
//     (sauf si reset_classe=true dans le body pour forçage)
//
// Body :
//   { cles_qr: string[], reset_classe?: boolean }

interface AttribuerQrClasseBody {
  cles_qr?: string[]
  reset_classe?: boolean
}

const MAX_CLES_PAR_ATTRIBUTION = 50  // une classe typique = 20-35 élèves

export async function handleProfClasseAttribuerQr(
  request: Request, env: Env, classeId: number
): Promise<Response> {
  if (request.method !== 'POST') return jsonErr('Methode non autorisee', 405)
  if (!Number.isInteger(classeId) || classeId <= 0) {
    return jsonErr('id classe invalide', 400, 'BAD_ID')
  }

  const auth = await authentifier(request, env, true)
  if (auth instanceof Response) return auth
  const { prof } = auth

  // Vérifier propriété
  const classe = await env.DB.prepare(
    'SELECT prof_id, est_archivee, code_classe, forfait_ecole_id FROM classes WHERE id = ?'
  ).bind(classeId).first<{
    prof_id: string;
    est_archivee: number;
    code_classe: string;
    forfait_ecole_id: number | null
  }>()
  if (!classe) return jsonErr('Classe introuvable', 404, 'CLASSE_GONE')
  if (classe.prof_id !== prof.id) return jsonErr('Non autorise', 403, 'NOT_OWNER')
  if (classe.est_archivee === 1) return jsonErr('Classe archivee', 409, 'CLASSE_ARCHIVED')

  let body: AttribuerQrClasseBody
  try { body = await request.json() }
  catch { return jsonErr('JSON invalide', 400) }

  if (!Array.isArray(body.cles_qr) || body.cles_qr.length === 0) {
    return jsonErr('cles_qr requis (tableau non vide)', 400, 'BAD_CLES')
  }
  if (body.cles_qr.length > MAX_CLES_PAR_ATTRIBUTION) {
    return jsonErr(`Max ${MAX_CLES_PAR_ATTRIBUTION} cles par attribution`, 400, 'TOO_MANY')
  }

  const CLE_REGEX_LOCAL = /^[0-9A-HJKMNP-TV-Z]{12}$/
  const clesNormalisees: string[] = []
  for (const c of body.cles_qr) {
    if (typeof c !== 'string') return jsonErr(`Cle invalide : ${c}`, 400, 'BAD_CLE')
    const norm = c.toUpperCase().replace(/-/g, '')
    if (!CLE_REGEX_LOCAL.test(norm)) {
      return jsonErr(`Format cle invalide : ${c}`, 400, 'BAD_CLE_FORMAT')
    }
    clesNormalisees.push(norm)
  }

  const clesUniques = Array.from(new Set(clesNormalisees))
  if (clesUniques.length !== clesNormalisees.length) {
    return jsonErr('Cles dupliquees dans la requete', 400, 'DUPLICATE_CLES')
  }

  // Vérifier que chaque cle existe et récupérer son forfait + classe_id actuelle
  const placeholders = clesUniques.map(() => '?').join(',')
  const clesVerif = await env.DB.prepare(
    `SELECT cle_qr, forfait_ecole_id, classe_id, est_revoquee
     FROM licences_qr
     WHERE cle_qr IN (${placeholders})`
  ).bind(...clesUniques).all<{
    cle_qr: string;
    forfait_ecole_id: number | null;
    classe_id: number | null;
    est_revoquee: number
  }>()

  if (!clesVerif.results || clesVerif.results.length !== clesUniques.length) {
    const trouvees = new Set(clesVerif.results?.map(r => r.cle_qr) ?? [])
    const manquantes = clesUniques.filter(c => !trouvees.has(c))
    return jsonErr(`Cles introuvables : ${manquantes.slice(0, 5).join(', ')}`, 404, 'CLES_GONE')
  }

  const revoquees = clesVerif.results.filter(r => r.est_revoquee === 1).map(r => r.cle_qr)
  if (revoquees.length > 0) {
    return jsonErr(`Cles revoquees : ${revoquees.slice(0, 5).join(', ')}`, 409, 'CLES_REVOKED')
  }

  // Vérifier que chaque cle appartient à un forfait dont le prof a l'accès
  // (soit via assignment dans profs_ecole_lien, soit en tant qu'admin du forfait)
  const forfaitIds = Array.from(new Set(
    clesVerif.results.map(r => r.forfait_ecole_id).filter((v): v is number => v !== null)
  ))

  if (forfaitIds.length === 0) {
    return jsonErr('Cles QR sans forfait associe (licences individuelles non supportees ici)', 400, 'NO_FORFAIT')
  }

  // Récupérer les liens du prof sur ces forfaits
  const forfaitsPlaceholders = forfaitIds.map(() => '?').join(',')
  const liens = await env.DB.prepare(
    `SELECT forfait_ecole_id, role, qr_cles_json
     FROM profs_ecole_lien
     WHERE prof_id = ? AND forfait_ecole_id IN (${forfaitsPlaceholders}) AND statut = 'valide'`
  ).bind(prof.id, ...forfaitIds).all<{
    forfait_ecole_id: number;
    role: 'admin' | 'membre';
    qr_cles_json: string
  }>()

  const accesParForfait = new Map<number, { role: string; cles: Set<string> }>()
  for (const lien of liens.results ?? []) {
    let cles: string[] = []
    try {
      const parsed = JSON.parse(lien.qr_cles_json)
      if (Array.isArray(parsed)) cles = parsed
    } catch { /* ignore */ }
    accesParForfait.set(lien.forfait_ecole_id, {
      role: lien.role,
      cles: new Set(cles)
    })
  }

  // Vérifier l'autorisation pour chaque cle
  for (const c of clesVerif.results) {
    if (c.forfait_ecole_id === null) continue
    const acces = accesParForfait.get(c.forfait_ecole_id)
    if (!acces) {
      return jsonErr(
        `Aucun acces au forfait ${c.forfait_ecole_id} pour la cle ${c.cle_qr}`,
        403, 'NO_FORFAIT_ACCESS'
      )
    }
    // Admin = accès à toutes les cles du forfait. Membre = seulement celles dans son qr_cles_json.
    if (acces.role === 'membre' && !acces.cles.has(c.cle_qr)) {
      return jsonErr(
        `Cle ${c.cle_qr} non assignee a ce prof. Demandez à l'admin de l'école de vous l'assigner.`,
        403, 'CLE_NOT_ASSIGNED'
      )
    }
  }

  // Vérifier que les cles ne sont pas déjà dans une autre classe (sauf reset_classe=true)
  if (!body.reset_classe) {
    const dejaAttribuees = clesVerif.results
      .filter(r => r.classe_id !== null && r.classe_id !== classeId)
      .map(r => r.cle_qr)
    if (dejaAttribuees.length > 0) {
      return jsonErr(
        `Cles deja attribuees a une autre classe : ${dejaAttribuees.slice(0, 5).join(', ')}. ` +
        `Utilisez reset_classe=true pour forcer.`,
        409, 'CLES_IN_OTHER_CLASS'
      )
    }
  }

  // UPDATE batch : attribuer toutes les cles à la classe
  const now = Math.floor(Date.now() / 1000)
  const stmts = clesUniques.map(cle =>
    env.DB.prepare(
      `UPDATE licences_qr
       SET classe_id = ?,
           attribution_prof_email = ?,
           date_attribution = ?
       WHERE cle_qr = ?`
    ).bind(classeId, prof.email, now, cle)
  )
  await env.DB.batch(stmts)

  // Audit
  const meta = extraireMetadonneesRequete(request)
  await ecrireAudit(env, {
    prof_id: prof.id,
    action: 'classe_attribuer_qr',
    cible: `classe:${classeId}`,
    ip_pays: meta.ip_pays,
    user_agent: meta.user_agent,
    meta: {
      code_classe: classe.code_classe,
      nb_cles: clesUniques.length,
      reset_classe: body.reset_classe ?? false,
      premieres_cles: clesUniques.slice(0, 3)
    }
  })

  return jsonOk({
    ok: true,
    classe_id: classeId,
    nb_cles_attribuees: clesUniques.length,
    code_classe: classe.code_classe
  })
}

export async function handleProfClasseArchiver(
  request: Request, env: Env, classeId: number
): Promise<Response> {
  if (request.method !== 'POST') return jsonErr('Methode non autorisee', 405)
  if (!Number.isInteger(classeId) || classeId <= 0) {
    return jsonErr('id classe invalide', 400, 'BAD_ID')
  }

  const auth = await authentifier(request, env, true)
  if (auth instanceof Response) return auth
  const { prof } = auth

  // Vérification propriété + état actuel
  const classe = await env.DB.prepare(
    'SELECT prof_id, est_archivee, code_classe FROM classes WHERE id = ?'
  ).bind(classeId).first<{ prof_id: string; est_archivee: number; code_classe: string }>()

  if (!classe) return jsonErr('Classe introuvable', 404, 'CLASSE_GONE')
  if (classe.prof_id !== prof.id) return jsonErr('Non autorise', 403, 'NOT_OWNER')
  if (classe.est_archivee === 1) {
    return jsonOk({ ok: true, deja_archivee: true, id: classeId })
  }

  await env.DB.prepare(
    'UPDATE classes SET est_archivee = 1 WHERE id = ? AND prof_id = ?'
  ).bind(classeId, prof.id).run()

  // Audit Loi 25
  const meta = extraireMetadonneesRequete(request)
  await ecrireAudit(env, {
    prof_id: prof.id,
    action: 'classe_archiver',
    cible: String(classeId),
    ip_pays: meta.ip_pays,
    user_agent: meta.user_agent,
    meta: { code_classe: classe.code_classe }
  })

  return jsonOk({ ok: true, id: classeId, est_archivee: 1 })
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTE : GET /api/prof/mes-qr  (item 11.5 PB1)
// ══════════════════════════════════════════════════════════════════════════════
//
// Liste les QR auxquels le prof a accès, avec leur état actuel :
//   - assigned_but_unused : QR assigné au prof mais non attribué à une classe
//   - in_class : QR attribué à une classe (peut être activé ou non)
//   - active : QR activé par un élève (eleve_pseudo non NULL)
//
// Query optionnelle : ?classe_id=N pour filtrer sur une classe
//                     ?match_statut=auto|conflit|non_associe pour filtrer

interface MesQrLigne {
  cle_qr: string
  forfait_ecole_id: number | null
  classe_id: number | null
  code_classe: string | null
  eleve_pseudo: string | null
  match_statut: string
  est_revoquee: number
  date_attribution: number | null
  derniere_activation_date: number | null
  eleve_pre_cree_id: number | null
}

export async function handleProfMesQr(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return jsonErr('Methode non autorisee', 405)

  const auth = await authentifier(request, env, true)
  if (auth instanceof Response) return auth
  const { prof } = auth

  const url = new URL(request.url)
  const classeFiltre = url.searchParams.get('classe_id')
  const statutFiltre = url.searchParams.get('match_statut')

  // Récupérer les forfaits auxquels le prof a accès
  const liens = await env.DB.prepare(
    `SELECT forfait_ecole_id, role, qr_cles_json
     FROM profs_ecole_lien
     WHERE prof_id = ? AND statut = 'valide'`
  ).bind(prof.id).all<{ forfait_ecole_id: number; role: string; qr_cles_json: string }>()

  const liensArr = liens.results ?? []
  if (liensArr.length === 0) {
    return jsonOk({ ok: true, qr: [], total: 0 })
  }

  // Pour chaque forfait :
  //   - si admin : toutes les cles du forfait
  //   - si membre : seulement celles dans qr_cles_json
  // On construit une liste union de toutes les cles à récupérer.

  const clesAdmin: number[] = []   // forfaits où le prof est admin
  const clesMembre: string[] = []  // cles explicitement assignées au prof

  for (const lien of liensArr) {
    if (lien.role === 'admin') {
      clesAdmin.push(lien.forfait_ecole_id)
    } else {
      try {
        const parsed = JSON.parse(lien.qr_cles_json)
        if (Array.isArray(parsed)) clesMembre.push(...parsed)
      } catch { /* ignore */ }
    }
  }

  // Build SQL : (forfait_ecole_id IN admin) OR (cle_qr IN membre)
  const whereParts: string[] = []
  const params: (string | number)[] = []

  if (clesAdmin.length > 0) {
    whereParts.push(`forfait_ecole_id IN (${clesAdmin.map(() => '?').join(',')})`)
    params.push(...clesAdmin)
  }
  if (clesMembre.length > 0) {
    whereParts.push(`cle_qr IN (${clesMembre.map(() => '?').join(',')})`)
    params.push(...clesMembre)
  }

  if (whereParts.length === 0) {
    return jsonOk({ ok: true, qr: [], total: 0 })
  }

  let sql = `
    SELECT
      lq.cle_qr,
      lq.forfait_ecole_id,
      lq.classe_id,
      c.code_classe,
      lq.eleve_pseudo,
      lq.match_statut,
      lq.est_revoquee,
      lq.date_attribution,
      lq.derniere_activation_date,
      lq.eleve_pre_cree_id
    FROM licences_qr lq
    LEFT JOIN classes c ON c.id = lq.classe_id
    WHERE (${whereParts.join(' OR ')})
  `

  if (classeFiltre) {
    const cid = parseInt(classeFiltre, 10)
    if (Number.isInteger(cid)) {
      sql += ' AND lq.classe_id = ?'
      params.push(cid)
    }
  }
  if (statutFiltre && ['non_active', 'auto', 'conflit', 'non_associe'].includes(statutFiltre)) {
    sql += ' AND lq.match_statut = ?'
    params.push(statutFiltre)
  }

  sql += ' ORDER BY lq.date_attribution DESC NULLS LAST, lq.cle_qr ASC LIMIT 500'

  const res = await env.DB.prepare(sql).bind(...params).all<MesQrLigne>()
  const qrList = res.results ?? []

  return jsonOk({
    ok: true,
    qr: qrList,
    total: qrList.length,
    filtres: {
      classe_id: classeFiltre ? parseInt(classeFiltre, 10) : null,
      match_statut: statutFiltre
    }
  })
}
