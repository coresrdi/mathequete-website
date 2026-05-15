/**
 * Sprint D3 — Routes CRUD élèves chiffrés.
 *
 * Toutes les opérations PII enfants se font sur BLOB chiffrés par la
 * DEK du prof. Le serveur N'A PAS la DEK en cache après signup. Les
 * routes ci-dessous ne font donc QUE :
 *
 *   1. Vérifier JWT post-2FA (auth complète)
 *   2. Vérifier que le prof est propriétaire de l'élève (prof_id = sub)
 *   3. Stocker ou retourner les BLOB tels quels
 *   4. Écrire une ligne d'audit Loi 25
 *
 * Le serveur N'A AUCUN MOYEN de lire prenom_chiffre/nom_chiffre/stats_chiffre.
 * Tout déchiffrement se fait côté client (app prof Tauri).
 *
 * Routes implémentées :
 *
 *   POST   /api/prof/eleves                → créer un élève
 *   GET    /api/prof/eleves                → liste des élèves du prof connecté
 *   GET    /api/prof/eleves/:id            → détail d'un élève
 *   PATCH  /api/prof/eleves/:id            → modifier (prénom, nom, archive)
 *   DELETE /api/prof/eleves/:id            → soft delete (purge après 30j)
 *
 * Format des champs chiffrés sur le wire : base64 du ciphertext et de l'IV.
 * Stocké en DB SQLite comme BLOB (D1 accepte Uint8Array via .bind).
 */

import type { Env } from './types';
import {
	ecrireAudit,
	extraireMetadonneesRequete,
	jsonErr,
	jsonOk,
} from './auth-prof';
import { authentifier } from './prof-routes';
import {
	base64ToBytes,
	bytesToBase64,
	bytesToHex,
} from './crypto-prof';

// ─── Helpers spécifiques ────────────────────────────────────────────────────

/**
 * Convertit un Uint8Array en BLOB pour D1. D1 accepte ArrayBuffer ou
 * Uint8Array dans .bind() et le stocke comme BLOB.
 */
function toBlob(b64: string | null | undefined): Uint8Array | null {
	if (!b64) return null;
	return base64ToBytes(b64);
}

/**
 * Convertit un BLOB lu de D1 (retourné comme ArrayBuffer) en base64.
 */
function fromBlob(value: unknown): string | null {
	if (value == null) return null;
	if (value instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(value));
	if (value instanceof Uint8Array) return bytesToBase64(value);
	// Pour D1 SQLite : parfois renvoyé comme objet { type: 'Buffer', data: [...] }
	if (typeof value === 'object' && value !== null && 'data' in value) {
		const data = (value as { data: number[] }).data;
		if (Array.isArray(data)) return bytesToBase64(new Uint8Array(data));
	}
	return null;
}

// ─── Types DTO sur le wire ──────────────────────────────────────────────────

interface EleveCreateBody {
	prenom_chiffre?: string;    // base64
	prenom_iv?: string;         // base64
	nom_chiffre?: string;       // base64 (optionnel)
	nom_iv?: string;            // base64 (optionnel)
	code_eleve_hash?: string;   // hex SHA-256 du code court
}

interface EleveUpdateBody {
	prenom_chiffre?: string;
	prenom_iv?: string;
	nom_chiffre?: string | null;
	nom_iv?: string | null;
	archive?: boolean;
}

interface EleveDto {
	id: string;
	prenom_chiffre: string;
	prenom_iv: string;
	nom_chiffre: string | null;
	nom_iv: string | null;
	code_eleve_hash: string | null;
	stats_chiffre: string | null;
	stats_iv: string | null;
	stats_push_at: number | null;
	stats_version: number;
	created_at: number;
	archive: number;
}

// ─── Validation ─────────────────────────────────────────────────────────────

const MAX_CIPHERTEXT_B64 = 4096;   // 4 KB de prénom chiffré = largement assez
const MAX_STATS_B64      = 65536;  // 64 KB de stats JSON chiffré

function validerB64(value: unknown, max: number): string | null {
	if (typeof value !== 'string') return null;
	if (value.length === 0 || value.length > max) return null;
	if (!/^[A-Za-z0-9+/=]+$/.test(value)) return null;
	return value;
}

// ─── ROUTE : POST /api/prof/eleves ──────────────────────────────────────────

