/**
 * PB1 item 13.bis — Endpoint d'approbation manuelle de transfert QR par le prof.
 *
 * Permet à un enseignant de DÉBLOQUER un transfert refusé par la politique
 * automatique de l'item 13 (cas B `QUOTA_AUTO_DEPASSE` ou cas C
 * `VALIDATION_PROF_REQUISE`).
 *
 * Cas d'usage :
 *   - Un élève change de tablette en cours d'année (sa tablette de classe
 *     a planté, il en reçoit une nouvelle). Le QR a déjà été transféré 3 fois
 *     automatiquement → quota auto dépassé → le prof valide manuellement.
 *   - Un élève reçoit un QR au début de l'année, le perd, le retrouve 9 mois
 *     plus tard avec un nouvel appareil → > 6 mois → le prof valide.
 *
 * Endpoint :
 *
 *   POST /api/prof/approuver-transfert-qr
 *     Auth : JWT prof valide (Authorization: Bearer <token>)
 *     Body : {
 *       cle_qr: string,                     // 12 chars Crockford
 *       nouveau_device_fingerprint: string  // 8-128 chars
 *     }
 *     Action :
 *       1. Vérifie que le prof a la propriété du QR (admin du forfait OU
 *          membre avec cle_qr dans qr_cles_json)
 *       2. Révoque toutes les activations actives du QR (motif='transfer_prof')
 *       3. Insère une nouvelle activation sur le nouveau device
 *       4. Met à jour licences_qr : nouveau device + nb_transferts_prof++
 *     Réponse 200 :
 *       {
 *         ok: true,
 *         transfert: {
 *           type: 'prof',
 *           cle_qr: string,
 *           ancien_device_masque: string,
 *           nouveau_device_masque: string,
 *           nb_transferts_prof: number,
 *           nb_transferts_auto: number  // pour info, pas modifié ici
 *         }
 *       }
 *     Erreurs :
 *       400 BAD_JSON | BAD_CLE_QR | BAD_CLE_FORMAT | BAD_DEVICE
 *       401 (gérée par authentifier)
 *       403 NOT_OWNER
 *       404 CLE_NOT_FOUND
 *       409 MEME_DEVICE          (le device demandé est déjà l'actuel)
 *       409 PAS_ENCORE_ACTIVE    (QR n'a jamais été activé — pas un transfert)
 *       410 REVOKED              (QR désactivé par admin)
 *
 * Conventions :
 *   - 2 espaces (jamais tabs) — R-TABS du registre §4ter.7
 *   - Aucun PII en réponse, jamais (le device_fingerprint est masqué)
 *   - Format réponse : { ok: true, ... } ou { ok: false, code, message }
 *   - Pas de rate-limit spécifique côté router : le JWT prof + le rate-limit
 *     global du Worker suffisent (un prof n'approuvera pas 100 transferts/min)
 */

import type { Env } from './types'
import { authentifier } from './prof-routes'
import { ecrireAudit, extraireMetadonneesRequete, jsonOk, jsonErr } from './auth-prof'

const CLE_REGEX = /^[0-9A-HJKMNP-TV-Z]{12}$/

