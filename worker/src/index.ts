/**
 * Mathéquête API — Cloudflare Worker
 *
 * Routes :
 *   POST /create-checkout-session  → crée session Stripe (depuis achat.html)
 *   POST /stripe-webhook            → réception webhook Stripe
 *   POST /verify-license            → vérification offline d'un code (optionnel — debug)
 *   GET  /health                    → ping
 *
 * Vu depuis le frontend : api.mathequete.com (DNS routé via Cloudflare)
 *
 * Sprint D5 : rate limiting sur endpoints sensibles via D1.
 */

import type { Env } from './types';
import {
  handleStripeWebhook,
  handleCreateCheckoutSession
} from './stripe-webhook';
import {
  rechercherCommissionsAutocomplete,
  verifierDisponibiliteCodeEcole,
  obtenirOuCreerCommission,
  validerFormatCodeCourt
} from './commissions';
import { servirPdfR2, verifierJetonPdf } from './r2-upload';
import {
  handleAdminRegenererPdf,
  handleAdminUploadPdf,
  handleAdminGetForfait,
  handleAdminListerEnAttente,
  handleAdminRenvoyerEmail,
  handleAdminDashboardHtml
} from './admin-forfaits';
import { verifierCodeBrut } from './generate-codes';
import { handleReleaseDevice } from './release-device';
import {
  handleActivationRequest,
  handleActivationStatus,
  handleActivationRedeem,
  handleAdminDecidePage,
  handleAdminDecideSubmit
} from './manual-activation';
import { handleStatsPush, handleStatsClasseGet } from './stats';
import {
  handleSignup,
  handleSignupConfirm,
  handleLogin,
  handle2faSetup,
  handle2faSetupConfirm,
  handle2faEmailRequest,
  handle2faVerify,
  handleRefresh,
  handleLogout,
  handleMe,
  handleDekUpgrade
} from './prof-routes';
import {
  handleEleveCreate,
  handleEleveList,
  handleEleveGet,
  handleEleveUpdate,
  handleEleveDelete
} from './eleves-routes';
import {
  handleProfClasseCreer,
  handleProfClasseLister,
  handleProfClasseArchiver,
  handleProfClasseAttribuerQr,
  handleProfMesQr
} from './prof-classes';
import {
  handleProfMonEcole,
  handleProfAssignerQr,
  handleProfMeLierEcole,
  handleProfValiderMembre
} from './admin-ecole';
import { handleJeuInfoQr, handleJeuSaisieCodeClasse, handleJeuActiverQr, handleJeuMesLicences } from './jeu-routes';
import {
  handleJeuProfilCreer,
  handleJeuProfilRecuperer,
  handleJeuProfilLicences
} from './profil-routes';
import {
  handleProfClasseElevesImport,
  handleProfClasseElevesLister,
  handleProfClasseResoudreConflit
} from './eleves-pre-crees';
import {
  checkRateLimit,
  getClientIp,
  rateLimitResponse,
  RL_AUTH_STRICT,
  RL_SIGNUP,
  RL_ACTIVATION,
  RL_STATS_PUSH,
  RL_2FA_EMAIL,
  RL_INFO_QR,
  RL_SAISIE
} from './rate-limit';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ===== CORS preflight =====
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    try {
      // ===== Routing =====
      if (url.pathname === '/health') {
        return jsonResponse({ status: 'ok', env: env.ENVIRONMENT, ts: Date.now() });
      }

      if (url.pathname === '/create-checkout-session') {
        return handleCreateCheckoutSession(request, env);
      }

      if (url.pathname === '/stripe-webhook') {
        return handleStripeWebhook(request, env, ctx);
      }

      // ===== Sprint PB1 : commissions scolaires + dispo code école =====
      if (url.pathname === '/api/commissions/autocomplete') {
        return handleCommissionsAutocomplete(request, env);
      }
      if (url.pathname === '/api/commissions/disponibilite-code') {
        return handleDisponibiliteCodeEcole(request, env);
      }

      // ===== Sprint PB1 : téléchargement PDF forfait école (jeton HMAC) =====
      const pdfMatch = url.pathname.match(/^\/api\/pdf\/(\d+)$/);
      if (pdfMatch) {
        return handlePdfDownload(request, env, parseInt(pdfMatch[1], 10));
      }

      // ===== Sprint PB1 : admin forfaits école (D8) =====
      // GET /admin/forfaits : mini dashboard HTML (token via prompt JS)
      if (url.pathname === '/admin/forfaits') {
        return handleAdminDashboardHtml(request);
      }
      // GET /api/admin/forfaits/en-attente : file d'attente (PDF non générés)
      // ⚠ IMPORTANT : tester AVANT les regex /(\d+) pour ne pas se faire griffer
      // (même si \d+ ne matche pas 'en-attente', on rend l'ordre explicite).
      if (url.pathname === '/api/admin/forfaits/en-attente') {
        return handleAdminListerEnAttente(request, env);
      }
      // POST /api/admin/forfaits/{id}/regenerer-pdf : regen auto via Worker
      const regenMatch = url.pathname.match(/^\/api\/admin\/forfaits\/(\d+)\/regenerer-pdf$/);
      if (regenMatch) {
        return handleAdminRegenererPdf(request, env, ctx, parseInt(regenMatch[1], 10));
      }
      // POST /api/admin/forfaits/{id}/renvoyer-email : re-envoie l'email lien frais
      const renvMatch = url.pathname.match(/^\/api\/admin\/forfaits\/(\d+)\/renvoyer-email$/);
      if (renvMatch) {
        return handleAdminRenvoyerEmail(request, env, ctx, parseInt(renvMatch[1], 10));
      }
      // PUT /api/admin/forfaits/{id}/pdf : upload manuel du PDF (CPU local)
      const uploadMatch = url.pathname.match(/^\/api\/admin\/forfaits\/(\d+)\/pdf$/);
      if (uploadMatch) {
        return handleAdminUploadPdf(request, env, ctx, parseInt(uploadMatch[1], 10));
      }
      // GET /api/admin/forfaits/{id} : etat complet + lien signe frais
      const getMatch = url.pathname.match(/^\/api\/admin\/forfaits\/(\d+)$/);
      if (getMatch) {
        return handleAdminGetForfait(request, env, parseInt(getMatch[1], 10));
      }

      if (url.pathname === '/api/release-device') {
        return handleReleaseDevice(request, env);
      }

      // ===== Sprint C : stats élèves (rate limit par IP) =====
      if (url.pathname === '/api/stats/push') {
        const rl = await checkRateLimit(env, `stats-push:ip:${getClientIp(request)}`, RL_STATS_PUSH);
        if (!rl.allowed) return rateLimitResponse(rl);
        return handleStatsPush(request, env);
      }

      const statsClasseMatch = url.pathname.match(/^\/api\/stats\/classe\/([^/]+)$/);
      if (statsClasseMatch) {
        return handleStatsClasseGet(request, env, statsClasseMatch[1]);
      }

      // ===== Sprint S2 : activation manuelle (rate limit IP) =====
      if (url.pathname === '/api/activation/request') {
        const rl = await checkRateLimit(env, `activation-req:ip:${getClientIp(request)}`, RL_ACTIVATION);
        if (!rl.allowed) return rateLimitResponse(rl);
        return handleActivationRequest(request, env);
      }
      if (url.pathname === '/api/activation/status') {
        return handleActivationStatus(request, env);
      }
      if (url.pathname === '/api/activation/redeem') {
        const rl = await checkRateLimit(env, `activation-redeem:ip:${getClientIp(request)}`, RL_ACTIVATION);
        if (!rl.allowed) return rateLimitResponse(rl);
        return handleActivationRedeem(request, env);
      }
      if (url.pathname === '/admin/decide') {
        if (request.method === 'GET')  return handleAdminDecidePage(request, env);
        if (request.method === 'POST') return handleAdminDecideSubmit(request, env);
      }

      // ===== Sprint D1 : Auth prof (app de gestion enseignant) =====
      // Rate limit strict sur tous les endpoints d'authentification.
      const ip = getClientIp(request);

      if (url.pathname === '/api/prof/signup') {
        const rl = await checkRateLimit(env, `signup:ip:${ip}`, RL_SIGNUP);
        if (!rl.allowed) return rateLimitResponse(rl);
        return handleSignup(request, env);
      }
      if (url.pathname === '/api/prof/signup/confirm') {
        const rl = await checkRateLimit(env, `signup-confirm:ip:${ip}`, RL_AUTH_STRICT);
        if (!rl.allowed) return rateLimitResponse(rl);
        return handleSignupConfirm(request, env);
      }
      if (url.pathname === '/api/prof/login') {
        const rl = await checkRateLimit(env, `login:ip:${ip}`, RL_AUTH_STRICT);
        if (!rl.allowed) return rateLimitResponse(rl);
        return handleLogin(request, env);
      }
      if (url.pathname === '/api/prof/2fa/setup') {
        const rl = await checkRateLimit(env, `2fa-setup:ip:${ip}`, RL_AUTH_STRICT);
        if (!rl.allowed) return rateLimitResponse(rl);
        return handle2faSetup(request, env);
      }
      if (url.pathname === '/api/prof/2fa/setup/confirm') {
        const rl = await checkRateLimit(env, `2fa-setup-confirm:ip:${ip}`, RL_AUTH_STRICT);
        if (!rl.allowed) return rateLimitResponse(rl);
        return handle2faSetupConfirm(request, env);
      }
      if (url.pathname === '/api/prof/2fa/email/request') {
        const rl = await checkRateLimit(env, `2fa-email:ip:${ip}`, RL_2FA_EMAIL);
        if (!rl.allowed) return rateLimitResponse(rl);
        return handle2faEmailRequest(request, env);
      }
      if (url.pathname === '/api/prof/2fa/verify') {
        const rl = await checkRateLimit(env, `2fa-verify:ip:${ip}`, RL_AUTH_STRICT);
        if (!rl.allowed) return rateLimitResponse(rl);
        return handle2faVerify(request, env);
      }
      if (url.pathname === '/api/prof/token/refresh') {
        return handleRefresh(request, env);
      }
      if (url.pathname === '/api/prof/logout') {
        return handleLogout(request, env);
      }
      if (url.pathname === '/api/prof/me') {
        return handleMe(request, env);
      }
      if (url.pathname === '/api/prof/dek/upgrade') {
        const rl = await checkRateLimit(env, `dek-upgrade:ip:${ip}`, RL_AUTH_STRICT);
        if (!rl.allowed) return rateLimitResponse(rl);
        return handleDekUpgrade(request, env);
      }

      // ===== Sprint D3 : CRUD élèves chiffré =====
      if (url.pathname === '/api/prof/eleves') {
        if (request.method === 'POST') return handleEleveCreate(request, env);
        if (request.method === 'GET')  return handleEleveList(request, env);
        return jsonError('Méthode non autorisée', 405);
      }
      const eleveByIdMatch = url.pathname.match(/^\/api\/prof\/eleves\/([a-zA-Z0-9_]+)$/);
      if (eleveByIdMatch) {
        const id = eleveByIdMatch[1];
        if (request.method === 'GET')    return handleEleveGet(request, env, id);
        if (request.method === 'PATCH')  return handleEleveUpdate(request, env, id);
        if (request.method === 'DELETE') return handleEleveDelete(request, env, id);
        return jsonError('Méthode non autorisée', 405);
      }

      // ===== Sprint PB1 item 11.3 : classes prof (créer / lister / archiver) =====
      // Routes littérales AVANT regex \d+ (pattern PB1-DEC-5)
      if (url.pathname === '/api/prof/classes') {
        if (request.method === 'POST') return handleProfClasseCreer(request, env);
        if (request.method === 'GET')  return handleProfClasseLister(request, env);
        return jsonError('Méthode non autorisée', 405);
      }
      const classeArchiverMatch = url.pathname.match(/^\/api\/prof\/classes\/(\d+)\/archiver$/);
      if (classeArchiverMatch) {
        return handleProfClasseArchiver(request, env, parseInt(classeArchiverMatch[1], 10));
      }
      // PB1 item 11.4 : attribuer N cles QR a une classe
      const attribuerQrClasseMatch = url.pathname.match(/^\/api\/prof\/classes\/(\d+)\/attribuer-qr$/);
      if (attribuerQrClasseMatch) {
        return handleProfClasseAttribuerQr(request, env, parseInt(attribuerQrClasseMatch[1], 10));
      }
      // PB1 item 11.5 : lister mes QR (vue prof globale)
      if (url.pathname === '/api/prof/mes-qr') {
        return handleProfMesQr(request, env);
      }
      // Sprint IMPORT-ELEVES IE-2/IE-4 : eleves pre-crees + resolution conflit
      const elevesImportMatch = url.pathname.match(/^\/api\/prof\/classes\/(\d+)\/eleves\/import$/);
      if (elevesImportMatch) {
        return handleProfClasseElevesImport(request, env, parseInt(elevesImportMatch[1], 10));
      }
      const elevesListerMatch = url.pathname.match(/^\/api\/prof\/classes\/(\d+)\/eleves$/);
      if (elevesListerMatch) {
        return handleProfClasseElevesLister(request, env, parseInt(elevesListerMatch[1], 10));
      }
      const resoudreMatch = url.pathname.match(/^\/api\/prof\/classes\/(\d+)\/resoudre-conflit$/);
      if (resoudreMatch) {
        return handleProfClasseResoudreConflit(request, env, parseInt(resoudreMatch[1], 10));
      }

      // ===== Sprint PB1 items 11.1 + 11.2 : admin école + liaison prof↔école =====
      // Routes littérales AVANT regex (PB1-DEC-5)
      if (url.pathname === '/api/prof/mon-ecole') {
        return handleProfMonEcole(request, env);
      }
      if (url.pathname === '/api/prof/mon-ecole/assigner-qr') {
        return handleProfAssignerQr(request, env);
      }
      if (url.pathname === '/api/prof/me-lier-ecole') {
        return handleProfMeLierEcole(request, env);
      }
      // POST /api/prof/mon-ecole/valider-prof/:prof_membre_id
      const validerMembreMatch = url.pathname.match(/^\/api\/prof\/mon-ecole\/valider-prof\/([a-zA-Z0-9_-]+)$/);
      if (validerMembreMatch) {
        return handleProfValiderMembre(request, env, validerMembreMatch[1]);
      }

      // ===== Sprint IMPORT-ELEVES IE-3bis : magie pré-remplissage code classe =====
      // PUBLIC + rate-limité par IP (60/min)
      const infoQrMatch = url.pathname.match(/^\/api\/jeu\/info-qr\/([A-Z0-9-]+)$/i);
      if (infoQrMatch) {
        const rl = await checkRateLimit(env, `info-qr:ip:${getClientIp(request)}`, RL_INFO_QR);
        if (!rl.allowed) return rateLimitResponse(rl);
        return handleJeuInfoQr(request, env, infoQrMatch[1]);
      }

      // ===== Sprint IMPORT-ELEVES IE-3 : matching saisie code classe (DEC-57) =====
      // PUBLIC + rate-limité anti-brute-force (10/min par IP)
      if (url.pathname === '/api/jeu/saisie-code-classe') {
        const rl = await checkRateLimit(env, `saisie-classe:ip:${getClientIp(request)}`, RL_SAISIE);
        if (!rl.allowed) return rateLimitResponse(rl);
        return handleJeuSaisieCodeClasse(request, env);
      }

      // ===== PB1 item 12 : 1ère activation QR (cas licence individuelle + cas école step 1) =====
      // PUBLIC + rate-limité RL_ACTIVATION (déjà utilisé par /verify-license)
      if (url.pathname === '/api/jeu/activer-qr') {
        const rl = await checkRateLimit(env, `activer-qr:ip:${getClientIp(request)}`, RL_ACTIVATION);
        if (!rl.allowed) return rateLimitResponse(rl);
        return handleJeuActiverQr(request, env);
      }

      // ===== DEC-63 : liste des produits actifs sur cet appareil (multi-licences) =====
      // PUBLIC + rate-limité RL_INFO_QR (60/min, même profil que info-qr)
      // Route avec paramètre PATH : /api/jeu/mes-licences/<device_fingerprint>
      // device_fingerprint : 8-128 chars alphanum + - _ + . (validation côté handler)
      const mesLicencesMatch = url.pathname.match(/^\/api\/jeu\/mes-licences\/([A-Za-z0-9_\-.]+)$/);
      if (mesLicencesMatch) {
        const rl = await checkRateLimit(env, `mes-licences:ip:${getClientIp(request)}`, RL_INFO_QR);
        if (!rl.allowed) return rateLimitResponse(rl);
        return handleJeuMesLicences(request, env, mesLicencesMatch[1]);
      }

      // ===== DEC-63 phase 2 : création profil cloud joueur (recovery_code) =====
      // PUBLIC + rate-limité RL_ACTIVATION (lent, anti-spam de création de profils)
      if (url.pathname === '/api/jeu/profil-creer') {
        const rl = await checkRateLimit(env, `profil-creer:ip:${getClientIp(request)}`, RL_ACTIVATION);
        if (!rl.allowed) return rateLimitResponse(rl);
        return handleJeuProfilCreer(request, env);
      }

      // ===== DEC-63 phase 2 : récupération cross-device =====
      // PUBLIC + rate-limité RL_SAISIE (10/min anti-brute-force sur recovery_code)
      if (url.pathname === '/api/jeu/profil-recuperer') {
        const rl = await checkRateLimit(env, `profil-recuperer:ip:${getClientIp(request)}`, RL_SAISIE);
        if (!rl.allowed) return rateLimitResponse(rl);
        return handleJeuProfilRecuperer(request, env);
      }

      // ===== DEC-63 phase 2 : vue lecture seule des licences d'un profil =====
      // PUBLIC + rate-limité RL_SAISIE (anti-brute-force aussi, même surface qu'au-dessus)
      // Route avec paramètre PATH : /api/jeu/profil-licences/<recovery_code_raw>
      const profilLicencesMatch = url.pathname.match(/^\/api\/jeu\/profil-licences\/([A-Za-z0-9_\-]+)$/);
      if (profilLicencesMatch) {
        const rl = await checkRateLimit(env, `profil-licences:ip:${getClientIp(request)}`, RL_SAISIE);
        if (!rl.allowed) return rateLimitResponse(rl);
        return handleJeuProfilLicences(request, env, profilLicencesMatch[1]);
      }

      if (url.pathname === '/verify-license' && request.method === 'POST') {
        const body = await request.json() as { code_brut?: string };
        if (!body.code_brut) return jsonError('code_brut requis', 400);
        const r = await verifierCodeBrut(body.code_brut, env.HMAC_SECRET_KEY);
        return jsonResponse(r);
      }

      return jsonError('Not found', 404);

    } catch (err) {
      console.error('[Worker] erreur non gérée :', err);
      return jsonError('Erreur interne', 500);
    }
  }
} satisfies ExportedHandler<Env>;

