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
  handleAdminGetForfait
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
  checkRateLimit,
  getClientIp,
  rateLimitResponse,
  RL_AUTH_STRICT,
  RL_SIGNUP,
  RL_ACTIVATION,
  RL_STATS_PUSH,
  RL_2FA_EMAIL
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
      // POST /api/admin/forfaits/{id}/regenerer-pdf : regen auto via Worker
      const regenMatch = url.pathname.match(/^\/api\/admin\/forfaits\/(\d+)\/regenerer-pdf$/);
      if (regenMatch) {
        return handleAdminRegenererPdf(request, env, ctx, parseInt(regenMatch[1], 10));
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
