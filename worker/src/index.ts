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
    'Access-Control-Allow-Headers': 'Content-Type, Stripe-Signature'
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
