/**
 * Sprint IMPORT-ELEVES — Items IE-2 (import) + IE-4 (resolution conflit)
 *
 * Endpoints exposés (cf. registre v4.6 §4quater.1) :
 *
 *   POST   /api/prof/classes/:id/eleves/import     → batch import d'entrées élèves
 *                                                    chiffrées E2E (par classe)
 *   GET    /api/prof/classes/:id/eleves            → lister entrées pré-créées
 *   POST   /api/prof/classes/:id/resoudre-conflit  → résoudre un licences_qr en
 *                                                    'conflit' vers une entrée
 *
 * Politique de ré-import (Bloc 3 question Jeff) : **MERGE par empreinte hash composée**
 *   - Empreinte = SHA-256 de `prenom_hash | nom_hash | niveau_hash | code_court_hash`
 *     (avec '|' littéral, NULL devenant chaîne vide)
 *   - Si une entrée avec même empreinte existe (et est_archive=0), on la garde
 *     et on ignore la ligne d'import. Sinon on INSERT.
 *   - Pas d'archivage automatique : si le prof veut supprimer un élève, endpoint dédié.
 *
 * Conventions (registre v4.6 §4ter.7) :
 *   - 2 espaces (jamais tabs)
 *   - require2fa = true
 *   - Réutilise authentifier() + ecrireAudit() + autoCreerLiensAdmin
 *   - Audit log obligatoire sur toute mutation
 */

import type { Env } from './types'
import { authentifier } from './prof-routes'
import { ecrireAudit, extraireMetadonneesRequete, jsonOk, jsonErr } from './auth-prof'

// ═════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═════════════════════════════════════════════════════════════════════════════

const HASH_REGEX = /^[0-9a-f]{64}$/        // SHA-256 hex = 64 chars
const B64_REGEX = /^[A-Za-z0-9+/=]+$/

const MAX_ELEVES_PAR_IMPORT = 100          // une classe typique = 20-35 élèves
const MAX_CIPHERTEXT_B64 = 2048             // 1.5 KB de prénom chiffré = très large
const MAX_IV_B64 = 64

interface EleveImportEntry {
  prenom_chiffre?: string         // base64 BLOB chiffré (requis)
  prenom_iv?: string              // base64 IV (requis)
  prenom_hash?: string            // SHA-256 hex (requis pour matching)
  nom_chiffre?: string | null
  nom_iv?: string | null
  nom_hash?: string | null
  niveau_chiffre?: string | null
  niveau_iv?: string | null
  niveau_hash?: string | null
  code_court_chiffre?: string | null
  code_court_iv?: string | null
  code_court_hash?: string | null
}

interface EleveImportBody {
  eleves?: EleveImportEntry[]
}

function validerB64(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null
  if (value.length === 0 || value.length > maxLen) return null
  if (!B64_REGEX.test(value)) return null
  return value
}

