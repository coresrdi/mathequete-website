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
Mathéquête · CORES RDI · support@mathequete.com — forfait #${forfait.id}
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

/* ──────────────────────────────────────────────────────────────────────────
 * GET /api/admin/forfaits/en-attente
 * File d'attente : forfaits dont le PDF doit être généré manuellement (>100 QR)
 * OU dont la génération auto a échoué. Tri par date d'achat ASC (oldest first).
 * ────────────────────────────────────────────────────────────────────────── */

export async function handleAdminListerEnAttente(
  request: Request, env: Env
): Promise<Response> {
  if (request.method !== 'GET') return jsonErr('Méthode non autorisée', 405);
  if (!(await verifierAdminToken(request, env))) {
    return jsonErr('Token admin invalide', 401);
  }
  const res = await env.DB.prepare(`
    SELECT id, stripe_session_id, commission_code, ecole_nom, code_court, tier,
           nb_licences_total, email_admin, nom_admin, date_achat, pdf_statut
    FROM forfaits_ecole
    WHERE pdf_statut IN ('en_attente', 'manuel_requis')
    ORDER BY date_achat ASC
    LIMIT 200
  `).all<{
    id: number; stripe_session_id: string; commission_code: string;
    ecole_nom: string; code_court: string; tier: string;
    nb_licences_total: number; email_admin: string; nom_admin: string | null;
    date_achat: number; pdf_statut: string;
  }>();

  const lignes = (res.results ?? []).map(l => ({
    ...l,
    tier_nom: PRIX_TIERS_CENTS[l.tier]?.nom ?? l.tier,
    age_jours: Math.floor((Math.floor(Date.now()/1000) - l.date_achat) / 86400)
  }));
  return jsonOk({ total: lignes.length, forfaits: lignes });
}

/* ──────────────────────────────────────────────────────────────────────────
 * POST /api/admin/forfaits/{id}/renvoyer-email
 * Re-génère un jeton 30j et renvoie l'email à l'admin du forfait.
 * Utile si l'admin a perdu son email original ou si le lien a expiré.
 * ────────────────────────────────────────────────────────────────────────── */

