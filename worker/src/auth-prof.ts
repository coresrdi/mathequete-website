/**
 * auth-prof.ts — Helpers métier auth prof (Sprint D1)
 *
 * Couche au-dessus de crypto-prof.ts. Implémente :
 *   - Helpers DB : récupérer/créer/mettre à jour profs, sessions, audit
 *   - Helpers de réponse HTTP : succès, erreur, headers CORS
 *   - Helpers de validation : email, mot de passe fort
 *   - Anti-bruteforce : verrouillage compte après 5 échecs en 15 min
 *
 * Aucun handler HTTP ici ; ceux-ci sont dans prof-routes.ts.
 */

import type { Env } from './types';
import {
	sha256Hex,
	genererId,
	genererTokenSecuriseUrl,
	genererCodeClasse,
	genererDek,
	chiffrerDek
} from './crypto-prof';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface ProfRow {
	id: string;
	email: string;
	password_hash: string;
	nom_affiche: string;
	nom_ecole: string | null;
	ville: string | null;
	pays: string;
	twofa_methode: 'pending' | 'totp' | 'email' | 'sms';
	twofa_totp_secret: string | null;
	twofa_totp_iv: string | null;
	twofa_phone: string | null;
	twofa_phone_iv: string | null;
	twofa_setup_at: number | null;
	code_classe: string | null;
	dek_chiffree: string;
	dek_iv: string;
	dek_version: number;
	// Hybride D3 : wrap côté client (PBKDF2 du mdp). NULL pour profs créés
	// avant migration 0006 ; remplis au premier login post-migration.
	dek_wrap_user: string | null;
	dek_iv_user: string | null;
	dek_salt_user: string | null;
	dek_iter_user: number | null;
	dek_user_version: number;
	consentement_parental_atteste: number;
	cgu_acceptees_le: number | null;
	politique_version: string | null;
	created_at: number;
	derniere_connexion: number | null;
	statut: 'actif' | 'suspendu' | 'supprime';
	supprime_le: number | null;
	failed_login_count: number;
	locked_until: number | null;
}