export async function handleEleveCreate(request: Request, env: Env): Promise<Response> {
	if (request.method !== 'POST') return jsonErr('Méthode non autorisée', 405);

	const auth = await authentifier(request, env, true);
	if (auth instanceof Response) return auth;
	const { prof } = auth;

	let body: EleveCreateBody;
	try { body = await request.json(); }
	catch { return jsonErr('JSON invalide', 400); }

	const prenom_chiffre = validerB64(body.prenom_chiffre, MAX_CIPHERTEXT_B64);
	const prenom_iv      = validerB64(body.prenom_iv, 64);
	if (!prenom_chiffre || !prenom_iv) {
		return jsonErr('Prénom chiffré requis', 400, 'BAD_PRENOM');
	}

	// nom optionnel (minimisation Loi 25)
	const nom_chiffre = body.nom_chiffre ? validerB64(body.nom_chiffre, MAX_CIPHERTEXT_B64) : null;
	const nom_iv      = body.nom_iv ? validerB64(body.nom_iv, 64) : null;
	if ((nom_chiffre && !nom_iv) || (!nom_chiffre && nom_iv)) {
		return jsonErr('Nom chiffré et IV doivent être fournis ensemble', 400, 'BAD_NOM');
	}

	const code_eleve_hash = body.code_eleve_hash
		? (/^[0-9a-f]{64}$/.test(body.code_eleve_hash) ? body.code_eleve_hash : null)
		: null;

	const id = 'e_' + bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
	const now = Math.floor(Date.now() / 1000);

	await env.DB.prepare(
		`INSERT INTO eleves_chiffres (
			id, prof_id,
			prenom_chiffre, prenom_iv, nom_chiffre, nom_iv,
			code_eleve_hash,
			created_at, archive
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
	)
		.bind(
			id,
			prof.id,
			toBlob(prenom_chiffre),
			toBlob(prenom_iv),
			toBlob(nom_chiffre),
			toBlob(nom_iv),
			code_eleve_hash,
			now,
		)
		.run();

	const meta = extraireMetadonneesRequete(request);
	await ecrireAudit(env, {
		prof_id: prof.id,
		action: 'eleve_create',
		cible: id,
		ip_pays: meta.ip_pays,
		user_agent: meta.user_agent,
		meta: { has_nom: nom_chiffre !== null }
	});

	return jsonOk({ ok: true, id, created_at: now });
}

// ─── ROUTE : GET /api/prof/eleves ───────────────────────────────────────────

export async function handleEleveList(request: Request, env: Env): Promise<Response> {
	if (request.method !== 'GET') return jsonErr('Méthode non autorisée', 405);

	const auth = await authentifier(request, env, true);
	if (auth instanceof Response) return auth;
	const { prof } = auth;

	// Par défaut on liste les actifs ; ?archive=1 pour archivés ; ?archive=all pour tout.
	const url = new URL(request.url);
	const filtre = url.searchParams.get('archive');

	let sql = 'SELECT * FROM eleves_chiffres WHERE prof_id = ? AND supprime_le IS NULL';
	if (filtre === '1') sql += ' AND archive = 1';
	else if (filtre !== 'all') sql += ' AND archive = 0';
	sql += ' ORDER BY created_at DESC LIMIT 500';

	const rows = await env.DB.prepare(sql).bind(prof.id).all<Record<string, unknown>>();
	const eleves: EleveDto[] = (rows.results ?? []).map((r) => mapRowToDto(r));

	const meta = extraireMetadonneesRequete(request);
	await ecrireAudit(env, {
		prof_id: prof.id,
		action: 'eleve_list',
		cible: null,
		ip_pays: meta.ip_pays,
		user_agent: meta.user_agent,
		meta: { count: eleves.length, filtre: filtre ?? 'actifs' }
	});

	return jsonOk({ ok: true, eleves });
}

// ─── ROUTE : GET /api/prof/eleves/:id ───────────────────────────────────────

export async function handleEleveGet(request: Request, env: Env, id: string): Promise<Response> {
	if (request.method !== 'GET') return jsonErr('Méthode non autorisée', 405);

	const auth = await authentifier(request, env, true);
	if (auth instanceof Response) return auth;
	const { prof } = auth;

	const row = await env.DB.prepare(
		'SELECT * FROM eleves_chiffres WHERE id = ? AND prof_id = ? AND supprime_le IS NULL LIMIT 1'
	)
		.bind(id, prof.id)
		.first<Record<string, unknown>>();

	if (!row) return jsonErr('Élève introuvable', 404, 'NOT_FOUND');

	const meta = extraireMetadonneesRequete(request);
	await ecrireAudit(env, {
		prof_id: prof.id,
		action: 'eleve_view',
		cible: id,
		ip_pays: meta.ip_pays,
		user_agent: meta.user_agent
	});

	return jsonOk({ ok: true, eleve: mapRowToDto(row) });
}

// ─── ROUTE : PATCH /api/prof/eleves/:id ─────────────────────────────────────

export async function handleEleveUpdate(request: Request, env: Env, id: string): Promise<Response> {
	if (request.method !== 'PATCH') return jsonErr('Méthode non autorisée', 405);

	const auth = await authentifier(request, env, true);
	if (auth instanceof Response) return auth;
	const { prof } = auth;

	let body: EleveUpdateBody;
	try { body = await request.json(); }
	catch { return jsonErr('JSON invalide', 400); }

	const existe = await env.DB.prepare(
		'SELECT id FROM eleves_chiffres WHERE id = ? AND prof_id = ? AND supprime_le IS NULL LIMIT 1'
	).bind(id, prof.id).first<{ id: string }>();
	if (!existe) return jsonErr('Élève introuvable', 404, 'NOT_FOUND');

	// Construction du SET dynamique
	const sets: string[] = [];
	const binds: unknown[] = [];

	if (body.prenom_chiffre !== undefined && body.prenom_iv !== undefined) {
		const pc = validerB64(body.prenom_chiffre, MAX_CIPHERTEXT_B64);
		const pi = validerB64(body.prenom_iv, 64);
		if (!pc || !pi) return jsonErr('Prénom chiffré invalide', 400, 'BAD_PRENOM');
		sets.push('prenom_chiffre = ?', 'prenom_iv = ?');
		binds.push(toBlob(pc), toBlob(pi));
	}

	if (body.nom_chiffre !== undefined) {
		if (body.nom_chiffre === null) {
			sets.push('nom_chiffre = NULL', 'nom_iv = NULL');
		} else {
			const nc = validerB64(body.nom_chiffre, MAX_CIPHERTEXT_B64);
			const ni = body.nom_iv ? validerB64(body.nom_iv, 64) : null;
			if (!nc || !ni) return jsonErr('Nom chiffré ou IV invalide', 400, 'BAD_NOM');
			sets.push('nom_chiffre = ?', 'nom_iv = ?');
			binds.push(toBlob(nc), toBlob(ni));
		}
	}

	if (typeof body.archive === 'boolean') {
		sets.push('archive = ?');
		binds.push(body.archive ? 1 : 0);
	}

	if (sets.length === 0) return jsonErr('Aucun champ à modifier', 400, 'NO_CHANGE');

	binds.push(id, prof.id);
	await env.DB.prepare(
		`UPDATE eleves_chiffres SET ${sets.join(', ')} WHERE id = ? AND prof_id = ?`
	).bind(...binds).run();

	const meta = extraireMetadonneesRequete(request);
	await ecrireAudit(env, {
		prof_id: prof.id,
		action: 'eleve_update',
		cible: id,
		ip_pays: meta.ip_pays,
		user_agent: meta.user_agent,
		meta: {
			modif_prenom: body.prenom_chiffre !== undefined,
			modif_nom: body.nom_chiffre !== undefined,
			modif_archive: typeof body.archive === 'boolean'
		}
	});

	return jsonOk({ ok: true });
}

// ─── ROUTE : DELETE /api/prof/eleves/:id ────────────────────────────────────

export async function handleEleveDelete(request: Request, env: Env, id: string): Promise<Response> {
	if (request.method !== 'DELETE') return jsonErr('Méthode non autorisée', 405);

	const auth = await authentifier(request, env, true);
	if (auth instanceof Response) return auth;
	const { prof } = auth;

	const now = Math.floor(Date.now() / 1000);
	const r = await env.DB.prepare(
		'UPDATE eleves_chiffres SET supprime_le = ? WHERE id = ? AND prof_id = ? AND supprime_le IS NULL'
	).bind(now, id, prof.id).run();

	// D1 .meta.changes nombre de lignes affectées
	const changed = r.meta?.changes ?? 0;
	if (changed === 0) return jsonErr('Élève introuvable', 404, 'NOT_FOUND');

	const meta = extraireMetadonneesRequete(request);
	await ecrireAudit(env, {
		prof_id: prof.id,
		action: 'eleve_delete',
		cible: id,
		ip_pays: meta.ip_pays,
		user_agent: meta.user_agent,
		meta: { soft_delete: true, purge_apres_jours: 30 }
	});

	return jsonOk({ ok: true });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function mapRowToDto(r: Record<string, unknown>): EleveDto {
	return {
		id: String(r.id),
		prenom_chiffre: fromBlob(r.prenom_chiffre) ?? '',
		prenom_iv: fromBlob(r.prenom_iv) ?? '',
		nom_chiffre: fromBlob(r.nom_chiffre),
		nom_iv: fromBlob(r.nom_iv),
		code_eleve_hash: r.code_eleve_hash != null ? String(r.code_eleve_hash) : null,
		stats_chiffre: fromBlob(r.stats_chiffre),
		stats_iv: fromBlob(r.stats_iv),
		stats_push_at: r.stats_push_at != null ? Number(r.stats_push_at) : null,
		stats_version: Number(r.stats_version ?? 1),
		created_at: Number(r.created_at),
		archive: Number(r.archive ?? 0)
	};
}