export async function handleAdminRenvoyerEmail(
  request: Request, env: Env, ctx: ExecutionContext, forfaitId: number
): Promise<Response> {
  if (request.method !== 'POST') return jsonErr('Méthode non autorisée', 405);
  if (!(await verifierAdminToken(request, env))) {
    return jsonErr('Token admin invalide', 401);
  }
  const forfait = await chargerForfait(env, forfaitId);
  if (!forfait) return jsonErr('Forfait introuvable', 404);
  if (forfait.pdf_statut !== 'genere' || !forfait.pdf_r2_path) {
    return jsonErr(`PDF pas encore généré (statut: ${forfait.pdf_statut})`, 409);
  }

  // Permet de personnaliser le destinataire (cas où l'admin a changé d'email)
  let body: { email_alternatif?: string } = {};
  try { body = await request.json(); } catch { /* body vide OK */ }
  const destinataire = (body.email_alternatif ?? forfait.email_admin).trim();
  if (!destinataire.includes('@')) {
    return jsonErr('Email destinataire invalide', 400);
  }

  const jeton = await genererJetonPdf(env, forfait.id);
  const urlPdf = urlTelechargementPdf(env, forfait.id, jeton);

  // Réutilise envoyerEmailLienFrais mais avec un destinataire potentiellement différent
  const forfaitMod: LigneForfait = {
    ...forfait,
    email_admin: destinataire  // écrase pour l'envoi
  };
  ctx.waitUntil(envoyerEmailLienFrais(env, forfaitMod, urlPdf));
  await ecrireAudit(env, 'renvoyer_email_pdf', forfait.id, {
    destinataire,
    destinataire_original: forfait.email_admin,
    alternatif: destinataire !== forfait.email_admin
  }, request);

  return jsonOk({
    ok: true,
    forfait_id: forfaitId,
    destinataire,
    url_pdf: urlPdf,
    expire_dans_jours: 30
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * GET /admin/forfaits  →  mini dashboard HTML
 * Page HTML autoportante (CSS + JS inline). Le token admin est demandé via
 * prompt() côté navigateur et stocké dans sessionStorage (pas localStorage)
 * pour ne PAS persister au-delà de la session.
 * ────────────────────────────────────────────────────────────────────────── */

export function handleAdminDashboardHtml(request: Request): Response {
  if (request.method !== 'GET') {
    return new Response('Méthode non autorisée', { status: 405 });
  }
  // Pas de vérif token côté page : la page elle-même est inoffensive.
  // C'est le JS qui demandera le token à l'utilisateur et appellera les API.
  const html = DASHBOARD_HTML;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      // Pas d'inline-script sans nonce dans une vraie prod, mais ici on accepte
      // car la page est servie sur un endpoint admin avec accès contrôlé par token.
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'"
    }
  });
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mathéquête — Admin forfaits école</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:0;background:#f5f7f9;color:#222}
  header{background:#0a6;color:#fff;padding:16px 24px;display:flex;justify-content:space-between;align-items:center}
  header h1{margin:0;font-size:18px;font-weight:600}
  header .actions button{background:#fff;color:#0a6;border:0;padding:6px 14px;border-radius:4px;cursor:pointer;font-weight:600}
  header .actions button:hover{background:#e0f5ec}
  main{max-width:1200px;margin:0 auto;padding:24px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px}
  .stat{background:#fff;padding:16px;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  .stat .v{font-size:28px;font-weight:700;color:#0a6}
  .stat .l{font-size:13px;color:#666;margin-top:4px}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  th,td{padding:10px 12px;text-align:left;font-size:13px;border-bottom:1px solid #eef}
  th{background:#f0f4f7;font-weight:600;color:#555}
  tr:hover{background:#f9fbfc}
  .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
  .badge.en_attente{background:#fff8e0;color:#a67c00}
  .badge.manuel_requis{background:#ffe8e0;color:#c84500}
  .badge.genere{background:#e0f5ec;color:#0a6}
  button.act{margin:0 2px;padding:4px 10px;border:1px solid #0a6;background:#fff;color:#0a6;border-radius:4px;cursor:pointer;font-size:12px}
  button.act:hover{background:#0a6;color:#fff}
  button.act:disabled{opacity:.4;cursor:not-allowed}
  .empty{text-align:center;padding:40px;color:#999}
  .err{background:#ffe8e0;color:#c84500;padding:12px;border-radius:4px;margin:16px 0}
  .ok{background:#e0f5ec;color:#0a6;padding:12px;border-radius:4px;margin:16px 0}
  details{margin-top:24px;background:#fff;padding:12px;border-radius:6px}
  details summary{cursor:pointer;font-weight:600;color:#555}
  code{background:#f0f4f7;padding:2px 6px;border-radius:3px;font-size:12px}
</style>
</head>
<body>
<header>
  <h1>✮ Mathéquête — Admin forfaits école</h1>
  <div class="actions">
    <button onclick="chargerEnAttente()">↻ Recharger</button>
    <button onclick="deconnecter()">Déconnecter</button>
  </div>
</header>
<main>
  <div id="msg"></div>
  <div class="stats" id="stats"></div>
  <h2 style="margin-top:0;font-size:16px;color:#555">File d'attente PDF</h2>
  <table>
    <thead><tr>
      <th>#</th><th>École</th><th>Code</th><th>Tier</th>
      <th>Codes QR</th><th>Statut</th><th>Âge</th><th>Admin</th><th>Actions</th>
    </tr></thead>
    <tbody id="corps"><tr><td colspan="9" class="empty">Chargement…</td></tr></tbody>
  </table>
  <details>
    <summary>Aide</summary>
    <p><strong>Statuts :</strong></p>
    <ul>
      <li><span class="badge en_attente">en_attente</span> — la génération auto via <code>ctx.waitUntil()</code> a échoué ou est en cours.</li>
      <li><span class="badge manuel_requis">manuel_requis</span> — forfait &gt;100 QR, à générer sur ton CPU local (D8).</li>
      <li><span class="badge genere">genere</span> — PDF dispo dans R2.</li>
    </ul>
    <p><strong>Workflow CPU local :</strong> voir <code>worker/scripts/genere-pdf-local.mjs</code> + <code>upload-pdf-forfait.ps1</code>.</p>
  </details>
</main>
<script>
(function(){
  const KEY = 'mq_admin_token';
  function obtenirToken(){
    let t = sessionStorage.getItem(KEY);
    if(!t){
      t = prompt('Token admin (X-Admin-Token) :');
      if(t) sessionStorage.setItem(KEY, t.trim());
    }
    return t;
  }
  window.deconnecter = function(){
    sessionStorage.removeItem(KEY);
    location.reload();
  };
  function escapeHtml(s){
    if(s===null||s===undefined) return '';
    return String(s).replace(/[&<>\"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }
  async function appel(method, path, body){
    const token = obtenirToken();
    if(!token) throw new Error('Token requis');
    const init = {
      method,
      headers: { 'X-Admin-Token': token, 'Content-Type': 'application/json' }
    };
    if(body !== undefined) init.body = JSON.stringify(body);
    const r = await fetch(path, init);
    if(r.status === 401){
      sessionStorage.removeItem(KEY);
      throw new Error('Token invalide, recharge la page');
    }
    const data = await r.json().catch(()=>({error:'Réponse non-JSON'}));
    if(!r.ok) throw new Error(data.error || ('HTTP '+r.status));
    return data;
  }
  function showMsg(html, kind){
    document.getElementById('msg').innerHTML = '<div class="'+(kind||'ok')+'">'+html+'</div>';
    setTimeout(()=>{ document.getElementById('msg').innerHTML=''; }, 6000);
  }
  window.chargerEnAttente = async function(){
    try{
      const d = await appel('GET', '/api/admin/forfaits/en-attente');
      const tbody = document.getElementById('corps');
      const stats = document.getElementById('stats');
      const enAtt = d.forfaits.filter(f => f.pdf_statut === 'en_attente').length;
      const manuel = d.forfaits.filter(f => f.pdf_statut === 'manuel_requis').length;
      const totalQr = d.forfaits.reduce((s,f) => s + f.nb_licences_total, 0);
      stats.innerHTML =
        '<div class="stat"><div class="v">'+d.total+'</div><div class="l">forfaits en attente</div></div>' +
        '<div class="stat"><div class="v">'+enAtt+'</div><div class="l">en_attente (regen auto possible)</div></div>' +
        '<div class="stat"><div class="v">'+manuel+'</div><div class="l">manuel_requis (CPU local)</div></div>' +
        '<div class="stat"><div class="v">'+totalQr+'</div><div class="l">codes QR à livrer</div></div>';
      if(d.forfaits.length === 0){
        tbody.innerHTML = '<tr><td colspan="9" class="empty">✨ Aucun forfait en attente, tout est traité.</td></tr>';
        return;
      }
      tbody.innerHTML = d.forfaits.map(f => {
        const peutRegenAuto = f.pdf_statut === 'en_attente' && f.nb_licences_total <= 100;
        return '<tr>' +
          '<td><code>#'+f.id+'</code></td>' +
          '<td>'+escapeHtml(f.ecole_nom)+'</td>' +
          '<td><code>'+escapeHtml(f.code_court)+'</code></td>' +
          '<td>'+escapeHtml(f.tier_nom)+'</td>' +
          '<td><strong>'+f.nb_licences_total+'</strong></td>' +
          '<td><span class="badge '+f.pdf_statut+'">'+f.pdf_statut+'</span></td>' +
          '<td>'+f.age_jours+' j</td>' +
          '<td>'+escapeHtml(f.email_admin)+'</td>' +
          '<td>' +
            '<button class="act" onclick="voir('+f.id+')">Voir</button>' +
            '<button class="act" onclick="regenAuto('+f.id+')" '+(peutRegenAuto?'':'disabled title="Trop de QR — utilise upload manuel"')+'>Regen auto</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    }catch(e){ showMsg('Erreur : '+escapeHtml(e.message), 'err'); }
  };
  window.voir = async function(id){
    try{
      const d = await appel('GET', '/api/admin/forfaits/'+id);
      const f = d.forfait, q = d.cles_qr;
      let lien = d.url_pdf ? '<p><a href="'+d.url_pdf+'" target="_blank">📥 Télécharger PDF (lien 30j)</a></p>' : '<p><em>PDF pas encore disponible.</em></p>';
      const html =
        '<strong>Forfait #'+f.id+'</strong> — '+escapeHtml(f.ecole_nom)+' ('+escapeHtml(f.code_court)+')<br>'+
        'Tier : '+escapeHtml(f.tier_nom)+' — '+f.nb_licences_total+' QR — '+escapeHtml(f.email_admin)+'<br>'+
        'Statut PDF : <span class="badge '+f.pdf_statut+'">'+f.pdf_statut+'</span><br>'+
        'Clés QR : total='+q.total+' • attribuées='+(q.attribuees||0)+' • activées='+(q.activees||0)+' • révoquées='+(q.revoquees||0)+
        lien +
        '<button class="act" onclick="renvoyer('+f.id+')">✉ Renvoyer email</button>';
      showMsg(html, 'ok');
    }catch(e){ showMsg('Erreur : '+escapeHtml(e.message), 'err'); }
  };
  window.regenAuto = async function(id){
    if(!confirm('Lancer la régénération auto du forfait #'+id+' ?')) return;
    try{
      const d = await appel('POST', '/api/admin/forfaits/'+id+'/regenerer-pdf', { mode:'auto' });
      showMsg('Régénération lancée (forfait #'+id+', '+d.nb_cles_qr+' QR). Revérifie le statut dans ~30s.', 'ok');
    }catch(e){ showMsg('Erreur : '+escapeHtml(e.message), 'err'); }
  };
  window.renvoyer = async function(id){
    const alt = prompt('Email destinataire (laisse vide pour utiliser celui du forfait) :', '');
    const body = alt ? { email_alternatif: alt } : {};
    try{
      const d = await appel('POST', '/api/admin/forfaits/'+id+'/renvoyer-email', body);
      showMsg('Email envoyé à <code>'+escapeHtml(d.destinataire)+'</code> (lien 30j).', 'ok');
    }catch(e){ showMsg('Erreur : '+escapeHtml(e.message), 'err'); }
  };
  chargerEnAttente();
})();
</script>
</body>
</html>`;

