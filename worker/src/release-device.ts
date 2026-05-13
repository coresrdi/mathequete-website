/**
 * Mathéquête — Endpoint /api/release-device
 *
 * Permet à l'utilisateur de désactiver sa licence sur l'appareil courant
 * pour pouvoir l'activer sur un autre appareil.
 *
 * Règle métier (DEC-45) : transfert autorisé dans les 6 mois post-achat.
 * Après 6 mois, l'utilisateur doit contacter le support pour transfert manuel.
 *
 * Requête (POST JSON) :
 *   {
 *     code_brut: "MQ-CLAS-XXXX-XXXX-XXXX-XXXX-XXXX",
 *     device_hash: "sha256_hash_du_device_actuel"
 *   }
 *
 * Réponses :
 *   200 { success: true, message: "Appareil désactivé..." }
 *   400 { error: "code_brut ou device_hash manquant" }
 *   403 { error: "Hors fenêtre 6 mois", jours_depuis_achat: 187 }
 *   404 { error: "Licence introuvable ou jamais activée" }
 *   409 { error: "Cet appareil n'est pas l'appareil actif" }
 *   500 { error: "Erreur interne" }
 */

import type { Env } from './types';
import { verifierCodeBrut } from './generate-codes';

const SIX_MOIS_SECONDES = 6 * 30 * 24 * 3600; // 15 552 000 s

export async function handleReleaseDevice(
	request: Request,
	env: Env
): Promise<Response> {
	if (request.method !== 'POST') {
		return jsonError('Method not allowed', 405);
	}

	let body: { code_brut?: string; device_hash?: string };
	try {
		body = await request.json();
	} catch {
		return jsonError('JSON invalide', 400);
	}

	const codeBrut = (body.code_brut ?? '').trim();
	const deviceHash = (body.device_hash ?? '').trim();

	if (!codeBrut || !deviceHash) {
		return jsonError('code_brut et device_hash requis', 400);
	}

	// 1. Vérifier HMAC du code (rejet immédiat si signature invalide)
	const verif = await verifierCodeBrut(codeBrut, env.HMAC_SECRET_KEY);
	if (!verif.valide || !verif.licence_id) {
		return jsonError('Code invalide ou signature corrompue', 400);
	}

	// 2. Récupérer la licence + activation courante
	const stmt = env.DB.prepare(`
		SELECT
			l.id            AS licence_id,
			l.emis_le       AS emis_le,
			l.expire_le     AS expire_le,
			ca.id           AS active_id,
			ca.device_hash  AS device_actif,
			ca.statut       AS statut_active
		FROM licences l
		LEFT JOIN codes_actives ca
			ON ca.licence_id = l.id
			AND ca.statut = 'active'
		WHERE l.id = ?
	`).bind(verif.licence_id);

	const row = await stmt.first<{
		licence_id: string;
		emis_le: number;
		expire_le: number;
		active_id: number | null;
		device_actif: string | null;
		statut_active: string | null;
	}>();

	if (!row) {
		return jsonError('Licence introuvable', 404);
	}

	if (!row.active_id || !row.device_actif) {
		return jsonError('Aucune activation à libérer pour ce code', 404);
	}

	// 3. Vérifier que le device qui demande est bien l'actif
	if (row.device_actif !== deviceHash) {
		return jsonError(
			"Cet appareil n'est pas l'appareil actif sur cette licence",
			409
		);
	}

	// 4. Vérifier la fenêtre 6 mois post-achat
	const maintenant = Math.floor(Date.now() / 1000);
	const deltaSecondes = maintenant - row.emis_le;
	const deltaJours = Math.floor(deltaSecondes / 86400);

	if (deltaSecondes > SIX_MOIS_SECONDES) {
		return jsonResponse(
			{
				error: 'Hors fenêtre 6 mois — contacter support@mathequete.ca',
				jours_depuis_achat: deltaJours,
				limite_jours: 180
			},
			403
		);
	}

	// 5. Vérifier que la licence n'est pas expirée (cas pack annuel)
	if (row.expire_le > 0 && maintenant > row.expire_le) {
		return jsonError('Licence expirée — pas de transfert possible', 403);
	}

	// 6. Exécuter la libération + audit (transaction implicite via batch)
	const ipPays =
		request.cf && typeof (request.cf as { country?: string }).country === 'string'
			? (request.cf as { country: string }).country
			: null;

	await env.DB.batch([
		env.DB.prepare(`
			UPDATE codes_actives
			SET statut = 'liberee',
				liberee_le = ?,
				raison_liberation = 'user_demand'
			WHERE id = ?
		`).bind(maintenant, row.active_id),

		env.DB.prepare(`
			INSERT INTO transferts_appareils
				(licence_id, code_active_id, ancien_device_hash,
				 date_transfert, date_achat_origine, delta_jours,
				 source, ip_pays)
			VALUES (?, ?, ?, ?, ?, ?, 'user_action', ?)
		`).bind(
			row.licence_id,
			row.active_id,
			row.device_actif,
			maintenant,
			row.emis_le,
			deltaJours,
			ipPays
		)
	]);

	return jsonResponse({
		success: true,
		message: 'Appareil désactivé. Vous pouvez activer le code sur un nouvel appareil.',
		jours_depuis_achat: deltaJours,
		jours_restants_fenetre: 180 - deltaJours
	});
}

/* ---------- helpers locaux (dupliqués pour isolation module) ---------- */

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
	return jsonResponse({ error: message }, status);
}