function validerHash(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (!HASH_REGEX.test(value)) return null
  return value
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

// Empreinte composée pour Merge (Bloc 3 question Jeff)
function calculerEmpreinte(e: {
  prenom_hash: string
  nom_hash: string | null
  niveau_hash: string | null
  code_court_hash: string | null
}): string {
  return `${e.prenom_hash}|${e.nom_hash ?? ''}|${e.niveau_hash ?? ''}|${e.code_court_hash ?? ''}`
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/prof/classes/:id/eleves/import  (item IE-2)
// ═════════════════════════════════════════════════════════════════════════════

export async function handleProfClasseElevesImport(
  request: Request, env: Env, classeId: number
): Promise<Response> {
  if (request.method !== 'POST') return jsonErr('Methode non autorisee', 405)
  if (!Number.isInteger(classeId) || classeId <= 0) {
    return jsonErr('id classe invalide', 400, 'BAD_ID')
  }

  const auth = await authentifier(request, env, true)
  if (auth instanceof Response) return auth
  const { prof } = auth

  // Vérifier propriété de la classe
  const classe = await env.DB.prepare(
    'SELECT prof_id, est_archivee, code_classe FROM classes WHERE id = ?'
  ).bind(classeId).first<{ prof_id: string; est_archivee: number; code_classe: string }>()
  if (!classe) return jsonErr('Classe introuvable', 404, 'CLASSE_GONE')
  if (classe.prof_id !== prof.id) return jsonErr('Non autorise', 403, 'NOT_OWNER')
  if (classe.est_archivee === 1) {
    return jsonErr('Classe archivee, impossible d\'importer', 409, 'CLASSE_ARCHIVED')
  }

  let body: EleveImportBody
  try { body = await request.json() }
  catch { return jsonErr('JSON invalide', 400) }

  if (!Array.isArray(body.eleves) || body.eleves.length === 0) {
    return jsonErr('Liste eleves requise (tableau non vide)', 400, 'BAD_LIST')
  }
  if (body.eleves.length > MAX_ELEVES_PAR_IMPORT) {
    return jsonErr(`Max ${MAX_ELEVES_PAR_IMPORT} eleves par import`, 400, 'TOO_MANY')
  }

  // Validation par ligne
  const validees: Array<{
    prenom_chiffre: string; prenom_iv: string; prenom_hash: string
    nom_chiffre: string | null; nom_iv: string | null; nom_hash: string | null
    niveau_chiffre: string | null; niveau_iv: string | null; niveau_hash: string | null
    code_court_chiffre: string | null; code_court_iv: string | null; code_court_hash: string | null
    empreinte: string
    ordre: number
  }> = []

  for (let i = 0; i < body.eleves.length; i++) {
    const e = body.eleves[i]
    const prenom_chiffre = validerB64(e.prenom_chiffre, MAX_CIPHERTEXT_B64)
    const prenom_iv = validerB64(e.prenom_iv, MAX_IV_B64)
    const prenom_hash = validerHash(e.prenom_hash)
    if (!prenom_chiffre || !prenom_iv || !prenom_hash) {
      return jsonErr(`Ligne ${i + 1}: prenom_chiffre + prenom_iv + prenom_hash requis (b64 + b64 + sha256 hex)`, 400, 'BAD_PRENOM')
    }

    // Champs optionnels : si l'un des 3 (chiffre/iv/hash) est présent, les 3 doivent l'être
    function trioOptionnel(label: string, c?: string|null, iv?: string|null, h?: string|null): { c: string|null; iv: string|null; h: string|null } | string {
      const hasAny = c || iv || h
      if (!hasAny) return { c: null, iv: null, h: null }
      const cV = validerB64(c, MAX_CIPHERTEXT_B64)
      const ivV = validerB64(iv, MAX_IV_B64)
      const hV = validerHash(h)
      if (!cV || !ivV || !hV) return `Ligne ${i + 1}: si ${label}_* fourni, ${label}_chiffre + ${label}_iv + ${label}_hash doivent etre presents et valides`
      return { c: cV, iv: ivV, h: hV }
    }

    const nomRes = trioOptionnel('nom', e.nom_chiffre, e.nom_iv, e.nom_hash)
    if (typeof nomRes === 'string') return jsonErr(nomRes, 400, 'BAD_NOM')
    const niveauRes = trioOptionnel('niveau', e.niveau_chiffre, e.niveau_iv, e.niveau_hash)
    if (typeof niveauRes === 'string') return jsonErr(niveauRes, 400, 'BAD_NIVEAU')
    const codeRes = trioOptionnel('code_court', e.code_court_chiffre, e.code_court_iv, e.code_court_hash)
    if (typeof codeRes === 'string') return jsonErr(codeRes, 400, 'BAD_CODE_COURT')

    const empreinte = calculerEmpreinte({
      prenom_hash,
      nom_hash: nomRes.h,
      niveau_hash: niveauRes.h,
      code_court_hash: codeRes.h
    })

    validees.push({
      prenom_chiffre, prenom_iv, prenom_hash,
      nom_chiffre: nomRes.c, nom_iv: nomRes.iv, nom_hash: nomRes.h,
      niveau_chiffre: niveauRes.c, niveau_iv: niveauRes.iv, niveau_hash: niveauRes.h,
      code_court_chiffre: codeRes.c, code_court_iv: codeRes.iv, code_court_hash: codeRes.h,
      empreinte,
      ordre: i + 1
    })
  }

  // Charger les empreintes existantes pour cette classe (entrées non archivées)
  const existantes = await env.DB.prepare(
    `SELECT
       id,
       prenom_hash,
       nom_hash,
       niveau_hash,
       code_court_hash
     FROM eleves_pre_crees
     WHERE classe_id = ? AND est_archive = 0`
  ).bind(classeId).all<{
    id: number; prenom_hash: string; nom_hash: string|null; niveau_hash: string|null; code_court_hash: string|null
  }>()

  const empreintesExistantes = new Set(
    (existantes.results ?? []).map(r => calculerEmpreinte(r))
  )

  // Filtrer les nouvelles vs déjà présentes
  const aInserer = validees.filter(v => !empreintesExistantes.has(v.empreinte))
  const dejaPresentes = validees.length - aInserer.length

  if (aInserer.length === 0) {
    return jsonOk({
      ok: true,
      classe_id: classeId,
      nb_inserees: 0,
      nb_deja_presentes: dejaPresentes,
      message: 'Aucune nouvelle entree (toutes deja presentes par empreinte)'
    })
  }

  // INSERT batch
  const now = Math.floor(Date.now() / 1000)
  const stmts = aInserer.map(v => env.DB.prepare(
    `INSERT INTO eleves_pre_crees (
      classe_id, prof_id,
      prenom_chiffre, prenom_iv, prenom_hash,
      nom_chiffre, nom_iv, nom_hash,
      niveau_chiffre, niveau_iv, niveau_hash,
      code_court_chiffre, code_court_iv, code_court_hash,
      ordre_dans_import, date_import
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    classeId, prof.id,
    base64ToUint8Array(v.prenom_chiffre), base64ToUint8Array(v.prenom_iv), v.prenom_hash,
    v.nom_chiffre ? base64ToUint8Array(v.nom_chiffre) : null,
    v.nom_iv ? base64ToUint8Array(v.nom_iv) : null,
    v.nom_hash,
    v.niveau_chiffre ? base64ToUint8Array(v.niveau_chiffre) : null,
    v.niveau_iv ? base64ToUint8Array(v.niveau_iv) : null,
    v.niveau_hash,
    v.code_court_chiffre ? base64ToUint8Array(v.code_court_chiffre) : null,
    v.code_court_iv ? base64ToUint8Array(v.code_court_iv) : null,
    v.code_court_hash,
    v.ordre, now
  ))

  await env.DB.batch(stmts)

  const meta = extraireMetadonneesRequete(request)
  await ecrireAudit(env, {
    prof_id: prof.id,
    action: 'eleves_pre_crees_import',
    cible: `classe:${classeId}`,
    ip_pays: meta.ip_pays,
    user_agent: meta.user_agent,
    meta: {
      code_classe: classe.code_classe,
      nb_inserees: aInserer.length,
      nb_deja_presentes: dejaPresentes
    }
  })

  return jsonOk({
    ok: true,
    classe_id: classeId,
    nb_inserees: aInserer.length,
    nb_deja_presentes: dejaPresentes,
    politique: 'merge_par_empreinte'
  }, 201)
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE : GET /api/prof/classes/:id/eleves  (lecture liste pré-créée)
// ═════════════════════════════════════════════════════════════════════════════

export async function handleProfClasseElevesLister(
  request: Request, env: Env, classeId: number
): Promise<Response> {
  if (request.method !== 'GET') return jsonErr('Methode non autorisee', 405)
  if (!Number.isInteger(classeId) || classeId <= 0) {
    return jsonErr('id classe invalide', 400, 'BAD_ID')
  }

  const auth = await authentifier(request, env, true)
  if (auth instanceof Response) return auth
  const { prof } = auth

  const classe = await env.DB.prepare(
    'SELECT prof_id FROM classes WHERE id = ?'
  ).bind(classeId).first<{ prof_id: string }>()
  if (!classe) return jsonErr('Classe introuvable', 404, 'CLASSE_GONE')
  if (classe.prof_id !== prof.id) return jsonErr('Non autorise', 403, 'NOT_OWNER')

  const res = await env.DB.prepare(
    `SELECT
       id, ordre_dans_import, date_import, est_archive,
       prenom_chiffre, prenom_iv, prenom_hash,
       nom_chiffre, nom_iv, nom_hash,
       niveau_chiffre, niveau_iv, niveau_hash,
       code_court_chiffre, code_court_iv, code_court_hash
     FROM eleves_pre_crees
     WHERE classe_id = ?
     ORDER BY est_archive ASC, ordre_dans_import ASC`
  ).bind(classeId).all<Record<string, unknown>>()

  // Convertir les BLOB en base64 pour le wire
  const fromBlob = (v: unknown): string | null => {
    if (v == null) return null
    if (v instanceof ArrayBuffer) {
      return btoa(String.fromCharCode(...new Uint8Array(v)))
    }
    if (v instanceof Uint8Array) {
      return btoa(String.fromCharCode(...v))
    }
    return null
  }

  const eleves = (res.results ?? []).map((row) => ({
    id: row.id,
    ordre_dans_import: row.ordre_dans_import,
    date_import: row.date_import,
    est_archive: row.est_archive,
    prenom_chiffre: fromBlob(row.prenom_chiffre),
    prenom_iv: fromBlob(row.prenom_iv),
    prenom_hash: row.prenom_hash,
    nom_chiffre: fromBlob(row.nom_chiffre),
    nom_iv: fromBlob(row.nom_iv),
    nom_hash: row.nom_hash,
    niveau_chiffre: fromBlob(row.niveau_chiffre),
    niveau_iv: fromBlob(row.niveau_iv),
    niveau_hash: row.niveau_hash,
    code_court_chiffre: fromBlob(row.code_court_chiffre),
    code_court_iv: fromBlob(row.code_court_iv),
    code_court_hash: row.code_court_hash
  }))

  return jsonOk({ ok: true, classe_id: classeId, eleves })
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/prof/classes/:id/resoudre-conflit  (item IE-4)
// ═════════════════════════════════════════════════════════════════════════════
//
// Le prof résout manuellement un licences_qr en match_statut='conflit' ou
// 'non_associe' en l'assignant à une entrée eleves_pre_crees précise.
//
// Body :
//   {
//     cle_qr: string,                  // QR activé en conflit
//     eleve_pre_cree_id: number | null // null = créer entrée hors liste
//                                       // (mais alors champs eleve_pseudo requis)
//   }

interface ResolverBody {
  cle_qr?: string
  eleve_pre_cree_id?: number | null
}

export async function handleProfClasseResoudreConflit(
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
    'SELECT prof_id FROM classes WHERE id = ?'
  ).bind(classeId).first<{ prof_id: string }>()
  if (!classe) return jsonErr('Classe introuvable', 404, 'CLASSE_GONE')
  if (classe.prof_id !== prof.id) return jsonErr('Non autorise', 403, 'NOT_OWNER')

  let body: ResolverBody
  try { body = await request.json() }
  catch { return jsonErr('JSON invalide', 400) }

  if (typeof body.cle_qr !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{12}$/.test(body.cle_qr.toUpperCase().replace(/-/g, ''))) {
    return jsonErr('cle_qr requise (Crockford 12 chars)', 400, 'BAD_CLE')
  }
  const cleNorm = body.cle_qr.toUpperCase().replace(/-/g, '')

  if (body.eleve_pre_cree_id !== null && body.eleve_pre_cree_id !== undefined) {
    if (!Number.isInteger(body.eleve_pre_cree_id) || body.eleve_pre_cree_id <= 0) {
      return jsonErr('eleve_pre_cree_id doit etre entier positif ou null', 400, 'BAD_PRE_CREE_ID')
    }
  }

  // Vérifier que la cle_qr appartient à la classe du prof
  const lqr = await env.DB.prepare(
    `SELECT classe_id, match_statut FROM licences_qr WHERE cle_qr = ?`
  ).bind(cleNorm).first<{ classe_id: number | null; match_statut: string }>()

  if (!lqr) return jsonErr('cle_qr introuvable', 404, 'CLE_GONE')
  if (lqr.classe_id !== classeId) {
    return jsonErr('cle_qr ne fait pas partie de cette classe', 403, 'WRONG_CLASSE')
  }

  // Si on assigne à une entrée pré-créée, vérifier qu'elle existe et appartient à la classe
  if (body.eleve_pre_cree_id) {
    const entree = await env.DB.prepare(
      `SELECT classe_id, est_archive FROM eleves_pre_crees WHERE id = ?`
    ).bind(body.eleve_pre_cree_id).first<{ classe_id: number; est_archive: number }>()
    if (!entree) return jsonErr('eleve_pre_cree_id introuvable', 404, 'PRE_CREE_GONE')
    if (entree.classe_id !== classeId) return jsonErr('Entree pre-creee dans une autre classe', 403, 'WRONG_CLASSE_PRE')
    if (entree.est_archive === 1) return jsonErr('Entree pre-creee archivee', 409, 'PRE_CREE_ARCHIVED')
  }

  // Update
  const nouveauStatut = body.eleve_pre_cree_id ? 'auto' : 'non_associe'
  await env.DB.prepare(
    `UPDATE licences_qr
     SET eleve_pre_cree_id = ?, match_statut = ?
     WHERE cle_qr = ?`
  ).bind(body.eleve_pre_cree_id ?? null, nouveauStatut, cleNorm).run()

  const meta = extraireMetadonneesRequete(request)
  await ecrireAudit(env, {
    prof_id: prof.id,
    action: 'resoudre_conflit_qr',
    cible: `classe:${classeId};cle:${cleNorm}`,
    ip_pays: meta.ip_pays,
    user_agent: meta.user_agent,
    meta: {
      ancien_statut: lqr.match_statut,
      nouveau_statut: nouveauStatut,
      eleve_pre_cree_id: body.eleve_pre_cree_id ?? null
    }
  })

  return jsonOk({
    ok: true,
    cle_qr: cleNorm,
    match_statut: nouveauStatut,
    eleve_pre_cree_id: body.eleve_pre_cree_id ?? null
  })
}
