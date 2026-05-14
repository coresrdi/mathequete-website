/**
 * Mathéquête — Endpoints stats élèves (Sprint C)
 *
 * POST /api/stats/push
 *   Body: { code_brut, device_hash, eleves: [...] }
 *   Action: UPSERT batch dans stats_eleves (ON CONFLICT DO UPDATE)
 *   Auth: HMAC via verifierCodeBrut + vérif device_hash lié à la licence
 *   Retour: { success: true, count: number }
 *
 * GET /api/stats/classe/:licence_id?code_brut=XXX&device_hash=YYY
 *   Action: SELECT * FROM stats_eleves WHERE licence_id = ? ORDER BY derniere_session_at DESC LIMIT 500
 *   Auth: même vérif HMAC + device_hash + cross-check licence_id vs code_brut
 *   Retour: { success: true, eleves: [...] }
 */

import type { Env } from './types';
import { verifierCodeBrut } from './generate-codes';

/* ===== Types ===== */

interface EleveStatsPush {
	eleve_id: string;
	prenom?: string;
	total_examens: number;
	total_reussites: number;
	total_echecs: number;
	iles_completees: number;
	derniere_session_at?: number;
	payload?: unknown;
}

interface StatsPushBody {
	code_brut?: string;
	device_hash?: string;
	eleves?: EleveStatsPush[];
}

/* ===== POST /api/stats/push ===== */

export async function handleStatsPush(
	request: Request,
	env: Env
): Promise<Response> {
	if (request.method !== 'POST') {
		return jsonError('Method not allowed', 405);
	}

	let body: StatsPushBody;
	try {
		body = await request.json();
	} catch {
		return jsonError('JSON invalide', 400);
	}

	const codeBrut = (body.code_brut ?? '').trim();
	const deviceHash = (body.device_hash ?? '').trim();
	const eleves = body.eleves;

	if (!codeBrut || !deviceHash) {
		return jsonError('code_brut et device_hash requis', 400);
	}

	if (!Array.isArray(eleves) || eleves.length === 0) {
		return jsonError('eleves requis (tableau non vide)', 400);
	}

	if (eleves.length > 500) {
		return jsonError('Maximum 500 élèves par push', 400);
	}

	// 1. Vérifier HMAC du code
	const verif = await verifierCodeBrut(codeBrut, env.HMAC_SECRET_KEY);
	if (!verif.valide || !verif.data) {
		return jsonError('Code invalide ou signature corrompue', 400);
	}
	const licenceId = verif.data.id;

	// 2. Vérifier que le device_hash est bien lié à cette licence
	try {
		const activation = await env.DB.prepare(
			`SELECT id FROM codes_actives WHERE licence_id = ? AND device_hash = ? AND statut = 'active'`
		).bind(licenceId, deviceHash).first<{ id: number }>();

		if (!activation) {
			return jsonError(
				'device_hash non autorisé pour cette licence — appareil non reconnu',
				403
			);
		}
	} catch (err) {
		console.error('[stats/push] erreur vérif device_hash :', err);
		return jsonResponse({ success: false, raison: 'db_error' }, 500);
	}

	// 3. UPSERT batch
	const now = Math.floor(Date.now() / 1000);
	const statements = eleves.map((eleve) => {
		const eleveId = String(eleve.eleve_id ?? '').trim();
		if (!eleveId) return null;

		const prenom = eleve.prenom ? String(eleve.prenom).slice(0, 80) : null;
		const totalExamens = Math.max(0, Number(eleve.total_examens) || 0);
		const totalReussites = Math.max(0, Number(eleve.total_reussites) || 0);
		const totalEchecs = Math.max(0, Number(eleve.total_echecs) || 0);
		const ilesCompletees = Math.max(0, Number(eleve.iles_completees) || 0);
		const derniereSessionAt = eleve.derniere_session_at
			? Number(eleve.derniere_session_at)
			: null;
		const payloadJson = eleve.payload != null
			? JSON.stringify(eleve.payload)
			: null;

		return env.DB.prepare(`
			INSERT INTO stats_eleves (
				licence_id, eleve_id, prenom,
				total_examens, total_reussites, total_echecs, iles_completees,
				derniere_session_at, push_at, payload_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(licence_id, eleve_id) DO UPDATE SET
				prenom              = excluded.prenom,
				total_examens       = excluded.total_examens,
				total_reussites     = excluded.total_reussites,
				total_echecs        = excluded.total_echecs,
				iles_completees     = excluded.iles_completees,
				derniere_session_at = excluded.derniere_session_at,
				push_at             = excluded.push_at,
				payload_json        = excluded.payload_json
		`).bind(
			licenceId, eleveId, prenom,
			totalExamens, totalReussites, totalEchecs, ilesCompletees,
			derniereSessionAt, now, payloadJson
		);
	}).filter((s): s is D1PreparedStatement => s !== null);

	if (statements.length === 0) {
		return jsonError('Aucun élève valide dans le payload', 400);
	}

	try {
		await env.DB.batch(statements);
	} catch (err) {
		console.error('[stats/push] erreur batch UPSERT :', err);
		return jsonResponse({ success: false, raison: 'db_error' }, 500);
	}

	return jsonResponse({ success: true, count: statements.length });
}

