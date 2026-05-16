/**
 * Endpoints admin pour gestion des PDFs de forfaits école — Sprint PB1 (D8).
 *
 * Authentification : header `X-Admin-Token` comparé constant-time à
 * `env.ADMIN_API_TOKEN` (secret Wrangler).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEUX USAGES DE LA RÉGÉNÉRATION (D8) :
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  A. MODE "auto" — `POST /api/admin/forfaits/{id}/regenerer-pdf`
 *     Body : { mode: "auto" }
 *     → Le Worker recharge les N clés QR depuis `licences_qr` et exécute
 *       `genererPdfForfait()` en ligne. À utiliser :
 *         - Si le `ctx.waitUntil()` initial a échoué (statut='en_attente').
 *         - Pour des forfaits ≤ 100 dont on veut rafraîchir le lien signé.
 *     ⚠️  Au-delà de ~150 QR la génération peut excéder le CPU budget Worker
 *         Paid (50 ms par requête, mais waitUntil donne plus de marge).
 *         Pour les très gros forfaits → mode "upload".
 *
 *  B. MODE "upload" — `PUT /api/admin/forfaits/{id}/pdf`
 *     Body : binary application/pdf
 *     → Tu génères le PDF sur ton CPU local (script Node), tu le pousses
 *       directement vers R2 via cet endpoint. Le statut passe à 'genere',
 *       un email est envoyé à l'admin avec le nouveau lien signé.
 *
 *  C. INFO — `GET /api/admin/forfaits/{id}`
 *     → Retourne l'état complet du forfait + lien signé frais si déjà généré.
 *       Pratique pour le dashboard admin maison.
 *
 * Tous les endpoints écrivent dans `prof_audit_log` pour traçabilité.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Env } from './types';
import { genererPdfForfait, type InfosForfaitPdf } from './pdf-gen';
import { PRIX_TIERS_CENTS } from './types';
import {
  cheminR2Pdf,
  uploaderPdfR2,
  genererJetonPdf,
  urlTelechargementPdf
} from './r2-upload';
import { envoyerEmail } from './email';

/** Vérifie le header X-Admin-Token en comparaison constant-time. */
export async function verifierAdminToken(
  request: Request, env: Env
): Promise<boolean> {
  const fourni = request.headers.get('x-admin-token');
  if (!fourni || !env.ADMIN_API_TOKEN) return false;
  if (fourni.length !== env.ADMIN_API_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < fourni.length; i++) {
    diff |= fourni.charCodeAt(i) ^ env.ADMIN_API_TOKEN.charCodeAt(i);
  }
  return diff === 0;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Modèles de données
 * ───────────────────────────────────────────────────────────────────────── */

interface LigneForfait {
  id: number;
  stripe_session_id: string;
  licence_id_hmac: string;
  commission_code: string;
  ecole_nom: string;
  code_court: string;
  produit_id: string;
  tier: string;
  nb_licences_total: number;
  email_admin: string;
  nom_admin: string | null;
  date_achat: number;
  pdf_r2_path: string | null;
  pdf_genere_date: number | null;
  pdf_statut: string;
}

async function chargerForfait(env: Env, id: number): Promise<LigneForfait | null> {
  const ligne = await env.DB.prepare(`
    SELECT id, stripe_session_id, licence_id_hmac, commission_code, ecole_nom,
           code_court, produit_id, tier, nb_licences_total, email_admin, nom_admin,
           date_achat, pdf_r2_path, pdf_genere_date, pdf_statut
    FROM forfaits_ecole WHERE id = ?
  `).bind(id).first<LigneForfait>();
  return ligne ?? null;
}

async function chargerClesQrTriees(env: Env, forfaitId: number): Promise<string[]> {
  const res = await env.DB.prepare(`
    SELECT cle_qr FROM licences_qr
    WHERE forfait_ecole_id = ?
    ORDER BY numero_sequence ASC
  `).bind(forfaitId).all<{ cle_qr: string }>();
  return (res.results ?? []).map(r => r.cle_qr);
}

async function ecrireAudit(
  env: Env, action: string, forfaitId: number, details: Record<string, unknown>,
  request?: Request
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  // Note : schéma prof_audit_log (migration 0005) = (prof_id, action, cible,
  // ip_pays, user_agent, meta_json, at). On enrichit meta_json avec details.
  const ipPays = request?.headers.get('cf-ipcountry') ?? null;
  const userAgent = request?.headers.get('user-agent') ?? null;
  const metaJson = JSON.stringify({ ...details, cible_type: 'forfait_ecole' });
  try {
    await env.DB.prepare(`
      INSERT INTO prof_audit_log
        (prof_id, action, cible, ip_pays, user_agent, meta_json, at)
      VALUES (NULL, ?, ?, ?, ?, ?, ?)
    `).bind(action, String(forfaitId), ipPays, userAgent, metaJson, now).run();
  } catch (err) {
    // Audit best-effort : on log mais on ne casse pas l'endpoint.
    console.error('[admin-forfaits] echec audit log :', err);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Handler principal — POST /api/admin/forfaits/{id}/regenerer-pdf
 * ───────────────────────────────────────────────────────────────────────── */

export async function handleAdminRegenererPdf(
  request: Request, env: Env, ctx: ExecutionContext, forfaitId: number
): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonErr('Méthode non autorisée', 405);
  }
  if (!(await verifierAdminToken(request, env))) {
    return jsonErr('Token admin invalide', 401);
  }

  let body: { mode?: 'auto'; notifier_admin?: boolean };
  try { body = await request.json(); } catch { body = {}; }
  const mode = body.mode ?? 'auto';
  const notifier = body.notifier_admin !== false; // défaut true

  if (mode !== 'auto') {
    return jsonErr('mode doit etre "auto" (upload manuel via PUT /pdf)', 400);
  }

  const forfait = await chargerForfait(env, forfaitId);
  if (!forfait) return jsonErr('Forfait introuvable', 404);

  const cles = await chargerClesQrTriees(env, forfaitId);
  if (cles.length !== forfait.nb_licences_total) {
    return jsonErr(
      `Incoherence : ${cles.length} cles_qr en DB vs ${forfait.nb_licences_total} attendues`,
      500
    );
  }

  // Lance la regen en background pour pouvoir repondre vite, meme si > 100 QR.
  ctx.waitUntil(regenererEtNotifier(env, forfait, cles, notifier));

  await ecrireAudit(env, 'regenerer_pdf_auto', forfaitId, {
    nb_cles: cles.length, notifier_admin: notifier
  }, request);

  return jsonOk({
    ok: true,
    forfait_id: forfaitId,
    mode: 'auto',
    nb_cles_qr: cles.length,
    statut_anterieur: forfait.pdf_statut,
    message: 'Regeneration lancee en arriere-plan. Consulter GET /api/admin/forfaits/{id} dans 30-60s.'
  });
}

async function regenererEtNotifier(
  env: Env, forfait: LigneForfait, cles: string[], notifier: boolean
): Promise<void> {
  try {
    const tarif = PRIX_TIERS_CENTS[forfait.tier];
    const infos: InfosForfaitPdf = {
      ecole_nom: forfait.ecole_nom,
      code_court: forfait.code_court,
      tier_nom: tarif?.nom ?? forfait.tier,
      produit_nom: 'Continent 1',
      nb_licences: forfait.nb_licences_total,
      email_admin: forfait.email_admin,
      date_achat: forfait.date_achat
    };
    const pdfBytes = await genererPdfForfait(infos, cles);
    const chemin = cheminR2Pdf(forfait.id, forfait.date_achat);
    await uploaderPdfR2(env, chemin, pdfBytes, {
      forfait_id: forfait.id,
      ecole_nom: forfait.ecole_nom,
      code_court: forfait.code_court
    });

    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`
      UPDATE forfaits_ecole
      SET pdf_r2_path = ?, pdf_genere_date = ?, pdf_statut = 'genere'
      WHERE id = ?
    `).bind(chemin, now, forfait.id).run();

    if (notifier) {
      const jeton = await genererJetonPdf(env, forfait.id);
      const urlPdf = urlTelechargementPdf(env, forfait.id, jeton);
      await envoyerEmailLienFrais(env, forfait, urlPdf);
    }
    console.log(`[admin regen] forfait ${forfait.id} OK -> ${chemin}`);
  } catch (err) {
    console.error('[admin regen] echec', forfait.id, err);
    await ecrireAudit(env, 'regenerer_pdf_echec', forfait.id, {
      erreur: String(err)
    });
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Handler upload manuel — PUT /api/admin/forfaits/{id}/pdf
 * Tu génères le PDF sur ton CPU local, tu le pousses ici directement.
 * ───────────────────────────────────────────────────────────────────────── */

const TAILLE_MAX_PDF_OCTETS = 50 * 1024 * 1024; // 50 MB — large marge pour 1300 QR

export async function handleAdminUploadPdf(
  request: Request, env: Env, ctx: ExecutionContext, forfaitId: number
): Promise<Response> {
  if (request.method !== 'PUT') {
    return jsonErr('Méthode non autorisée (PUT requis)', 405);
  }
  if (!(await verifierAdminToken(request, env))) {
    return jsonErr('Token admin invalide', 401);
  }

  const ct = request.headers.get('content-type') ?? '';
  if (!ct.includes('application/pdf')) {
    return jsonErr('Content-Type doit etre application/pdf', 400);
  }

  const forfait = await chargerForfait(env, forfaitId);
  if (!forfait) return jsonErr('Forfait introuvable', 404);

  // Lit le body avec garde de taille
  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return jsonErr('Corps vide', 400);
  if (buf.byteLength > TAILLE_MAX_PDF_OCTETS) {
    return jsonErr(`PDF trop volumineux (${buf.byteLength} > ${TAILLE_MAX_PDF_OCTETS} octets)`, 413);
  }
  const pdfBytes = new Uint8Array(buf);

  // Garde : vérifie en-tête PDF magique (%PDF-)
  if (pdfBytes.length < 5
      || pdfBytes[0] !== 0x25 || pdfBytes[1] !== 0x50
      || pdfBytes[2] !== 0x44 || pdfBytes[3] !== 0x46
      || pdfBytes[4] !== 0x2D) {
    return jsonErr('Fichier non reconnu comme PDF (magique %PDF- manquant)', 400);
  }

  const chemin = cheminR2Pdf(forfait.id, forfait.date_achat);
  await uploaderPdfR2(env, chemin, pdfBytes, {
    forfait_id: forfait.id,
    ecole_nom: forfait.ecole_nom,
    code_court: forfait.code_court
  });

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`
    UPDATE forfaits_ecole
    SET pdf_r2_path = ?, pdf_genere_date = ?, pdf_statut = 'genere'
    WHERE id = ?
  `).bind(chemin, now, forfait.id).run();

  await ecrireAudit(env, 'upload_pdf_manuel', forfait.id, {
    octets: pdfBytes.length, chemin_r2: chemin
  }, request);

  // Option : envoie l'email avec lien frais
  const url = new URL(request.url);
  const skipEmail = url.searchParams.get('notifier') === '0';
  let urlPdfRetour: string | null = null;
  if (!skipEmail) {
    const jeton = await genererJetonPdf(env, forfait.id);
    const urlPdf = urlTelechargementPdf(env, forfait.id, jeton);
    urlPdfRetour = urlPdf;
    ctx.waitUntil(envoyerEmailLienFrais(env, forfait, urlPdf));
  }

  return jsonOk({
    ok: true,
    forfait_id: forfaitId,
    chemin_r2: chemin,
    octets: pdfBytes.length,
    pdf_statut: 'genere',
    email_envoye: !skipEmail,
    url_pdf: urlPdfRetour
  });
}

/* ─────────────────────────────────────────────────────────────────────────
 * Handler GET — état complet d'un forfait
 * ───────────────────────────────────────────────────────────────────────── */

export async function handleAdminGetForfait(
  request: Request, env: Env, forfaitId: number
): Promise<Response> {
  if (request.method !== 'GET') return jsonErr('Méthode non autorisée', 405);
  if (!(await verifierAdminToken(request, env))) {
    return jsonErr('Token admin invalide', 401);
  }
  const forfait = await chargerForfait(env, forfaitId);
  if (!forfait) return jsonErr('Forfait introuvable', 404);

  // Compteurs licences_qr : combien attribuees / activees ?
  const stats = await env.DB.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN classe_id IS NOT NULL THEN 1 ELSE 0 END) AS attribuees,
      SUM(CASE WHEN activation_initiale_date IS NOT NULL THEN 1 ELSE 0 END) AS activees,
      SUM(CASE WHEN est_revoquee = 1 THEN 1 ELSE 0 END) AS revoquees
    FROM licences_qr WHERE forfait_ecole_id = ?
  `).bind(forfaitId).first<{ total: number; attribuees: number; activees: number; revoquees: number }>();

  // Lien signé frais si PDF présent
  let url_pdf: string | null = null;
  let jeton_expire_le: number | null = null;
  if (forfait.pdf_r2_path && forfait.pdf_statut === 'genere') {
    const jeton = await genererJetonPdf(env, forfait.id);
    url_pdf = urlTelechargementPdf(env, forfait.id, jeton);
    jeton_expire_le = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  }

  return jsonOk({
    forfait: {
      ...forfait,
      tier_nom: PRIX_TIERS_CENTS[forfait.tier]?.nom ?? forfait.tier
    },
    cles_qr: stats ?? { total: 0, attribuees: 0, activees: 0, revoquees: 0 },
    url_pdf,
    jeton_expire_le
  });
}

/* ─────────────────────────────────────────────────────────────────────────
 * Email "nouveau lien"
 * ───────────────────────────────────────────────────────────────────────── */

async function envoyerEmailLienFrais(
  env: Env, forfait: LigneForfait, urlPdf: string
): Promise<void> {
  const tarif = PRIX_TIERS_CENTS[forfait.tier];
  const tierNom = tarif?.nom ?? forfait.tier;
  const nomAdmin = forfait.nom_admin ? ' ' + escapeHtml(forfait.nom_admin) : '';
  const sujet = `📥 Nouveau lien PDF — Mathéquête ${escapeHtml(forfait.ecole_nom)}`;
  const html = `<!DOCTYPE html>
<html lang="fr"><body style="font-family:system-ui,Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222;">
<h2 style="color:#0a6;">Votre PDF de codes Mathéquête est prêt</h2>
<p>Bonjour${nomAdmin},</p>
<p>Voici le lien de téléchargement du PDF de votre forfait
<strong>${escapeHtml(tierNom)}</strong> (${forfait.nb_licences_total} codes QR) pour
<strong>${escapeHtml(forfait.ecole_nom)}</strong> :</p>
<p style="text-align:center;margin:30px 0;">
  <a href="${urlPdf}" style="background:#0a6;color:#fff;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;">📥 Télécharger le PDF</a>
</p>
<p style="font-size:13px;color:#666;">⚠️ Lien valide <strong>30 jours</strong>. Téléchargez-le et conservez le PDF en lieu sûr.</p>
<p style="font-size:12px;color:#999;border-top:1px solid #ddd;padding-top:12px;margin-top:24px;">
Mathéquête · CORES RDI · coresrdi@gmail.com — forfait #${forfait.id}
</p></body></html>`;

  const resp = await envoyerEmail(env, {
    destinataire: forfait.email_admin,
    sujet, html
  });

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`
    INSERT INTO emails_envoyes
      (destinataire, sujet, type, licence_id, envoye_le, resend_id, statut, erreur)
    VALUES (?, ?, 'forfait_ecole_lien_frais', NULL, ?, ?, ?, ?)
  `).bind(
    forfait.email_admin, sujet, now,
    resp.id ?? null,
    resp.error ? 'failed' : 'sent',
    resp.error ? resp.error.message : null
  ).run();
}

/* ─────────────────────────────────────────────────────────────────────────
 * Petits helpers
 * ───────────────────────────────────────────────────────────────────────── */

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
function jsonErr(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]!));
}
