/**
 * prof-routes.ts — Handlers HTTP auth prof (Sprint D1)
 *
 * Endpoints :
 *   POST /api/prof/signup              → création compte + magic link confirmation
 *   POST /api/prof/signup/confirm      → confirmation via magic link (premier login)
 *   POST /api/prof/login               → email + mot de passe → JWT pre-2fa
 *   POST /api/prof/login/magic-link    → demande lien de connexion (passwordless)
 *   POST /api/prof/login/magic-consume → consomme un magic link de connexion
 *   POST /api/prof/2fa/setup           → init TOTP : génère secret + QR
 *   POST /api/prof/2fa/setup/confirm   → confirme TOTP : valide premier code
 *   POST /api/prof/2fa/email/request   → demande code 6-chiffres par courriel
 *   POST /api/prof/2fa/verify          → vérifie code (TOTP ou email) → JWT complet
 *   POST /api/prof/token/refresh       → refresh JWT via refresh_token
 *   POST /api/prof/logout              → révoque session courante
 *   GET  /api/prof/me                  → infos prof connecté (JWT requis)
 *
 * Sécurité :
 *   - Rate limit : à brancher sur Cloudflare Rate Limiting Rules (config dashboard)
 *   - Anti-bruteforce : verrouillage compte 15 min après 5 échecs login
 *   - Anti-enumeration : signup retourne toujours OK générique, magic link aussi
 *   - JWT pre-2fa expire 10 min, JWT complet 8h, refresh token 30j
 */

import type { Env } from './types';
import {
	hashPassword,
	verifyPassword,
	signJwt,
	verifyJwt,
	verifierTotp,
	genererSecretTotp,
	construireOtpauthUri,
	genererCode6Chiffres,
	aesGcmEncrypt,
	aesGcmDecrypt,
	hexToBytes,
	bytesToHex,
	type JwtPayload
} from './crypto-prof';
import {
	validerEmail,
	normaliserEmail,
	validerMotDePasse,
	trouverProfParEmail,
	trouverProfParId,
	creerProf,
	marquerConnexionReussie,
	incrementerEchecLogin,
	estVerrouille,
	creerSession,
	trouverSessionParRefreshToken,
	revoquerSession,
	creerMagicLink,
	consommerMagicLink,
	creer2faToken,
	verifier2faToken,
	ecrireAudit,
	jsonOk,
	jsonErr,
	extraireBearerToken,
	extraireMetadonneesRequete,
	type ProfRow
} from './auth-prof';
import { envoyerEmail } from './email';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════════════════

const JWT_PRE_2FA_DUREE_SEC = 10 * 60;      // 10 min
const JWT_COMPLET_DUREE_SEC = 8 * 60 * 60;  // 8 h
const POLITIQUE_VERSION_ACTUELLE = 'v2-2026-05-14';

// ═══════════════════════════════════════════════════════════════════════════
// HELPER — Vérifier MASTER_ENCRYPTION_KEY présente
// ═══════════════════════════════════════════════════════════════════════════