/* ===== GET /api/stats/classe/:licence_id ===== */

export async function handleStatsClasseGet(
	request: Request,
	env: Env,
	licenceIdParam: string
): Promise<Response> {
	if (request.method !== 'GET') {
		return jsonError('Method not allowed', 405);
	}

	const url = new URL(request.url);
	const codeBrut = (url.searchParams.get('code_brut') ?? '').trim();
	const deviceHash = (url.searchParams.get('device_hash') ?? '').trim();
	const licenceId = (licenceIdParam ?? '').trim();

	if (!codeBrut || !deviceHash) {
		return jsonError('code_brut et device_hash requis', 400);
	}

	if (!licenceId) {
		return jsonError('licence_id requis', 400);
	}

	// 1. Vérifier HMAC du code
	const verif = await verifierCodeBrut(codeBrut, env.HMAC_SECRET_KEY);
	if (!verif.valide || !verif.data) {
		return jsonError('Code invalide ou signature corrompue', 400);
	}

	// 2. S'assurer que code_brut correspond bien à licence_id URL param
	if (verif.data.id !== licenceId) {
		return jsonError('code_brut ne correspond pas à cette licence_id', 403);
	}

	// 3. Vérifier que le device_hash est lié à cette licence
	try {
		const activation = await env.DB.prepare(
			`SELECT id FROM codes_actives WHERE licence_id = ? AND device_hash = ? AND statut = 'active'`
		).bind(licenceId, deviceHash).first<{ id: number }>();

		if (!activation) {
			return jsonError(
				'device_hash non autorisé pour cette licence — appareil non reconnu',
				403
			);
		}
	} catch (err) {
		console.error('[stats/classe] erreur vérif device_hash :', err);
		return jsonResponse({ success: false, raison: 'db_error' }, 500);
	}

	// 4. Récupérer les stats
	try {
		const { results } = await env.DB.prepare(`
			SELECT
				id, eleve_id, prenom,
				total_examens, total_reussites, total_echecs, iles_completees,
				derniere_session_at, push_at, payload_json
			FROM stats_eleves
			WHERE licence_id = ?
			ORDER BY derniere_session_at DESC
			LIMIT 500
		`).bind(licenceId).all<{
			id: number;
			eleve_id: string;
			prenom: string | null;
			total_examens: number;
			total_reussites: number;
			total_echecs: number;
			iles_completees: number;
			derniere_session_at: number | null;
			push_at: number;
			payload_json: string | null;
		}>();

		return jsonResponse({ success: true, eleves: results });
	} catch (err) {
		console.error('[stats/classe] erreur SELECT :', err);
		return jsonResponse({ success: false, raison: 'db_error' }, 500);
	}
}

/* ===== Helpers locaux (dupliqués pour isolation module) ===== */

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*'
		}
	});
}

function jsonError(message: string, status: number): Response {
	return jsonResponse({ success: false, raison: message }, status);
}
