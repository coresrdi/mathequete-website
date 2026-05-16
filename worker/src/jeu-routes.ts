/**
 * Sprint IMPORT-ELEVES — Items IE-3bis (info-qr) — futurs IE-3 (saisie-code-classe)
 *
 * Endpoints exposés côté JEU GODOT (pas auth prof Tauri) :
 *
 *   GET /api/jeu/info-qr/:cle_qr   → magie pré-remplissage code classe (DEC-56)
 *
 * Endpoints futurs à ajouter dans ce fichier :
 *   POST /api/jeu/saisie-code-classe → matching DEC-57 (item IE-3)
 *   POST /api/jeu/activer-qr         → activation initiale (item 12 PB1)
 *
 * Conventions :
 *   - 2 espaces (jamais tabs)
 *   - PUBLIC : pas de JWT, mais rate-limité par IP (RL_INFO_QR via index.ts)
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