/* ===== Helpers ===== */

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Stripe-Signature, Authorization, X-Admin-Token'
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders()
    }
  });
}

function jsonError(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

/* ===== Sprint PB1 : handlers commissions + PDF école ===== */

async function handleCommissionsAutocomplete(
  request: Request, env: Env
): Promise<Response> {
  if (request.method !== 'GET') return jsonError('Méthode non autorisée', 405);
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  if (q.length < 2) return jsonResponse({ resultats: [] });
  const resultats = await rechercherCommissionsAutocomplete(env, q, 10);
  return jsonResponse({ resultats });
}

async function handleDisponibiliteCodeEcole(
  request: Request, env: Env
): Promise<Response> {
  if (request.method !== 'POST') return jsonError('Méthode non autorisée', 405);
  let body: {
    code_court?: string;
    email_admin?: string;
    commission_type?: 'publique' | 'privee';
    commission_nom?: string;
    ecole_nom?: string;
  };
  try { body = await request.json(); } catch { return jsonError('JSON invalide', 400); }
  if (!body.code_court || !body.email_admin || !body.commission_type || !body.commission_nom) {
    return jsonError('Champs requis : code_court, email_admin, commission_type, commission_nom', 400);
  }
  const fmt = validerFormatCodeCourt(body.code_court);
  if (!fmt.ok) return jsonResponse({ disponible: false, erreur_format: fmt.erreur }, 200);

  // Résout/crée la commission pour pouvoir tester la dispo D9.
  const { code: commission_code } = await obtenirOuCreerCommission(env, {
    nom: body.commission_nom,
    type: body.commission_type,
    email_admin: body.email_admin,
    ecole_nom: body.ecole_nom
  });
  const dispo = await verifierDisponibiliteCodeEcole(env, {
    commission_code,
    code_court: body.code_court,
    email_admin: body.email_admin
  });
  return jsonResponse({
    disponible: dispo.disponible,
    raison: dispo.raison,
    alternatives: dispo.alternatives ?? [],
    commission_code
  });
}

async function handlePdfDownload(
  request: Request, env: Env, forfaitId: number
): Promise<Response> {
  if (request.method !== 'GET') return jsonError('Méthode non autorisée', 405);
  const url = new URL(request.url);
  const jeton = url.searchParams.get('t');
  if (!jeton) return new Response('Jeton manquant', { status: 401 });

  const verif = await verifierJetonPdf(env, jeton);
  if (!verif) return new Response('Jeton invalide ou expiré', { status: 403 });
  if (verif.forfait_id !== forfaitId) {
    return new Response('Jeton ne correspond pas au forfait', { status: 403 });
  }

  const ligne = await env.DB
    .prepare('SELECT pdf_r2_path, pdf_statut FROM forfaits_ecole WHERE id = ?')
    .bind(forfaitId)
    .first<{ pdf_r2_path: string | null; pdf_statut: string }>();
  if (!ligne || !ligne.pdf_r2_path) {
    return new Response('PDF pas encore disponible (statut: ' + (ligne?.pdf_statut ?? 'inconnu') + ')', { status: 404 });
  }
  const resp = await servirPdfR2(env, ligne.pdf_r2_path);
  if (!resp) return new Response('PDF introuvable en stockage', { status: 404 });
  return resp;
}
