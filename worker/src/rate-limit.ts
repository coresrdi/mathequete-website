/**
 * Mathéquête — Rate limiting (Sprint D5)
 *
 * Stratégie : sliding window stockée en D1.
 * Pour chaque clé (composite endpoint+facteur), on stocke un bucket {count, window_start}.
 * À chaque hit :
 *   - Si (now - window_start) > windowSec → reset (nouveau bucket)
 *   - Sinon : count++
 *   - Si count > max → refus
 *
 * Pourquoi D1 et pas KV ?
 *   - Pas besoin de provisionner un namespace KV séparé.
 *   - Volume actuel (qq centaines de profs) : D1 supporte largement.
 *   - Cohérence forte (KV est eventually consistent, gênant pour rate limit strict).
 *
 * Pourquoi sliding window simple et pas token bucket ?
 *   - Plus simple à coder et tester.
 *   - Suffisant pour protéger contre brute force basique.
 *   - Token bucket utile pour rate limiting très précis (API publique facturée) → pas notre cas.
 */

import type { Env } from './types';

export interface RateLimitConfig {
	/** Nombre maximum de requêtes dans la fenêtre */
	max: number;
	/** Taille de la fenêtre en secondes */
	windowSec: number;
}

export interface RateLimitResult {
	allowed: boolean;
	count: number;
	max: number;
	remaining: number;
	/** Timestamp UTC seconde de fin de la fenêtre courante */
	resetAt: number;
}

/**
 * Vérifie et incrémente le compteur de rate limit pour une clé donnée.
 *
 * Usage typique :
 *
 *   const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
 *   const rl = await checkRateLimit(env, `login:ip:${ip}`, { max: 10, windowSec: 60 });
 *   if (!rl.allowed) return jsonError('Trop de tentatives, réessayez plus tard', 429);
 */
export async function checkRateLimit(
	env: Env,
	key: string,
	config: RateLimitConfig
): Promise<RateLimitResult> {
	const now = Math.floor(Date.now() / 1000);
	const windowStart = now;

	try {
		// 1. Lire l'état actuel
		const row = await env.DB.prepare(
			`SELECT count, window_start FROM rate_limit_buckets WHERE key = ?`
		).bind(key).first<{ count: number; window_start: number }>();

		let count: number;
		let activeWindowStart: number;

		if (!row) {
			// Premier hit : créer le bucket
			count = 1;
			activeWindowStart = windowStart;
			await env.DB.prepare(
				`INSERT INTO rate_limit_buckets (key, count, window_start, updated_at)
				 VALUES (?, 1, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET
				   count = 1, window_start = excluded.window_start, updated_at = excluded.updated_at`
			).bind(key, windowStart, now).run();
		} else {
			const elapsed = now - row.window_start;
			if (elapsed >= config.windowSec) {
				// Fenêtre expirée → reset
				count = 1;
				activeWindowStart = now;
				await env.DB.prepare(
					`UPDATE rate_limit_buckets SET count = 1, window_start = ?, updated_at = ? WHERE key = ?`
				).bind(now, now, key).run();
			} else {
				// Fenêtre encore active → incrément
				count = row.count + 1;
				activeWindowStart = row.window_start;
				await env.DB.prepare(
					`UPDATE rate_limit_buckets SET count = count + 1, updated_at = ? WHERE key = ?`
				).bind(now, key).run();
			}
		}

		const resetAt = activeWindowStart + config.windowSec;
		const allowed = count <= config.max;
		const remaining = Math.max(0, config.max - count);

		return { allowed, count, max: config.max, remaining, resetAt };
	} catch (err) {
		console.error('[rate-limit] erreur DB pour key', key, ':', err);
		// Fail-open : en cas d'erreur DB, on laisse passer (mieux que tout bloquer)
		// mais on log pour alerte. Decision conservative à reconsidérer si DoS via panne D1.
		return {
			allowed: true,
			count: 0,
			max: config.max,
			remaining: config.max,
			resetAt: now + config.windowSec
		};
	}
}

/**
 * Extrait l'IP du client depuis les headers Cloudflare.
 * Cf. https://developers.cloudflare.com/fundamentals/reference/http-request-headers/
 */
export function getClientIp(request: Request): string {
	return (
		request.headers.get('cf-connecting-ip') ||
		request.headers.get('x-real-ip') ||
		request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
		'unknown'
	);
}

/**
 * Helper : retourne une Response 429 standardisée avec en-têtes Retry-After.
 */
export function rateLimitResponse(result: RateLimitResult): Response {
	const retryAfter = Math.max(1, result.resetAt - Math.floor(Date.now() / 1000));
	return new Response(
		JSON.stringify({
			error: 'Trop de tentatives, veuillez réessayer plus tard',
			retry_after_sec: retryAfter
		}),
		{
			status: 429,
			headers: {
				'Content-Type': 'application/json',
				'Retry-After': String(retryAfter),
				'X-RateLimit-Limit': String(result.max),
				'X-RateLimit-Remaining': String(result.remaining),
				'X-RateLimit-Reset': String(result.resetAt),
				'Access-Control-Allow-Origin': '*'
			}
		}
	);
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATIONS PRÉDÉFINIES PAR ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════

/** Auth sensible : login, 2FA verify, dek/upgrade (10/min/IP) */
export const RL_AUTH_STRICT: RateLimitConfig = { max: 10, windowSec: 60 };

/** Signup : 5/heure/IP (anti-spam compte) */
export const RL_SIGNUP: RateLimitConfig = { max: 5, windowSec: 3600 };

/** Activation manuelle / redeem : 5/10min/IP */
export const RL_ACTIVATION: RateLimitConfig = { max: 5, windowSec: 600 };

/** Stats push : 60/min/licence (un appareil push ~1/min, garde marge) */
export const RL_STATS_PUSH: RateLimitConfig = { max: 60, windowSec: 60 };

/** 2FA email request : 3/15min (anti-spam email) */
export const RL_2FA_EMAIL: RateLimitConfig = { max: 3, windowSec: 900 };

/** Endpoints généraux authentifiés (me, eleves CRUD) : 120/min/prof */
export const RL_API_AUTHENTICATED: RateLimitConfig = { max: 120, windowSec: 60 };

// Sprint IMPORT-ELEVES IE-3bis : endpoint public /api/jeu/info-qr/:cle_qr
// 60 req/min par IP = 1 par seconde, ample pour un élève qui scanne mais
// prévient les abuses de scan en boucle.
export const RL_INFO_QR: RateLimitConfig = { max: 60, windowSec: 60 };
