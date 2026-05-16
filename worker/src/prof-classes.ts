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