interface ApprouverTransfertBody {
  cle_qr?: string
  nouveau_device_fingerprint?: string
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/prof/approuver-transfert-qr
// ═════════════════════════════════════════════════════════════════════════════

export async function handleProfApprouverTransfertQr(
  request: Request, env: Env
): Promise<Response> {
  if (request.method !== 'POST') return jsonErr('Methode non autorisee', 405)

  // 1. Authentification prof
  const auth = await authentifier(request, env, true)
  if (auth instanceof Response) return auth
  const { prof } = auth

  // 2. Parse body
  let body: ApprouverTransfertBody
  try { body = await request.json() }
  catch { return jsonErr('JSON invalide', 400, 'BAD_JSON') }

  if (typeof body.cle_qr !== 'string') {
    return jsonErr('cle_qr requis', 400, 'BAD_CLE_QR')
  }
  const cleNorm = body.cle_qr.toUpperCase().replace(/-/g, '')
  if (!CLE_REGEX.test(cleNorm)) {
    return jsonErr('Format cle_qr invalide', 400, 'BAD_CLE_FORMAT')
  }
  if (
    typeof body.nouveau_device_fingerprint !== 'string' ||
    body.nouveau_device_fingerprint.length < 8 ||
    body.nouveau_device_fingerprint.length > 128
  ) {
    return jsonErr('nouveau_device_fingerprint requis (8-128 chars)', 400, 'BAD_DEVICE')
  }
  const nouveauDevice = body.nouveau_device_fingerprint

  // 3. Récupérer la licence_qr + son état
  const lqr = await env.DB.prepare(
    `SELECT cle_qr, forfait_ecole_id, classe_id, produit_id, est_revoquee,
            device_fingerprint, activation_initiale_date,
            nb_transferts_auto, nb_transferts_prof
       FROM licences_qr WHERE cle_qr = ?`
  ).bind(cleNorm).first<{
    cle_qr: string;
    forfait_ecole_id: number | null;
    classe_id: number | null;
    produit_id: string;
    est_revoquee: number;
    device_fingerprint: string | null;
    activation_initiale_date: number | null;
    nb_transferts_auto: number;
    nb_transferts_prof: number;
  }>()

  if (!lqr) return jsonErr('QR introuvable', 404, 'CLE_NOT_FOUND')

  if (lqr.est_revoquee === 1) {
    return jsonErr('QR desactive par admin', 410, 'REVOKED')
  }

  if (lqr.activation_initiale_date === null || lqr.device_fingerprint === null) {
    // Pas encore activé → ce n'est pas un transfert, l'élève doit juste activer normalement
    return jsonErr(
      'Ce QR n\'a jamais ete active. L\'eleve peut l\'activer normalement sans approbation.',
      409, 'PAS_ENCORE_ACTIVE'
    )
  }

  if (lqr.device_fingerprint === nouveauDevice) {
    return jsonErr(
      'Le device demande est deja l\'appareil actuel. Aucun transfert necessaire.',
      409, 'MEME_DEVICE'
    )
  }

  // 4. Vérifier la propriété du QR par ce prof.
  //    Modèle DEC-46/PB1 : le prof a accès au QR si :
  //      a) Il est admin du forfait_ecole_id du QR
  //      b) Il est membre du forfait ET le cle_qr est dans son qr_cles_json
  //
  //    Si le QR n'a pas de forfait_ecole_id (licence individuelle hors école),
  //    AUCUN prof ne peut l'approuver → l'élève doit utiliser /release-device
  //    (DEC-45) ou contacter le support.

  if (lqr.forfait_ecole_id === null) {
    return jsonErr(
      'Ce QR n\'appartient a aucun forfait ecole. Seul le proprietaire peut le transferer via /release-device ou en contactant le support.',
      403, 'NOT_FORFAIT_QR'
    )
  }

  // Lecture des liens prof ↔ forfait pour ce prof
  const liens = await env.DB.prepare(
    `SELECT role, qr_cles_json
       FROM profs_ecole_lien
      WHERE prof_id = ? AND forfait_ecole_id = ? AND statut = 'valide'`
  ).bind(prof.id, lqr.forfait_ecole_id).all<{
    role: string;
    qr_cles_json: string;
  }>()

  const liensArr = liens.results ?? []
  if (liensArr.length === 0) {
    return jsonErr('Vous n\'avez pas acces a ce QR (pas membre du forfait)', 403, 'NOT_OWNER')
  }

  // Si admin → accès à tous les QR du forfait. Sinon vérifier qr_cles_json.
  const estAdmin = liensArr.some(l => l.role === 'admin')
  let aLeQr = estAdmin
  if (!aLeQr) {
    for (const lien of liensArr) {
      try {
        const cles = JSON.parse(lien.qr_cles_json)
        if (Array.isArray(cles) && cles.includes(cleNorm)) {
          aLeQr = true
          break
        }
      } catch { /* qr_cles_json invalide, on ignore */ }
    }
  }

  if (!aLeQr) {
    return jsonErr(
      'Vous n\'etes pas autorise a transferer ce QR (pas dans vos QR attribues)',
      403, 'NOT_OWNER'
    )
  }

  // 5. Exécution du transfert (batch atomique D1)
  //    a) Révoquer toutes les activations actives du QR (devrait être 1 seule
  //       en pratique, mais on est défensif)
  //    b) Insérer une nouvelle activation sur le nouveau device. On ne lie
  //       PAS à profil_joueur_id (NULL) parce qu'on ne sait pas si l'élève
  //       en a un. S'il en a un, il pourra réclamer la licence via
  //       /api/jeu/profil-recuperer plus tard.
  //    c) Mettre à jour licences_qr : nouveau device + nb_transferts_prof++

  const now = Math.floor(Date.now() / 1000)

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE activations_appareil
          SET date_revocation = ?,
              motif_revocation = 'transfer_prof'
        WHERE cle_qr = ?
          AND date_revocation IS NULL`
    ).bind(now, cleNorm),
    env.DB.prepare(
      `INSERT INTO activations_appareil
         (cle_qr, device_fingerprint, profil_joueur_id, produit_id,
          date_activation, date_revocation, motif_revocation)
       VALUES (?, ?, NULL, ?, ?, NULL, NULL)`
    ).bind(cleNorm, nouveauDevice, lqr.produit_id, now),
    env.DB.prepare(
      `UPDATE licences_qr
          SET device_fingerprint = ?,
              derniere_activation_date = ?,
              nb_transferts_prof = nb_transferts_prof + 1
        WHERE cle_qr = ?
          AND nb_transferts_prof = ?` // garde-fou anti-race
    ).bind(nouveauDevice, now, cleNorm, lqr.nb_transferts_prof)
  ])

  // 6. Audit (Loi 25 / DEC-44 traçabilité prof)
  //    Aucune donnée nominative — on log juste prof_id + cle_qr + delta compteur.
  const meta = extraireMetadonneesRequete(request)
  await ecrireAudit(env, {
    prof_id: prof.id,
    action: 'transfert_qr_approuve',
    cible: `licences_qr:${cleNorm}`,
    ip_pays: meta.ip_pays,
    user_agent: meta.user_agent,
    meta: {
      forfait_ecole_id: lqr.forfait_ecole_id,
      classe_id: lqr.classe_id,
      produit_id: lqr.produit_id,
      ancien_device_masque: maskDevice(lqr.device_fingerprint),
      nouveau_device_masque: maskDevice(nouveauDevice),
      nb_transferts_auto: lqr.nb_transferts_auto,
      nb_transferts_prof_avant: lqr.nb_transferts_prof,
      nb_transferts_prof_apres: lqr.nb_transferts_prof + 1
    }
  })

  // 7. Réponse
  return jsonOk({
    ok: true,
    transfert: {
      type: 'prof',
      cle_qr: cleNorm,
      ancien_device_masque: maskDevice(lqr.device_fingerprint),
      nouveau_device_masque: maskDevice(nouveauDevice),
      nb_transferts_prof: lqr.nb_transferts_prof + 1,
      nb_transferts_auto: lqr.nb_transferts_auto
    }
  })
}

/** Masque un device_fingerprint pour les logs/réponses (préserve la privacy). */
function maskDevice(fp: string | null): string {
  if (!fp) return '(null)'
  if (fp.length <= 6) return fp
  return fp.slice(0, 6) + '...'
}
