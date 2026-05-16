// ============================================================================
// prof-loi-25.ts — Endpoints Loi 25 (Québec) pour les profs
// ============================================================================
//
// Sprint D5 — App Tauri prof.
// Référence : Loi 25 (Québec), articles 27 (accès) + 28 (effacement).
//
// Endpoints :
//   - GET    /api/prof/me/export   → JSON complet de toutes les données du prof
//   - DELETE /api/prof/me/delete   → suppression compte (cascade DEK effacée)
//   - GET    /api/prof/me/audit    → liste filtrée du prof_audit_log
//
// Sécurité :
//   - Tous les endpoints exigent JWT post-2FA (authentifier avec require2fa=true)
//   - DELETE exige confirmation explicite via body { confirmation: "SUPPRIMER" }
//   - Rate limit existant via prof-routes / index.ts (pas dupliqué ici)
//
// Architecture suppression :
//   - statut='supprime' + supprime_le=now (marqueur logique)
//   - dek_chiffree = '' + dek_iv = '' (clé effacée -> données élèves illisibles)
//   - prof_sessions DELETE (toutes les sessions actives)
//   - Données élèves CHIFFRÉES restent en DB (anonymes), mais inutilisables sans DEK
//   - Email + nom préservés pour audit légal (Loi 25 §38), masqués au reset
//
// Architecture export :
//   - JSON unique compilant : profil + sessions actives + classes + élèves
//     (PII enfants DÉCHIFFRÉE côté serveur via DEK lue avec mdp prof)
//   - Note : on ne peut PAS déchiffrer les PII enfants côté serveur car le DEK
//     est wrappé avec K_user = PBKDF2(mdp). Donc l'export retourne les
//     blobs CHIFFRÉS, et le client Tauri déchiffrera localement avant affichage.
//
// ============================================================================

import type { Env } from './types';
import { authentifier } from './prof-routes';
import { ecrireAudit, jsonOk, jsonErr } from './auth-prof';

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/prof/me/export
//   Réponse : { prof, sessions, classes, eleves, generated_at, format_version }
// ─────────────────────────────────────────────────────────────────────────────

