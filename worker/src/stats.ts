/**
 * Mathéquête — Endpoints stats élèves (Sprint C + D5 chiffrement at-rest)
 *
 * POST /api/stats/push
 *   Body: { code_brut, device_hash, eleves: [...] }
 *   Action: UPSERT batch dans stats_eleves (ON CONFLICT DO UPDATE)
 *   Auth: HMAC via verifierCodeBrut + vérif device_hash lié à la licence
 *   D5: payload est chiffré at-rest (AES-GCM avec K_stats = HKDF(MASTER, licence_id))
 *   Retour: { success: true, count: number }
 *
 * GET /api/stats/classe/:licence_id?code_brut=XXX&device_hash=YYY
 *   Action: SELECT * FROM stats_eleves WHERE licence_id = ? ORDER BY derniere_session_at DESC LIMIT 500
 *   Auth: même vérif HMAC + device_hash + cross-check licence_id vs code_brut
 *   D5: déchiffre payload_chiffre si présent, sinon utilise payload_json legacy
 *   Retour: { success: true, eleves: [...] }
 */

import type { Env } from './types';
import { verifierCodeBrut } from './generate-codes';
import {
	chiffrerStatsPayload,
	dechiffrerStatsPayload,
	STATS_KDF_V1
} from './crypto-prof';

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

	// 3. Vérifier que MASTER_ENCRYPTION_KEY est dispo (D5)
	if (!env.MASTER_ENCRYPTION_KEY || env.MASTER_ENCRYPTION_KEY.length < 32) {
		console.error('[stats/push] MASTER_ENCRYPTION_KEY manquant — chiffrement at-rest impossible');
		return jsonResponse({ success: false, raison: 'server_misconfigured' }, 500);
	}

	// 4. Préparer les UPSERT (chiffrement at-rest du payload)
	const now = Math.floor(Date.now() / 1000);
	const statements: D1PreparedStatement[] = [];

	for (const eleve of eleves) {
		const eleveId = String(eleve.eleve_id ?? '').trim();
		if (!eleveId) continue;

		const prenom = eleve.prenom ? String(eleve.prenom).slice(0, 80) : null;
		const totalExamens = Math.max(0, Number(eleve.total_examens) || 0);
		const totalReussites = Math.max(0, Number(eleve.total_reussites) || 0);
		const totalEchecs = Math.max(0, Number(eleve.total_echecs) || 0);
		const ilesCompletees = Math.max(0, Number(eleve.iles_completees) || 0);
		const derniereSessionAt = eleve.derniere_session_at
			? Number(eleve.derniere_session_at)
			: null;

		// D5 : chiffrer le payload si présent
		let payloadChiffre: Uint8Array | null = null;
		let payloadIv: Uint8Array | null = null;
		let payloadKdf: string | null = null;

		if (eleve.payload != null) {
			const payloadJson = JSON.stringify(eleve.payload);
			try {
				const enc = await chiffrerStatsPayload(
					payloadJson,
					env.MASTER_ENCRYPTION_KEY,
					licenceId
				);
				payloadChiffre = enc.ciphertext;
				payloadIv = enc.iv;
				payloadKdf = enc.kdf;
			} catch (err) {
				console.error('[stats/push] erreur chiffrement payload :', err);
				return jsonResponse({ success: false, raison: 'crypto_error' }, 500);
			}
		}

		statements.push(env.DB.prepare(`
			INSERT INTO stats_eleves (
				licence_id, eleve_id, prenom,
				total_examens, total_reussites, total_echecs, iles_completees,
				derniere_session_at, push_at,
				payload_json, payload_chiffre, payload_iv, payload_kdf
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
			ON CONFLICT(licence_id, eleve_id) DO UPDATE SET
				prenom              = excluded.prenom,
				total_examens       = excluded.total_examens,
				total_reussites     = excluded.total_reussites,
				total_echecs        = excluded.total_echecs,
				iles_completees     = excluded.iles_completees,
				derniere_session_at = excluded.derniere_session_at,
				push_at             = excluded.push_at,
				payload_json        = NULL,
				payload_chiffre     = excluded.payload_chiffre,
				payload_iv          = excluded.payload_iv,
				payload_kdf         = excluded.payload_kdf
		`).bind(
			licenceId, eleveId, prenom,
			totalExamens, totalReussites, totalEchecs, ilesCompletees,
			derniereSessionAt, now,
			payloadChiffre, payloadIv, payloadKdf
		));
	}

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

interface StatsRow {
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
	payload_chiffre: ArrayBuffer | null;
	payload_iv: ArrayBuffer | null;
	payload_kdf: string | null;
}

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

	// 4. Récupérer les stats (avec colonnes chiffrement)
	let rows: StatsRow[];
	try {
		const { results } = await env.DB.prepare(`
			SELECT
				id, eleve_id, prenom,
				total_examens, total_reussites, total_echecs, iles_completees,
				derniere_session_at, push_at,
				payload_json, payload_chiffre, payload_iv, payload_kdf
			FROM stats_eleves
			WHERE licence_id = ?
			ORDER BY derniere_session_at DESC
			LIMIT 500
		`).bind(licenceId).all<StatsRow>();
		rows = results;
	} catch (err) {
		console.error('[stats/classe] erreur SELECT :', err);
		return jsonResponse({ success: false, raison: 'db_error' }, 500);
	}

	// 5. Déchiffrer les payloads chiffrés (D5)
	// Backward-compat : si payload_chiffre IS NULL → retourner payload_json legacy
	const eleves: Array<Record<string, unknown>> = [];
	for (const row of rows) {
		let payloadJson: string | null = row.payload_json;

		if (row.payload_chiffre && row.payload_iv && row.payload_kdf) {
			if (!env.MASTER_ENCRYPTION_KEY || env.MASTER_ENCRYPTION_KEY.length < 32) {
				console.error('[stats/classe] MASTER_ENCRYPTION_KEY manquant pour déchiffrer');
				return jsonResponse({ success: false, raison: 'server_misconfigured' }, 500);
			}
			try {
				payloadJson = await dechiffrerStatsPayload(
					new Uint8Array(row.payload_chiffre),
					new Uint8Array(row.payload_iv),
					env.MASTER_ENCRYPTION_KEY,
					licenceId,
					row.payload_kdf
				);
			} catch (err) {
				console.error('[stats/classe] erreur déchiffrement payload eleve', row.eleve_id, ':', err);
				// On ne fait pas planter toute la requête : on retourne null pour ce payload
				payloadJson = null;
			}
		}

		eleves.push({
			id: row.id,
			eleve_id: row.eleve_id,
			prenom: row.prenom,
			total_examens: row.total_examens,
			total_reussites: row.total_reussites,
			total_echecs: row.total_echecs,
			iles_completees: row.iles_completees,
			derniere_session_at: row.derniere_session_at,
			push_at: row.push_at,
			payload_json: payloadJson,
			payload_encrypted: row.payload_chiffre != null
		});
	}

	return jsonResponse({ success: true, eleves });
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