function verifierConfig(env: Env): Response | null {
	if (!env.MASTER_ENCRYPTION_KEY || env.MASTER_ENCRYPTION_KEY.length < 64) {
		console.error('[prof-routes] MASTER_ENCRYPTION_KEY manquant ou trop court');
		return jsonErr('Configuration serveur incomplète', 503, 'CONFIG_MISSING');
	}
	if (!env.HMAC_SECRET_KEY || env.HMAC_SECRET_KEY.length < 32) {
		console.error('[prof-routes] HMAC_SECRET_KEY manquant');
		return jsonErr('Configuration serveur incomplète', 503, 'CONFIG_MISSING');
	}
	return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER — Créer JWT pre-2FA ou complet
// ═══════════════════════════════════════════════════════════════════════════

async function emettreJwt(env: Env, prof_id: string, twofa: boolean): Promise<{ access_token: string; expire_in: number }> {
	const now = Math.floor(Date.now() / 1000);
	const duree = twofa ? JWT_COMPLET_DUREE_SEC : JWT_PRE_2FA_DUREE_SEC;
	const payload: JwtPayload = {
		sub: prof_id,
		iat: now,
		exp: now + duree,
		twofa,
		jti: bytesToHex(crypto.getRandomValues(new Uint8Array(8)))
	};
	const access_token = await signJwt(payload, env.HMAC_SECRET_KEY);
	return { access_token, expire_in: duree };
}

/**
 * Vérifie le JWT et retourne le prof_id.
 * @param require2fa true = exige que le JWT soit post-2FA (sinon refuse)
 */
export async function authentifier(
	request: Request,
	env: Env,
	require2fa: boolean
): Promise<{ prof: ProfRow; payload: JwtPayload } | Response> {
	const token = extraireBearerToken(request);
	if (!token) return jsonErr('Token manquant', 401, 'NO_TOKEN');
	const payload = await verifyJwt(token, env.HMAC_SECRET_KEY);
	if (!payload) return jsonErr('Token invalide ou expiré', 401, 'BAD_TOKEN');
	if (require2fa && !payload.twofa) {
		return jsonErr('2FA requise', 401, 'TWOFA_REQUIRED');
	}
	const prof = await trouverProfParId(env, payload.sub);
	if (!prof) return jsonErr('Compte introuvable', 401, 'PROF_GONE');
	if (prof.statut !== 'actif') return jsonErr('Compte désactivé', 403, 'PROF_SUSPENDED');
	return { prof, payload };
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/prof/signup
// ═══════════════════════════════════════════════════════════════════════════

interface SignupBody {
	email?: string;
	password?: string;
	nom_affiche?: string;
	nom_ecole?: string;
	ville?: string;
	consentement_parental_atteste?: boolean;
	cgu_acceptees?: boolean;
	// Sprint D3 — hybride : si fournis, le client a déjà wrappé la DEK
	// avec K_user = PBKDF2(mdp). Ces champs sont optionnels pour rétro-compat.
	dek_wrap_user?: string;     // base64(AES-GCM(DEK, K_user))
	dek_iv_user?: string;       // base64 IV
	dek_salt_user?: string;     // base64 sel (16 octets)
	dek_iter_user?: number;     // PBKDF2 : iterations ; Argon2id : 0
	// Sprint D4 : nom du KDF utilisé par le client.
	// Si absent, fallback 'pbkdf2_sha256_100k' pour rétro-compat.
	dek_kdf?: string;
}

export async function handleSignup(request: Request, env: Env): Promise<Response> {
	const cfg = verifierConfig(env);
	if (cfg) return cfg;
	if (request.method !== 'POST') return jsonErr('Méthode non autorisée', 405);

	let body: SignupBody;
	try { body = await request.json(); }
	catch { return jsonErr('JSON invalide', 400); }

	if (!body.email || !validerEmail(body.email)) {
		return jsonErr('Adresse courriel invalide', 400, 'BAD_EMAIL');
	}
	if (!body.password) return jsonErr('Mot de passe requis', 400, 'NO_PWD');
	const v = validerMotDePasse(body.password, body.email);
	if (!v.ok) return jsonErr(v.raison || 'Mot de passe invalide', 400, 'WEAK_PWD');

	if (!body.nom_affiche || body.nom_affiche.trim().length < 2) {
		return jsonErr('Nom complet requis', 400, 'BAD_NAME');
	}
	if (!body.cgu_acceptees) {
		return jsonErr('Vous devez accepter les conditions', 400, 'NO_CGU');
	}

	const email = normaliserEmail(body.email);
	const meta = extraireMetadonneesRequete(request);

	// Si compte existe déjà : ne révèle rien (anti-énumération).
	const existant = await trouverProfParEmail(env, email);
	if (existant) {
		await ecrireAudit(env, {
			prof_id: null,
			action: 'signup_email_pris',
			ip_pays: meta.ip_pays,
			user_agent: meta.user_agent,
			meta: { email_hash_prefix: email.slice(0, 3) }
		});
		// Réponse identique au cas succès
		return jsonOk({
			ok: true,
			message: 'Si cette adresse est nouvelle, un courriel de confirmation a été envoyé.'
		});
	}

	// Validation légère des wraps côté client si fournis.
	if (!validerWrapUserSignup(body)) {
		return jsonErr('Wrap DEK client invalide', 400, 'BAD_WRAP');
	}

	// Crée le compte (statut "pending 2FA")
	const password_hash = await hashPassword(body.password);
	const { id, code_classe } = await creerProf(env, {
		email,
		password_hash,
		nom_affiche: body.nom_affiche,
		nom_ecole: body.nom_ecole,
		ville: body.ville,
		consentement_parental_atteste: Boolean(body.consentement_parental_atteste),
		politique_version: POLITIQUE_VERSION_ACTUELLE,
		dek_wrap_user: body.dek_wrap_user,
		dek_iv_user: body.dek_iv_user,
		dek_salt_user: body.dek_salt_user,
		dek_iter_user: body.dek_iter_user,
		dek_kdf: body.dek_kdf,
	});

	// Magic link de confirmation email
	const { token } = await creerMagicLink(env, {
		prof_id: id,
		email,
		purpose: 'signup_confirm',
		ip: meta.ip_pays
	});

	const lienConfirm = `${env.PUBLIC_SITE_URL}/prof/confirm?t=${encodeURIComponent(token)}`;

	await envoyerEmailConfirmationSignup(env, email, body.nom_affiche, lienConfirm, code_classe);

	await ecrireAudit(env, {
		prof_id: id,
		action: 'signup_succes',
		ip_pays: meta.ip_pays,
		user_agent: meta.user_agent,
		meta: { politique: POLITIQUE_VERSION_ACTUELLE }
	});

	return jsonOk({
		ok: true,
		message: 'Compte créé. Vérifiez votre courriel pour confirmer.',
		// code_classe affiché immédiatement aussi (le prof peut le noter)
		code_classe
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/prof/signup/confirm
// ═══════════════════════════════════════════════════════════════════════════

export async function handleSignupConfirm(request: Request, env: Env): Promise<Response> {
	const cfg = verifierConfig(env);
	if (cfg) return cfg;
	if (request.method !== 'POST') return jsonErr('Méthode non autorisée', 405);

	let body: { token?: string };
	try { body = await request.json(); }
	catch { return jsonErr('JSON invalide', 400); }
	if (!body.token) return jsonErr('Token manquant', 400);

	const consume = await consommerMagicLink(env, body.token);
	if (!consume || consume.purpose !== 'signup_confirm' || !consume.prof_id) {
		return jsonErr('Lien invalide ou expiré', 400, 'BAD_LINK');
	}

	const meta = extraireMetadonneesRequete(request);
	await ecrireAudit(env, {
		prof_id: consume.prof_id,
		action: 'signup_confirm',
		ip_pays: meta.ip_pays,
		user_agent: meta.user_agent
	});

	return jsonOk({ ok: true, message: 'Compte confirmé. Vous pouvez maintenant configurer la 2FA.' });
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/prof/login
// ═══════════════════════════════════════════════════════════════════════════

export async function handleLogin(request: Request, env: Env): Promise<Response> {
	const cfg = verifierConfig(env);
	if (cfg) return cfg;
	if (request.method !== 'POST') return jsonErr('Méthode non autorisée', 405);

	let body: { email?: string; password?: string };
	try { body = await request.json(); }
	catch { return jsonErr('JSON invalide', 400); }

	if (!body.email || !validerEmail(body.email)) {
		return jsonErr('Identifiants invalides', 401, 'BAD_CRED'); // pas de "email inexistant"
	}
	if (!body.password) return jsonErr('Identifiants invalides', 401, 'BAD_CRED');

	const meta = extraireMetadonneesRequete(request);
	const prof = await trouverProfParEmail(env, body.email);

	// Anti-énumération : on hache toujours qqc même si pas trouvé pour égaliser le timing
	if (!prof) {
		await hashPassword('dummy-' + Math.random()); // sacrifice timing
		await ecrireAudit(env, {
			prof_id: null,
			action: 'login_email_inconnu',
			ip_pays: meta.ip_pays,
			user_agent: meta.user_agent
		});
		return jsonErr('Identifiants invalides', 401, 'BAD_CRED');
	}

	if (estVerrouille(prof)) {
		const secondesRestantes = (prof.locked_until ?? 0) - Math.floor(Date.now() / 1000);
		return jsonErr(
			`Compte temporairement verrouillé (trop de tentatives). Réessayez dans ${Math.ceil(secondesRestantes / 60)} min.`,
			423,
			'LOCKED'
		);
	}

	const ok = await verifyPassword(body.password, prof.password_hash);
	if (!ok) {
		const { verrouille } = await incrementerEchecLogin(env, prof.id);
		await ecrireAudit(env, {
			prof_id: prof.id,
			action: verrouille ? 'login_verrouille' : 'login_echec',
			ip_pays: meta.ip_pays,
			user_agent: meta.user_agent
		});
		return jsonErr('Identifiants invalides', 401, 'BAD_CRED');
	}

	// Mot de passe OK. Émet un JWT pre-2FA (le client doit appeler /2fa/verify).
	const { access_token, expire_in } = await emettreJwt(env, prof.id, false);
	await ecrireAudit(env, {
		prof_id: prof.id,
		action: 'login_password_ok',
		ip_pays: meta.ip_pays,
		user_agent: meta.user_agent
	});

	return jsonOk({
		ok: true,
		access_token,
		expire_in,
		twofa_methode: prof.twofa_methode,
		twofa_configure: prof.twofa_methode !== 'pending',
		etape: prof.twofa_methode === 'pending' ? 'setup_2fa' : 'verify_2fa'
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/prof/2fa/setup
// ═══════════════════════════════════════════════════════════════════════════

export async function handle2faSetup(request: Request, env: Env): Promise<Response> {
	const cfg = verifierConfig(env);
	if (cfg) return cfg;
	if (request.method !== 'POST') return jsonErr('Méthode non autorisée', 405);

	const auth = await authentifier(request, env, false); // JWT pre-2FA accepté
	if (auth instanceof Response) return auth;
	const { prof } = auth;

	let body: { methode?: string };
	try { body = await request.json(); }
	catch { return jsonErr('JSON invalide', 400); }
	const methode = body.methode;
	if (methode !== 'totp' && methode !== 'email') {
		return jsonErr('Méthode 2FA invalide (totp ou email)', 400, 'BAD_METHODE');
	}

	if (methode === 'totp') {
		const { base32 } = genererSecretTotp();
		// Chiffre le secret avec MASTER_ENCRYPTION_KEY avant stockage
		const masterKey = hexToBytes(env.MASTER_ENCRYPTION_KEY);
		const enc = await aesGcmEncrypt(masterKey, base32);

		// Stocke en pending — la méthode ne devient active qu'après /setup/confirm
		await env.DB.prepare(
			'UPDATE profs SET twofa_totp_secret = ?, twofa_totp_iv = ? WHERE id = ?'
		)
			.bind(enc.ciphertext_b64, enc.iv_b64, prof.id)
			.run();

		const otpauth = construireOtpauthUri(base32, 'Mathéquête', prof.email);

		return jsonOk({
			ok: true,
			methode: 'totp',
			secret_base32: base32,
			otpauth_uri: otpauth,
			instructions: 'Scannez le code QR avec Google Authenticator, Authy ou Aegis, puis confirmez avec un code de 6 chiffres.'
		});
	}

	// methode === 'email'
	await env.DB.prepare(
		'UPDATE profs SET twofa_methode = ? WHERE id = ?'
	)
		.bind('email', prof.id)
		.run();

	return jsonOk({
		ok: true,
		methode: 'email',
		instructions: '2FA par courriel activée. À chaque connexion, un code à 6 chiffres sera envoyé à votre courriel.'
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/prof/2fa/setup/confirm
// ═══════════════════════════════════════════════════════════════════════════

export async function handle2faSetupConfirm(request: Request, env: Env): Promise<Response> {
	const cfg = verifierConfig(env);
	if (cfg) return cfg;
	if (request.method !== 'POST') return jsonErr('Méthode non autorisée', 405);

	const auth = await authentifier(request, env, false);
	if (auth instanceof Response) return auth;
	const { prof } = auth;

	let body: { code?: string };
	try { body = await request.json(); }
	catch { return jsonErr('JSON invalide', 400); }
	if (!body.code || !/^\d{6}$/.test(body.code)) {
		return jsonErr('Code 6 chiffres requis', 400);
	}

	if (!prof.twofa_totp_secret || !prof.twofa_totp_iv) {
		return jsonErr('Aucun setup TOTP en cours. Appelez /2fa/setup d\'abord.', 400, 'NO_SETUP');
	}

	const masterKey = hexToBytes(env.MASTER_ENCRYPTION_KEY);
	const secretBase32 = await aesGcmDecrypt(masterKey, prof.twofa_totp_secret, prof.twofa_totp_iv);
	const ok = await verifierTotp(secretBase32, body.code);
	if (!ok) return jsonErr('Code incorrect', 401, 'BAD_CODE');

	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		'UPDATE profs SET twofa_methode = ?, twofa_setup_at = ? WHERE id = ?'
	)
		.bind('totp', now, prof.id)
		.run();

	const meta = extraireMetadonneesRequete(request);
	await ecrireAudit(env, {
		prof_id: prof.id,
		action: '2fa_setup',
		ip_pays: meta.ip_pays,
		user_agent: meta.user_agent,
		meta: { methode: 'totp' }
	});

	// Émet un JWT complet (2FA validée)
	const { access_token, expire_in } = await emettreJwt(env, prof.id, true);
	const session = await creerSession(env, prof.id, meta.ip_pays, meta.user_agent);
	await marquerConnexionReussie(env, prof.id);

	return jsonOk({
		ok: true,
		access_token,
		refresh_token: session.refresh_token,
		expire_in,
		...wrapUserPayload(prof)
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/prof/2fa/email/request
// ═══════════════════════════════════════════════════════════════════════════

export async function handle2faEmailRequest(request: Request, env: Env): Promise<Response> {
	const cfg = verifierConfig(env);
	if (cfg) return cfg;
	if (request.method !== 'POST') return jsonErr('Méthode non autorisée', 405);

	const auth = await authentifier(request, env, false);
	if (auth instanceof Response) return auth;
	const { prof } = auth;

	const code = genererCode6Chiffres();
	await creer2faToken(env, prof.id, code, 'email');

	await envoyerCode2faEmail(env, prof.email, prof.nom_affiche, code);

	return jsonOk({
		ok: true,
		message: 'Code envoyé à votre courriel (valide 5 min).'
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/prof/2fa/verify
// ═══════════════════════════════════════════════════════════════════════════

export async function handle2faVerify(request: Request, env: Env): Promise<Response> {
	const cfg = verifierConfig(env);
	if (cfg) return cfg;
	if (request.method !== 'POST') return jsonErr('Méthode non autorisée', 405);

	const auth = await authentifier(request, env, false);
	if (auth instanceof Response) return auth;
	const { prof } = auth;

	let body: { code?: string };
	try { body = await request.json(); }
	catch { return jsonErr('JSON invalide', 400); }
	if (!body.code || !/^\d{6}$/.test(body.code)) {
		return jsonErr('Code 6 chiffres requis', 400);
	}

	const meta = extraireMetadonneesRequete(request);
	let ok = false;

	if (prof.twofa_methode === 'totp') {
		if (!prof.twofa_totp_secret || !prof.twofa_totp_iv) {
			return jsonErr('2FA mal configurée', 500, 'NO_TOTP');
		}
		const masterKey = hexToBytes(env.MASTER_ENCRYPTION_KEY);
		const secret = await aesGcmDecrypt(masterKey, prof.twofa_totp_secret, prof.twofa_totp_iv);
		ok = await verifierTotp(secret, body.code);
	} else if (prof.twofa_methode === 'email' || prof.twofa_methode === 'sms') {
		const r = await verifier2faToken(env, prof.id, body.code);
		ok = r.ok;
	} else {
		return jsonErr('2FA non configurée. Appelez /2fa/setup.', 400, 'NOT_CONFIGURED');
	}

	if (!ok) {
		await ecrireAudit(env, {
			prof_id: prof.id,
			action: '2fa_echec',
			ip_pays: meta.ip_pays,
			user_agent: meta.user_agent
		});
		return jsonErr('Code incorrect', 401, 'BAD_CODE');
	}

	// 2FA validée → JWT complet + refresh token
	const { access_token, expire_in } = await emettreJwt(env, prof.id, true);
	const session = await creerSession(env, prof.id, meta.ip_pays, meta.user_agent);
	await marquerConnexionReussie(env, prof.id);

	await ecrireAudit(env, {
		prof_id: prof.id,
		action: 'login_success',
		ip_pays: meta.ip_pays,
		user_agent: meta.user_agent,
		meta: { methode_2fa: prof.twofa_methode }
	});

	return jsonOk({
		ok: true,
		access_token,
		refresh_token: session.refresh_token,
		expire_in,
		...wrapUserPayload(prof)
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/prof/token/refresh
// ═══════════════════════════════════════════════════════════════════════════

export async function handleRefresh(request: Request, env: Env): Promise<Response> {
	const cfg = verifierConfig(env);
	if (cfg) return cfg;
	if (request.method !== 'POST') return jsonErr('Méthode non autorisée', 405);

	let body: { refresh_token?: string };
	try { body = await request.json(); }
	catch { return jsonErr('JSON invalide', 400); }
	if (!body.refresh_token) return jsonErr('refresh_token requis', 400);

	const session = await trouverSessionParRefreshToken(env, body.refresh_token);
	if (!session) return jsonErr('Refresh token invalide ou expiré', 401, 'BAD_REFRESH');

	const prof = await trouverProfParId(env, session.prof_id);
	if (!prof || prof.statut !== 'actif') {
		await revoquerSession(env, session.id);
		return jsonErr('Compte indisponible', 401, 'PROF_GONE');
	}

	const { access_token, expire_in } = await emettreJwt(env, prof.id, true);

	// Met à jour derniere_utilisation
	await env.DB.prepare(
		'UPDATE prof_sessions SET derniere_utilisation = ? WHERE id = ?'
	)
		.bind(Math.floor(Date.now() / 1000), session.id)
		.run();

	return jsonOk({ ok: true, access_token, expire_in, ...wrapUserPayload(prof) });
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/prof/logout
// ═══════════════════════════════════════════════════════════════════════════

export async function handleLogout(request: Request, env: Env): Promise<Response> {
	const cfg = verifierConfig(env);
	if (cfg) return cfg;
	if (request.method !== 'POST') return jsonErr('Méthode non autorisée', 405);

	let body: { refresh_token?: string };
	try { body = await request.json(); }
	catch { body = {}; }

	if (body.refresh_token) {
		const session = await trouverSessionParRefreshToken(env, body.refresh_token);
		if (session) {
			await revoquerSession(env, session.id);
			await ecrireAudit(env, {
				prof_id: session.prof_id,
				action: 'logout',
				...extraireMetadonneesRequete(request)
			});
		}
	}
	return jsonOk({ ok: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE : GET /api/prof/me
// ═══════════════════════════════════════════════════════════════════════════

export async function handleMe(request: Request, env: Env): Promise<Response> {
	const cfg = verifierConfig(env);
	if (cfg) return cfg;
	const auth = await authentifier(request, env, true);
	if (auth instanceof Response) return auth;
	const { prof } = auth;

	// Sprint PB1 item 11.1 (PB1-DEC-10 option A) : auto-création des liens
	// admin pour les forfaits achetés avec cet email. Best-effort, ne casse
	// pas /me si échec.
	try {
		const { autoCreerLiensAdmin } = await import('./admin-ecole');
		await autoCreerLiensAdmin(env, prof.id, prof.email);
	} catch (err) {
		console.error('[handleMe] autoCreerLiensAdmin echec :', err);
	}

	return jsonOk({
		ok: true,
		prof: {
			id: prof.id,
			email: prof.email,
			nom_affiche: prof.nom_affiche,
			nom_ecole: prof.nom_ecole,
			ville: prof.ville,
			code_classe: prof.code_classe,
			twofa_methode: prof.twofa_methode,
			twofa_configure: prof.twofa_methode !== 'pending',
			derniere_connexion: prof.derniere_connexion,
			created_at: prof.created_at
		}
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE : POST /api/prof/dek/upgrade  (Sprint D4)
// ═══════════════════════════════════════════════════════════════════════════
// Re-wrap la DEK avec un nouveau KDF (typiquement passage PBKDF2 → Argon2id).
// Le client envoie un nouveau wrap dérivé du mdp avec le KDF cible. Le serveur
// stocke en CAS-style (WHERE dek_user_version = ?) pour éviter races.
//
// Anti-downgrade : on refuse Argon2id → PBKDF2.
//
// Body :
//   {
//     dek_wrap_user: string,   // base64
//     dek_iv_user: string,     // base64 (IV AES-GCM 12 octets)
//     dek_salt_user: string,   // base64
//     dek_kdf: string,         // 'argon2id_m64_t3_p1' ou 'pbkdf2_sha256_100k'
//     dek_kdf_params?: number, // PBKDF2 : iterations ; Argon2id : ignoré
//     expected_version: number // version courante (CAS)
//   }
// Réponse : { ok: true, new_version: number }

interface DekUpgradeBody {
	dek_wrap_user?: string;
	dek_iv_user?: string;
	dek_salt_user?: string;
	dek_kdf?: string;
	dek_kdf_params?: number;
	expected_version?: number;
}

// KDFs reconnus, du plus faible au plus fort. Index = niveau de sécurité.
const KDF_RANK: Record<string, number> = {
	'pbkdf2_sha256_100k': 1,
	'argon2id_m64_t3_p1': 2,
};

export async function handleDekUpgrade(request: Request, env: Env): Promise<Response> {
	const cfg = verifierConfig(env);
	if (cfg) return cfg;
	if (request.method !== 'POST') return jsonErr('Méthode non autorisée', 405);

	const auth = await authentifier(request, env, true);
	if (auth instanceof Response) return auth;
	const { prof } = auth;

	let body: DekUpgradeBody;
	try { body = await request.json(); }
	catch { return jsonErr('JSON invalide', 400); }

	// Validation champs obligatoires
	if (
		typeof body.dek_wrap_user !== 'string' ||
		typeof body.dek_iv_user !== 'string' ||
		typeof body.dek_salt_user !== 'string' ||
		typeof body.dek_kdf !== 'string' ||
		typeof body.expected_version !== 'number'
	) {
		return jsonErr('Champs manquants', 400, 'BAD_BODY');
	}

	// Validation base64 + longueurs (mêmes limites que signup)
	const B64 = /^[A-Za-z0-9+/=]+$/;
	if (!B64.test(body.dek_wrap_user) || body.dek_wrap_user.length > 256) return jsonErr('dek_wrap_user invalide', 400, 'BAD_WRAP');
	if (!B64.test(body.dek_iv_user) || body.dek_iv_user.length > 64) return jsonErr('dek_iv_user invalide', 400, 'BAD_IV');
	if (!B64.test(body.dek_salt_user) || body.dek_salt_user.length > 64) return jsonErr('dek_salt_user invalide', 400, 'BAD_SALT');

	// Validation KDF connu
	const newRank = KDF_RANK[body.dek_kdf];
	if (!newRank) return jsonErr('KDF inconnu', 400, 'BAD_KDF');

	// Anti-downgrade : interdit de passer à un KDF plus faible.
	// dek_kdf=NULL en DB = legacy (équivalent rang 0) → tout upgrade OK.
	const currentKdf = prof.dek_kdf;
	if (currentKdf) {
		const currentRank = KDF_RANK[currentKdf] ?? 0;
		if (newRank < currentRank) {
			return jsonErr('Downgrade KDF interdit', 400, 'KDF_DOWNGRADE');
		}
	}

	// Validation paramètres spécifiques (PBKDF2 only)
	let iterUser: number | null = null;
	if (body.dek_kdf === 'pbkdf2_sha256_100k') {
		if (
			typeof body.dek_kdf_params !== 'number' ||
			!Number.isInteger(body.dek_kdf_params) ||
			body.dek_kdf_params < 50_000 ||
			body.dek_kdf_params > 1_000_000
		) {
			return jsonErr('dek_kdf_params invalide pour PBKDF2', 400, 'BAD_PARAMS');
		}
		iterUser = body.dek_kdf_params;
	} else if (body.dek_kdf === 'argon2id_m64_t3_p1') {
		// Paramètres figés dans le nom du KDF. iter_user devient inutilisé
		// mais on garde la colonne non-NULL pour rester cohérent : on stocke 0.
		iterUser = 0;
	}

	// Mise à jour CAS-style — on incrémente la version pour invalider tout autre
	// onglet/session qui tenterait un upgrade en parallèle.
	const newVersion = body.expected_version + 1;

	const result = await env.DB.prepare(
		`UPDATE profs
		   SET dek_wrap_user = ?,
		       dek_iv_user = ?,
		       dek_salt_user = ?,
		       dek_iter_user = ?,
		       dek_kdf = ?,
		       dek_user_version = ?
		 WHERE id = ? AND dek_user_version = ?`
	)
		.bind(
			body.dek_wrap_user,
			body.dek_iv_user,
			body.dek_salt_user,
			iterUser,
			body.dek_kdf,
			newVersion,
			prof.id,
			body.expected_version
		)
		.run();

	if (!result.success || (result.meta?.changes ?? 0) === 0) {
		// CAS a échoué : la version a changé entre temps (autre client). Le client
		// doit refaire /me et retenter.
		return jsonErr('Version DEK obsolète, rafraîchir et réessayer', 409, 'VERSION_MISMATCH');
	}

	// Audit (best-effort)
	try {
		await ecrireAudit(env, {
			prof_id: prof.id,
			action: 'dek_kdf_upgrade',
			cible: prof.id,
			meta: { from: currentKdf ?? null, to: body.dek_kdf, new_version: newVersion }
		});
	} catch (e) {
		console.error('[audit dek_kdf_upgrade]', e);
	}

	return jsonOk({ ok: true, new_version: newVersion });
}

// ═══════════════════════════════════════════════════════════════════════════
// EMAILS — Templates
// ═══════════════════════════════════════════════════════════════════════════

async function envoyerEmailConfirmationSignup(
	env: Env,
	email: string,
	nom: string,
	lienConfirm: string,
	codeClasse: string
): Promise<void> {
	const sujet = 'Mathéquête — Confirmez votre compte enseignant';
	const html = `
<!DOCTYPE html>
<html lang="fr"><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #2563eb;">Bienvenue dans Mathéquête, ${escapeHtml(nom)} !</h1>
  <p>Merci d'avoir créé votre compte enseignant. Pour activer votre compte, cliquez sur le lien ci-dessous (valide 15 minutes) :</p>
  <p style="text-align: center; margin: 30px 0;">
    <a href="${lienConfirm}" style="background:#2563eb;color:white;padding:14px 28px;text-decoration:none;border-radius:6px;font-weight:bold;">Confirmer mon compte</a>
  </p>
  <p>Ou copiez ce lien : <br><code style="word-break: break-all;">${lienConfirm}</code></p>
  <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
  <h2 style="color: #2563eb;">Votre code de classe</h2>
  <p>Donnez ce code à vos élèves pour qu'ils relient leur application Mathéquête à votre classe :</p>
  <p style="text-align: center; font-size: 28px; font-weight: bold; letter-spacing: 4px; background: #f3f4f6; padding: 16px; border-radius: 8px;">
    ${codeClasse}
  </p>
  <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
  <p style="color: #6b7280; font-size: 14px;">Après confirmation, vous serez invité à configurer votre authentification à deux facteurs (obligatoire pour protéger les données de vos élèves, conformément à la <strong>Loi 25 du Québec</strong>).</p>
  <p style="color: #6b7280; font-size: 12px;">Si vous n'avez pas créé ce compte, ignorez ce courriel — aucune action n'est nécessaire.</p>
</body></html>`;

	await env.DB.prepare(
		`INSERT INTO emails_envoyes (destinataire, sujet, type, envoye_le, statut)
		 VALUES (?, ?, ?, ?, ?)`
	)
		.bind(email, sujet, 'signup_confirm', Math.floor(Date.now() / 1000), 'queued')
		.run();

	try {
		await envoyerEmail(env, { destinataire: email, sujet, html });
	} catch (e) {
		console.error('[email signup]', e);
	}
}

async function envoyerCode2faEmail(
	env: Env,
	email: string,
	nom: string,
	code: string
): Promise<void> {
	const sujet = `Mathéquête — Code de vérification : ${code}`;
	const html = `
<!DOCTYPE html>
<html lang="fr"><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #2563eb;">Code de vérification</h1>
  <p>Bonjour ${escapeHtml(nom)},</p>
  <p>Votre code de vérification à usage unique pour vous connecter :</p>
  <p style="text-align:center; font-size:36px; font-weight:bold; letter-spacing:8px; background:#f3f4f6; padding:20px; border-radius:8px; margin:30px 0;">
    ${code}
  </p>
  <p>Ce code expire dans <strong>5 minutes</strong>. Si vous n'avez pas tenté de vous connecter, changez immédiatement votre mot de passe.</p>
</body></html>`;

	try {
		await envoyerEmail(env, { destinataire: email, sujet, html });
	} catch (e) {
		console.error('[email 2fa]', e);
	}
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers Sprint D3 — wrap DEK côté client (hybride)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Valide les 4 champs dek_*_user du SignupBody si présents.
 * Retourne true si valides, true si absents (optionnels), false si invalides.
 *
 * Coté wire on attend du base64 standard (chars [A-Za-z0-9+/=]).
 */
function validerWrapUserSignup(body: SignupBody): boolean {
	const present =
		body.dek_wrap_user !== undefined ||
		body.dek_iv_user !== undefined ||
		body.dek_salt_user !== undefined ||
		body.dek_iter_user !== undefined;
	if (!present) return true; // rétro-compat : client ancien sans wrap

	// Si l'un est présent, les 4 doivent être présents et valides
	if (
		body.dek_wrap_user === undefined ||
		body.dek_iv_user === undefined ||
		body.dek_salt_user === undefined ||
		body.dek_iter_user === undefined
	) return false;

	const B64 = /^[A-Za-z0-9+/=]+$/;
	if (!B64.test(body.dek_wrap_user) || body.dek_wrap_user.length > 256) return false;
	if (!B64.test(body.dek_iv_user) || body.dek_iv_user.length > 64) return false;
	if (!B64.test(body.dek_salt_user) || body.dek_salt_user.length > 64) return false;

	// Sprint D4 : tolère dek_iter_user = 0 si KDF Argon2id (params figes
	// dans le nom). Pour PBKDF2 ou KDF absent, on impose >= 50000.
	if (typeof body.dek_iter_user !== 'number' || !Number.isInteger(body.dek_iter_user)) return false;
	const kdf = body.dek_kdf;
	if (kdf === 'argon2id_m64_t3_p1') {
		if (body.dek_iter_user !== 0) return false; // strict pour eviter abus
	} else {
		// PBKDF2 ou KDF absent (legacy = PBKDF2)
		if (
			body.dek_iter_user < 50000 ||      // anti-attaque par réduction
			body.dek_iter_user > 1_000_000     // anti-DoS
		) return false;
	}

	// Si dek_kdf est présent, il doit être dans la liste connue
	if (kdf !== undefined && kdf !== 'pbkdf2_sha256_100k' && kdf !== 'argon2id_m64_t3_p1') return false;

	return true;
}

/**
 * Construit le sous-objet renvoyé au client après login complet pour qu'il
 * puisse déchiffrer sa DEK avec K_user dérivée du mdp. Si le prof a été créé
 * avant la migration 0006 ou n'a pas encore wrappé côté client, on renvoie
 * dek_user_version = 0 pour signaler au client qu'il doit faire un wrap
 * transparent au premier login.
 */
function wrapUserPayload(prof: ProfRow): {
	dek_wrap_user: string | null;
	dek_iv_user: string | null;
	dek_salt_user: string | null;
	dek_iter_user: number | null;
	dek_user_version: number;
	dek_kdf: string | null;
} {
	return {
		dek_wrap_user: prof.dek_wrap_user,
		dek_iv_user: prof.dek_iv_user,
		dek_salt_user: prof.dek_salt_user,
		dek_iter_user: prof.dek_iter_user,
		dek_user_version: prof.dek_user_version,
		dek_kdf: prof.dek_kdf,
	};
}