export interface AuditEntry {
	prof_id: string | null;
	action: string;
	cible?: string | null;
	ip_pays?: string | null;
	user_agent?: string | null;
	meta?: Record<string, unknown> | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const MOT_DE_PASSE_MIN_LEN = 10;

export function validerEmail(email: string): boolean {
	if (typeof email !== 'string') return false;
	const clean = email.trim().toLowerCase();
	if (clean.length < 5 || clean.length > 254) return false;
	return EMAIL_REGEX.test(clean);
}

export function normaliserEmail(email: string): string {
	return email.trim().toLowerCase();
}

/**
 * Politique mot de passe (Loi 25 + NIST 800-63B 2024) :
 *   - Min 10 caractères
 *   - Pas une suite trivial (123456, password, etc.)
 *   - Pas l'email comme mot de passe
 */
export function validerMotDePasse(password: string, email?: string): { ok: boolean; raison?: string } {
	if (typeof password !== 'string') return { ok: false, raison: 'Mot de passe invalide' };
	if (password.length < MOT_DE_PASSE_MIN_LEN) {
		return { ok: false, raison: `Mot de passe trop court (minimum ${MOT_DE_PASSE_MIN_LEN} caractères)` };
	}
	if (password.length > 256) {
		return { ok: false, raison: 'Mot de passe trop long (max 256)' };
	}
	const lower = password.toLowerCase();
	const blacklist = [
		'password', 'motdepasse', '123456789', 'azerty', 'qwerty', '0000000000',
		'1111111111', 'admin12345', 'mathequete'
	];
	for (const b of blacklist) {
		if (lower.includes(b)) {
			return { ok: false, raison: 'Mot de passe trop commun' };
		}
	}
	if (email && lower.includes(normaliserEmail(email).split('@')[0])) {
		return { ok: false, raison: 'Le mot de passe ne doit pas contenir votre email' };
	}
	return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// DB — PROFS
// ═══════════════════════════════════════════════════════════════════════════

export async function trouverProfParEmail(env: Env, email: string): Promise<ProfRow | null> {
	const row = await env.DB.prepare(
		'SELECT * FROM profs WHERE email = ? AND statut != ? LIMIT 1'
	)
		.bind(normaliserEmail(email), 'supprime')
		.first<ProfRow>();
	return row ?? null;
}

export async function trouverProfParId(env: Env, id: string): Promise<ProfRow | null> {
	const row = await env.DB.prepare(
		'SELECT * FROM profs WHERE id = ? AND statut != ? LIMIT 1'
	)
		.bind(id, 'supprime')
		.first<ProfRow>();
	return row ?? null;
}

export async function trouverProfParCodeClasse(env: Env, code: string): Promise<ProfRow | null> {
	const row = await env.DB.prepare(
		'SELECT * FROM profs WHERE code_classe = ? AND statut = ? LIMIT 1'
	)
		.bind(code, 'actif')
		.first<ProfRow>();
	return row ?? null;
}

/**
 * Génère un code_classe garanti unique en DB.
 * Réessaie jusqu'à 10 fois en cas de collision (statistiquement infiniment improbable).
 */
export async function genererCodeClasseUnique(env: Env): Promise<string> {
	for (let i = 0; i < 10; i++) {
		const code = genererCodeClasse();
		const existant = await env.DB.prepare('SELECT id FROM profs WHERE code_classe = ? LIMIT 1')
			.bind(code)
			.first();
		if (!existant) return code;
	}
	throw new Error('Impossible de générer un code_classe unique (10 collisions consécutives)');
}

/**
 * Crée un prof en DB avec une DEK fraîche chiffrée.
 * Le mot de passe doit déjà être haché (hashPassword) AVANT l'appel.
 */
/**
 * Hybride D3 : si le client fournit dek_wrap_user (DEK chiffrée par K_user
 * dérivée du mdp prof), on les stocke en plus du wrap KEK serveur.
 * Si non fourni, dek_user_version reste 0 et le client devra wrapper
 * après le premier login.
 */
export async function creerProf(
	env: Env,
	params: {
		email: string;
		password_hash: string;
		nom_affiche: string;
		nom_ecole?: string;
		ville?: string;
		consentement_parental_atteste: boolean;
		politique_version: string;
		dek_wrap_user?: string;
		dek_iv_user?: string;
		dek_salt_user?: string;
		dek_iter_user?: number;
	}
): Promise<{ id: string; code_classe: string }> {
	const id = genererId('p', 16);
	const dek = genererDek();
	const { dek_chiffree_b64, dek_iv_b64 } = await chiffrerDek(dek, env.MASTER_ENCRYPTION_KEY);
	const code_classe = await genererCodeClasseUnique(env);
	const now = Math.floor(Date.now() / 1000);

	// Si le client a fourni un wrap, on le stocke. Sinon les colonnes restent NULL
	// et dek_user_version = 0 (sera rempli au prochain login réussi).
	const hasWrapUser =
		params.dek_wrap_user && params.dek_iv_user && params.dek_salt_user && params.dek_iter_user;

	await env.DB.prepare(
		`INSERT INTO profs (
			id, email, password_hash, nom_affiche, nom_ecole, ville, pays,
			twofa_methode, code_classe,
			dek_chiffree, dek_iv, dek_version,
			dek_wrap_user, dek_iv_user, dek_salt_user, dek_iter_user, dek_user_version,
			consentement_parental_atteste, cgu_acceptees_le, politique_version,
			created_at, statut, failed_login_count
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			id,
			normaliserEmail(params.email),
			params.password_hash,
			params.nom_affiche.trim(),
			params.nom_ecole?.trim() ?? null,
			params.ville?.trim() ?? null,
			'CA',
			'pending',
			code_classe,
			dek_chiffree_b64,
			dek_iv_b64,
			1,
			hasWrapUser ? params.dek_wrap_user : null,
			hasWrapUser ? params.dek_iv_user : null,
			hasWrapUser ? params.dek_salt_user : null,
			hasWrapUser ? params.dek_iter_user : null,
			hasWrapUser ? 1 : 0,
			params.consentement_parental_atteste ? 1 : 0,
			now,
			params.politique_version,
			now,
			'actif',
			0
		)
		.run();

	return { id, code_classe };
}

export async function marquerConnexionReussie(env: Env, prof_id: string): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		'UPDATE profs SET derniere_connexion = ?, failed_login_count = 0, locked_until = NULL WHERE id = ?'
	)
		.bind(now, prof_id)
		.run();
}

const MAX_TENTATIVES_LOGIN = 5;
const VERROUILLAGE_DUREE_SEC = 15 * 60;

export async function incrementerEchecLogin(env: Env, prof_id: string): Promise<{ verrouille: boolean }> {
	const now = Math.floor(Date.now() / 1000);
	const r = await env.DB.prepare(
		'SELECT failed_login_count FROM profs WHERE id = ?'
	)
		.bind(prof_id)
		.first<{ failed_login_count: number }>();
	if (!r) return { verrouille: false };
	const nouveau = r.failed_login_count + 1;
	if (nouveau >= MAX_TENTATIVES_LOGIN) {
		await env.DB.prepare(
			'UPDATE profs SET failed_login_count = ?, locked_until = ? WHERE id = ?'
		)
			.bind(nouveau, now + VERROUILLAGE_DUREE_SEC, prof_id)
			.run();
		return { verrouille: true };
	}
	await env.DB.prepare('UPDATE profs SET failed_login_count = ? WHERE id = ?')
		.bind(nouveau, prof_id)
		.run();
	return { verrouille: false };
}

export function estVerrouille(prof: ProfRow): boolean {
	if (!prof.locked_until) return false;
	return prof.locked_until > Math.floor(Date.now() / 1000);
}

// ═══════════════════════════════════════════════════════════════════════════
// DB — SESSIONS (refresh tokens)
// ═══════════════════════════════════════════════════════════════════════════

const REFRESH_TOKEN_DUREE_SEC = 30 * 24 * 60 * 60; // 30 jours

export async function creerSession(
	env: Env,
	prof_id: string,
	ip_pays: string | null,
	user_agent: string | null
): Promise<{ refresh_token: string; session_id: string }> {
	const session_id = genererId('s', 32);
	const refresh_token = genererTokenSecuriseUrl(32);
	const token_hash = await sha256Hex(refresh_token);
	const now = Math.floor(Date.now() / 1000);

	await env.DB.prepare(
		`INSERT INTO prof_sessions
		 (id, prof_id, refresh_token_hash, device_label, ip_pays, created_at, expire_le)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			session_id,
			prof_id,
			token_hash,
			user_agent ? user_agent.slice(0, 200) : null,
			ip_pays,
			now,
			now + REFRESH_TOKEN_DUREE_SEC
		)
		.run();

	return { refresh_token, session_id };
}

export async function trouverSessionParRefreshToken(
	env: Env,
	refresh_token: string
): Promise<{ id: string; prof_id: string; expire_le: number } | null> {
	const hash = await sha256Hex(refresh_token);
	const now = Math.floor(Date.now() / 1000);
	const row = await env.DB.prepare(
		`SELECT id, prof_id, expire_le FROM prof_sessions
		 WHERE refresh_token_hash = ? AND revoquee_le IS NULL AND expire_le > ?
		 LIMIT 1`
	)
		.bind(hash, now)
		.first<{ id: string; prof_id: string; expire_le: number }>();
	return row ?? null;
}

export async function revoquerSession(env: Env, session_id: string): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		'UPDATE prof_sessions SET revoquee_le = ? WHERE id = ? AND revoquee_le IS NULL'
	)
		.bind(now, session_id)
		.run();
}