export async function handleProfExport(request: Request, env: Env): Promise<Response> {
  const auth = await authentifier(request, env, true); // 2FA requis
  if (auth instanceof Response) return auth;
  const { prof } = auth;

  const now = Math.floor(Date.now() / 1000);

  // Profil prof (PII en clair OK pour Loi 25 article 27)
  const profilExport = {
    id: prof.id,
    email: prof.email,
    nom_affiche: prof.nom_affiche,
    nom_ecole: prof.nom_ecole,
    ville: prof.ville,
    pays: prof.pays,
    code_classe: prof.code_classe,
    twofa_methode: prof.twofa_methode,
    twofa_setup_at: prof.twofa_setup_at,
    consentement_parental_atteste: prof.consentement_parental_atteste === 1,
    cgu_acceptees_le: prof.cgu_acceptees_le,
    politique_version: prof.politique_version,
    created_at: prof.created_at,
    derniere_connexion: prof.derniere_connexion,
    statut: prof.statut,
  };

  // Sessions actives (refresh tokens)
  const sessionsRes = await env.DB.prepare(`
    SELECT id, device_label, ip_pays, created_at, expire_le, derniere_utilisation
    FROM prof_sessions
    WHERE prof_id = ?
    ORDER BY created_at DESC
  `).bind(prof.id).all();
  const sessions = sessionsRes.results ?? [];

  // Classes du prof (table créée par PB1 11.3)
  let classes: Array<Record<string, unknown>> = [];
  try {
    const classesRes = await env.DB.prepare(`
      SELECT id, code_classe, nom_affiche, annee_scolaire, est_archivee, created_at
      FROM classes
      WHERE prof_id = ?
      ORDER BY created_at DESC
    `).bind(prof.id).all();
    classes = classesRes.results ?? [];
  } catch {
    // Table peut ne pas exister sur d'anciens schémas, on continue
    classes = [];
  }

  // Élèves chiffrés (les blobs sont retournés tels quels, déchiffrement côté client)
  const elevesRes = await env.DB.prepare(`
    SELECT
      id,
      prenom_chiffre, prenom_iv,
      nom_chiffre, nom_iv,
      code_eleve_hash,
      stats_chiffre, stats_iv,
      stats_push_at, stats_version,
      est_archive, created_at, archive_le
    FROM eleves_chiffres
    WHERE prof_id = ?
    ORDER BY created_at DESC
  `).bind(prof.id).all();
  const eleves = (elevesRes.results ?? []).map((row: any) => ({
    id: row.id,
    // BLOB → base64 pour transport JSON
    prenom_chiffre: row.prenom_chiffre ? bufferToB64(row.prenom_chiffre) : null,
    prenom_iv: row.prenom_iv ? bufferToB64(row.prenom_iv) : null,
    nom_chiffre: row.nom_chiffre ? bufferToB64(row.nom_chiffre) : null,
    nom_iv: row.nom_iv ? bufferToB64(row.nom_iv) : null,
    code_eleve_hash: row.code_eleve_hash,
    stats_chiffre: row.stats_chiffre ? bufferToB64(row.stats_chiffre) : null,
    stats_iv: row.stats_iv ? bufferToB64(row.stats_iv) : null,
    stats_push_at: row.stats_push_at,
    stats_version: row.stats_version,
    est_archive: row.est_archive === 1,
    created_at: row.created_at,
    archive_le: row.archive_le,
  }));

  // Audit logs du prof (limité aux 1000 derniers pour la taille du payload)
  const auditRes = await env.DB.prepare(`
    SELECT action, cible, ip_pays, user_agent, meta_json, at
    FROM prof_audit_log
    WHERE prof_id = ?
    ORDER BY at DESC
    LIMIT 1000
  `).bind(prof.id).all();
  const audit_log = auditRes.results ?? [];

  // Écrire dans l'audit que l'export a été effectué (Loi 25 article 27 §3)
  await ecrireAudit(env, {
    prof_id: prof.id,
    action: 'loi_25_export',
    cible: prof.id,
    ip_pays: request.headers.get('cf-ipcountry') ?? undefined,
    user_agent: request.headers.get('user-agent') ?? undefined,
    meta: { nb_eleves: eleves.length, nb_classes: classes.length, nb_sessions: sessions.length },
  });

  return jsonOk({
    format_version: 'v1',
    generated_at: now,
    note_loi_25:
      "Cet export contient toutes les données vous concernant. Les PII des élèves " +
      "(prénoms, noms, stats) sont chiffrées et ne peuvent être déchiffrées qu'avec votre mot de passe.",
    prof: profilExport,
    sessions,
    classes,
    eleves,
    audit_log,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/prof/me/delete
//   Body: { confirmation: "SUPPRIMER" } (anti-bouton-accidentel)
//   Action : statut='supprime' + DEK effacée + sessions supprimées
// ─────────────────────────────────────────────────────────────────────────────

export async function handleProfDelete(request: Request, env: Env): Promise<Response> {
  const auth = await authentifier(request, env, true); // 2FA requis
  if (auth instanceof Response) return auth;
  const { prof } = auth;

  // Vérifier le mot magique
  let body: { confirmation?: string };
  try {
    body = (await request.json()) as { confirmation?: string };
  } catch {
    return jsonErr('JSON invalide', 400, 'BAD_JSON');
  }
  if (body.confirmation !== 'SUPPRIMER') {
    return jsonErr(
      'Confirmation requise : envoyer body { "confirmation": "SUPPRIMER" }',
      400,
      'CONFIRMATION_REQUISE'
    );
  }

  // Déjà supprimé ?
  if (prof.statut === 'supprime') {
    return jsonErr('Compte déjà supprimé', 410, 'ALREADY_DELETED');
  }

  const now = Math.floor(Date.now() / 1000);

  // Effacer la DEK (rend les données élèves illisibles) + marquer supprimé
  // On garde email/nom pour audit légal Loi 25 §38 (preuves de traitement)
  await env.DB.prepare(`
    UPDATE profs
    SET statut = 'supprime',
        supprime_le = ?,
        dek_chiffree = '',
        dek_iv = '',
        twofa_totp_secret = NULL,
        twofa_totp_iv = NULL,
        twofa_phone = NULL,
        twofa_phone_iv = NULL,
        password_hash = ''
    WHERE id = ?
  `).bind(now, prof.id).run();

  // Supprimer toutes les sessions (refresh tokens devienennt invalides)
  await env.DB.prepare(`
    DELETE FROM prof_sessions WHERE prof_id = ?
  `).bind(prof.id).run();

  // Audit
  await ecrireAudit(env, {
    prof_id: prof.id,
    action: 'loi_25_compte_supprime',
    cible: prof.id,
    ip_pays: request.headers.get('cf-ipcountry') ?? undefined,
    user_agent: request.headers.get('user-agent') ?? undefined,
    meta: { supprime_le: now },
  });

  return jsonOk({
    success: true,
    message:
      "Votre compte a été supprimé. La clé de chiffrement de vos données d'élèves " +
      "a été effacée : ces données sont désormais illisibles. Conformément à " +
      "la Loi 25 §38, nous conservons votre email et votre nom 7 ans pour audit légal.",
    supprime_le: now,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/prof/me/audit?limit=100&offset=0
//   Réponse : { entries, total, limit, offset }
// ─────────────────────────────────────────────────────────────────────────────

export async function handleProfAudit(request: Request, env: Env): Promise<Response> {
  const auth = await authentifier(request, env, true); // 2FA requis
  if (auth instanceof Response) return auth;
  const { prof } = auth;

  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100), 1), 500);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0), 0);

  const totalRes = await env.DB.prepare(
    'SELECT COUNT(*) as total FROM prof_audit_log WHERE prof_id = ?'
  ).bind(prof.id).first<{ total: number }>();

  const entriesRes = await env.DB.prepare(`
    SELECT action, cible, ip_pays, user_agent, meta_json, at
    FROM prof_audit_log
    WHERE prof_id = ?
    ORDER BY at DESC
    LIMIT ? OFFSET ?
  `).bind(prof.id, limit, offset).all();

  const entries = (entriesRes.results ?? []).map((row: any) => ({
    action: row.action,
    cible: row.cible,
    ip_pays: row.ip_pays,
    user_agent: row.user_agent,
    meta: row.meta_json ? safeParseJson(row.meta_json) : null,
    at: row.at,
  }));

  return jsonOk({
    entries,
    total: totalRes?.total ?? 0,
    limit,
    offset,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function bufferToB64(buf: unknown): string {
  // D1 retourne les BLOBs comme ArrayBuffer ou Uint8Array
  if (buf instanceof ArrayBuffer) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  if (buf instanceof Uint8Array) {
    let bin = '';
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    return btoa(bin);
  }
  // Fallback : si c'est déjà une string base64 ou JSON.stringifiable
  return String(buf);
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
