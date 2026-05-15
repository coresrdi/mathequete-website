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
 */

import type { Env } from './types';
import {
  handleStripeWebhook,
  handleCreateCheckoutSession
} from './stripe-webhook';
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
        return handleStripeWebhook(request, env);
      }

      if (url.pathname === '/api/release-device') {
        return handleReleaseDevice(request, env);
      }

      // ===== Sprint C : stats élèves =====
      if (url.pathname === '/api/stats/push') {
        return handleStatsPush(request, env);
      }

      const statsClasseMatch = url.pathname.match(/^\/api\/stats\/classe\/([^/]+)$/);
      if (statsClasseMatch) {
        return handleStatsClasseGet(request, env, statsClasseMatch[1]);
      }

      // ===== Sprint S2 : activation manuelle =====
      if (url.pathname === '/api/activation/request') {
        return handleActivationRequest(request, env);
      }
      if (url.pathname === '/api/activation/status') {
        return handleActivationStatus(request, env);
      }
      if (url.pathname === '/api/activation/redeem') {
        return handleActivationRedeem(request, env);
      }
      if (url.pathname === '/admin/decide') {
        if (request.method === 'GET')  return handleAdminDecidePage(request, env);
        if (request.method === 'POST') return handleAdminDecideSubmit(request, env);
      }

      // ===== Sprint D1 : Auth prof (app de gestion enseignant) =====
      if (url.pathname === '/api/prof/signup')             return handleSignup(request, env);
      if (url.pathname === '/api/prof/signup/confirm')     return handleSignupConfirm(request, env);
      if (url.pathname === '/api/prof/login')              return handleLogin(request, env);
      if (url.pathname === '/api/prof/2fa/setup')          return handle2faSetup(request, env);
      if (url.pathname === '/api/prof/2fa/setup/confirm')  return handle2faSetupConfirm(request, env);
      if (url.pathname === '/api/prof/2fa/email/request')  return handle2faEmailRequest(request, env);
      if (url.pathname === '/api/prof/2fa/verify')         return handle2faVerify(request, env);
      if (url.pathname === '/api/prof/token/refresh')      return handleRefresh(request, env);
      if (url.pathname === '/api/prof/logout')             return handleLogout(request, env);
      if (url.pathname === '/api/prof/me')                 return handleMe(request, env);
      if (url.pathname === '/api/prof/dek/upgrade')        return handleDekUpgrade(request, env);

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Stripe-Signature, Authorization'
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