export async function revoquerToutesSessionsProf(env: Env, prof_id: string): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		'UPDATE prof_sessions SET revoquee_le = ? WHERE prof_id = ? AND revoquee_le IS NULL'
	)
		.bind(now, prof_id)
		.run();
}

// ═══════════════════════════════════════════════════════════════════════════
// DB — MAGIC LINKS
// ═══════════════════════════════════════════════════════════════════════════

const MAGIC_LINK_DUREE_SEC = 15 * 60; // 15 minutes

export async function creerMagicLink(
	env: Env,
	params: {
		prof_id: string | null;
		email: string;
		purpose: 'signup_confirm' | 'login' | 'reset_password' | 'email_change';
		ip: string | null;
	}
): Promise<{ token: string }> {
	const token = genererTokenSecuriseUrl(32);
	const token_hash = await sha256Hex(token);
	const now = Math.floor(Date.now() / 1000);

	await env.DB.prepare(
		`INSERT INTO prof_magic_links
		 (token_hash, prof_id, email, purpose, created_at, expire_le, ip_demande)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			token_hash,
			params.prof_id,
			normaliserEmail(params.email),
			params.purpose,
			now,
			now + MAGIC_LINK_DUREE_SEC,
			params.ip
		)
		.run();

	return { token };
}

export async function consommerMagicLink(
	env: Env,
	token: string
): Promise<{ prof_id: string | null; email: string; purpose: string } | null> {
	const hash = await sha256Hex(token);
	const now = Math.floor(Date.now() / 1000);
	const row = await env.DB.prepare(
		`SELECT prof_id, email, purpose FROM prof_magic_links
		 WHERE token_hash = ? AND utilise_le IS NULL AND expire_le > ?
		 LIMIT 1`
	)
		.bind(hash, now)
		.first<{ prof_id: string | null; email: string; purpose: string }>();
	if (!row) return null;
	await env.DB.prepare(
		'UPDATE prof_magic_links SET utilise_le = ? WHERE token_hash = ?'
	)
		.bind(now, hash)
		.run();
	return row;
}

// ═══════════════════════════════════════════════════════════════════════════
// DB — 2FA TOKENS (email/SMS)
// ═══════════════════════════════════════════════════════════════════════════

const TOKEN_2FA_DUREE_SEC = 5 * 60;

export async function creer2faToken(
	env: Env,
	prof_id: string,
	code: string,
	methode: 'email' | 'sms'
): Promise<void> {
	const hash = await sha256Hex(code);
	const now = Math.floor(Date.now() / 1000);
	// Invalide les anciens tokens du même prof
	await env.DB.prepare(
		'UPDATE prof_2fa_tokens SET utilise_le = ? WHERE prof_id = ? AND utilise_le IS NULL'
	)
		.bind(now, prof_id)
		.run();
	await env.DB.prepare(
		`INSERT INTO prof_2fa_tokens (prof_id, code_hash, methode, created_at, expire_le)
		 VALUES (?, ?, ?, ?, ?)`
	)
		.bind(prof_id, hash, methode, now, now + TOKEN_2FA_DUREE_SEC)
		.run();
}

const MAX_TENTATIVES_2FA = 3;

export async function verifier2faToken(
	env: Env,
	prof_id: string,
	code: string
): Promise<{ ok: boolean; raison?: string }> {
	const hash = await sha256Hex(code);
	const now = Math.floor(Date.now() / 1000);
	const row = await env.DB.prepare(
		`SELECT id, tentatives FROM prof_2fa_tokens
		 WHERE prof_id = ? AND code_hash = ? AND utilise_le IS NULL AND expire_le > ?
		 LIMIT 1`
	)
		.bind(prof_id, hash, now)
		.first<{ id: number; tentatives: number }>();
	if (!row) {
		// Incrémente tentatives sur le token actif (sans hash match)
		await env.DB.prepare(
			`UPDATE prof_2fa_tokens SET tentatives = tentatives + 1
			 WHERE prof_id = ? AND utilise_le IS NULL AND expire_le > ?`
		)
			.bind(prof_id, now)
			.run();
		// Invalide si trop de tentatives
		await env.DB.prepare(
			`UPDATE prof_2fa_tokens SET utilise_le = ?
			 WHERE prof_id = ? AND utilise_le IS NULL AND tentatives >= ?`
		)
			.bind(now, prof_id, MAX_TENTATIVES_2FA)
			.run();
		return { ok: false, raison: 'Code invalide ou expiré' };
	}
	await env.DB.prepare(
		'UPDATE prof_2fa_tokens SET utilise_le = ? WHERE id = ?'
	)
		.bind(now, row.id)
		.run();
	return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// DB — AUDIT LOG (Loi 25)
// ═══════════════════════════════════════════════════════════════════════════

export async function ecrireAudit(env: Env, entry: AuditEntry): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		`INSERT INTO prof_audit_log (prof_id, action, cible, ip_pays, user_agent, meta_json, at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			entry.prof_id,
			entry.action,
			entry.cible ?? null,
			entry.ip_pays ?? null,
			entry.user_agent ? entry.user_agent.slice(0, 200) : null,
			entry.meta ? JSON.stringify(entry.meta) : null,
			now
		)
		.run();
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS HTTP
// ═══════════════════════════════════════════════════════════════════════════

export function corsHeadersProf(): Record<string, string> {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		'Access-Control-Max-Age': '86400'
	};
}

export function jsonOk(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json', ...corsHeadersProf() }
	});
}

export function jsonErr(message: string, status: number, code?: string): Response {
	return new Response(JSON.stringify({ error: message, code: code ?? null }), {
		status,
		headers: { 'Content-Type': 'application/json', ...corsHeadersProf() }
	});
}

/** Extrait le token JWT du header Authorization: Bearer xxx */
export function extraireBearerToken(request: Request): string | null {
	const auth = request.headers.get('Authorization');
	if (!auth) return null;
	const m = auth.match(/^Bearer\s+(.+)$/i);
	return m ? m[1].trim() : null;
}

/** Extrait pays + UA pour audit. */
export function extraireMetadonneesRequete(request: Request): { ip_pays: string | null; user_agent: string | null } {
	const cf = (request as Request & { cf?: { country?: string } }).cf;
	return {
		ip_pays: cf?.country ?? null,
		user_agent: request.headers.get('User-Agent')
	};
}
