// ============================================================================
// admin-qr-manuel.ts — Génération admin de QR isolés (sans forfait Stripe)
// ============================================================================
//
// Cas d'usage couverts :
//   - Tests internes (Jeff valide IE-5+6 avec un QR de test)
//   - Dépannage client (problème activation Stripe → générer 1 QR manuel)
//   - Cadeaux marketing (concours, influenceurs)
//   - Codes promo single-use
//
// Génération AUTOMATIQUE (pack_familial, promo automatique, windows_direct)
// passera par webhook-pack-familial.ts / webhook-promo.ts / etc. — voir
// le document SPEC-NIVEAU-3-DISTRIBUTION-AUTO.md pour le cadrage.
//
// Sécurité : tous les endpoints protégés par X-Admin-Token (constant-time).
//
// Stratégie d'insertion sans forfait_ecole_id :
//   - On crée 1 licence parent partagée "admin_manuel_v1" (singleton créé à
//     la première utilisation) qui sert de licence_id_hmac pour tous les
//     QR manuels. Évite migration ALTER TABLE et préserve la FK.
//   - source = 'cadeau' par défaut (cf. DEC-59), mais l'admin peut spécifier
//     'promo' / 'pack_familial' / 'windows_direct' pour traçabilité.
//
// Audit log : chaque génération + révocation écrit dans prof_audit_log
// avec action='admin_qr_genere' / 'admin_qr_revoque' et meta_json détaillé.
//
// Sprint A — 16 mai 2026
// ============================================================================

import type { Env } from './types';
import { verifierAdminToken } from './admin-forfaits';
import { genererLotClesQrUniques, formaterCleQrAffichage } from './qr-gen';

const LICENCE_PARENT_ID = 'admin_manuel_v1';
const NB_MAX_PAR_GENERATION = 50;
const SOURCES_VALIDES = ['cadeau', 'promo', 'pack_familial', 'windows_direct'] as const;
type SourceManuelle = typeof SOURCES_VALIDES[number];

// ─────────────────────────────────────────────────────────────────────────────
// Singleton licence parent pour les QR manuels (créé à la première utilisation)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Crée (si absent) une licence parent "admin_manuel_v1" qui sert de
 * licence_id_hmac pour tous les QR manuels. Idempotent.
 */
async function assurerLicenceParent(env: Env): Promise<void> {
  const existe = await env.DB.prepare(
    'SELECT id FROM licences WHERE id = ?'
  ).bind(LICENCE_PARENT_ID).first();
  if (existe) return;

  const now = Math.floor(Date.now() / 1000);
  // Type 'admin', tier 'manuel', pas d'email, pas d'expiration.
  // FIX 17 mai 2026 : convention projet = expire_le = 0 (jamais expirer)
  // au lieu de NULL. Le schéma D1 déclare expire_le INTEGER NOT NULL.
  await env.DB.prepare(`
    INSERT INTO licences
      (id, code, type, tier, nb_eleves_max, emis_le, expire_le,
       email_acheteur, nom_acheteur, stripe_session, source)
    VALUES (?, ?, 'admin', 'manuel', 0, ?, 0, NULL, 'Admin manuel', NULL, 'admin')
  `).bind(LICENCE_PARENT_ID, LICENCE_PARENT_ID.toUpperCase(), now).run();

  console.log('[admin-qr-manuel] Licence parent créée :', LICENCE_PARENT_ID);
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit helper (réutilise pattern prof_audit_log)
// ─────────────────────────────────────────────────────────────────────────────

async function ecrireAuditQr(
  env: Env,
  action: 'admin_qr_genere' | 'admin_qr_revoque',
  cles: string[],
  details: Record<string, unknown>,
  request?: Request
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const ipPays = request?.headers.get('cf-ipcountry') ?? null;
  const userAgent = request?.headers.get('user-agent') ?? null;
  const metaJson = JSON.stringify({ ...details, cibles: cles, cible_type: 'licences_qr_manuel' });
  try {
    await env.DB.prepare(`
      INSERT INTO prof_audit_log
        (prof_id, action, cible, ip_pays, user_agent, meta_json, at)
      VALUES (NULL, ?, ?, ?, ?, ?, ?)
    `).bind(action, cles.join(','), ipPays, userAgent, metaJson, now).run();
  } catch (err) {
    console.error('[admin-qr-manuel] echec audit log :', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/qr/generer
//   Body: { source, produit_id?, nb?, note_interne? }
//   Réponse: { cles_qr: ["K7P2-QM3R-NT8X", ...], created_at, source, produit_id }
// ─────────────────────────────────────────────────────────────────────────────

export async function handleAdminQrGenerer(
  request: Request, env: Env
): Promise<Response> {
  if (!(await verifierAdminToken(request, env))) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'JSON invalide' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Validation paramètres
  const source = String(body.source ?? 'cadeau');
  if (!SOURCES_VALIDES.includes(source as SourceManuelle)) {
    return new Response(
      JSON.stringify({
        error: 'source invalide',
        sources_valides: SOURCES_VALIDES
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const produit_id = String(body.produit_id ?? 'continent_1').trim();
  if (!produit_id.match(/^continent_[1-8]$/)) {
    return new Response(
      JSON.stringify({
        error: 'produit_id invalide',
        format_attendu: 'continent_1 à continent_8'
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const nb = Math.floor(Number(body.nb ?? 1));
  if (!Number.isFinite(nb) || nb < 1 || nb > NB_MAX_PAR_GENERATION) {
    return new Response(
      JSON.stringify({
        error: `nb doit être entre 1 et ${NB_MAX_PAR_GENERATION}`,
        recu: body.nb
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const note_interne = String(body.note_interne ?? '').slice(0, 200);

  // ──────────────────────────────────────────────────────────────────────
  // Sprint EXP-QR (17 mai 2026) : 3 modes d'expiration
  // ──────────────────────────────────────────────────────────────────────
  //
  // body.expiration_mode :
  //   'aucune'       → jamais expirer (legacy, par défaut)
  //   'date_fixe'    → body.expire_le_iso : '2027-09-30' (interprété 23:59:59 ET)
  //   'duree_jours'  → body.duree_jours : nombre, expire_le calculé à activation
  //
  // ──────────────────────────────────────────────────────────────────────
  const expiration_mode = String(body.expiration_mode ?? 'aucune');
  let expire_le: number | null = null;
  let duree_jours: number | null = null;

  if (expiration_mode === 'date_fixe') {
    const iso = String(body.expire_le_iso ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      return new Response(
        JSON.stringify({
          error: "expire_le_iso invalide (format attendu : YYYY-MM-DD)",
          recu: body.expire_le_iso
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    // Interprète comme fin de journée 23:59:59 UTC
    // (l'admin choisit une date → on prend la fin de cette journée)
    const d = new Date(`${iso}T23:59:59Z`);
    if (Number.isNaN(d.getTime())) {
      return new Response(
        JSON.stringify({ error: "Date invalide", recu: iso }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    expire_le = Math.floor(d.getTime() / 1000);
    const now_check = Math.floor(Date.now() / 1000);
    if (expire_le <= now_check) {
      return new Response(
        JSON.stringify({
          error: "La date d'expiration doit être dans le futur",
          recu: iso
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
  } else if (expiration_mode === 'duree_jours') {
    const dj = Math.floor(Number(body.duree_jours ?? 0));
    if (!Number.isFinite(dj) || dj < 1 || dj > 3650) {
      return new Response(
        JSON.stringify({
          error: "duree_jours doit être entre 1 et 3650 (10 ans max)",
          recu: body.duree_jours
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    duree_jours = dj;
  } else if (expiration_mode !== 'aucune') {
    return new Response(
      JSON.stringify({
        error: "expiration_mode invalide",
        modes_valides: ['aucune', 'date_fixe', 'duree_jours']
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Étape 1 : assurer licence parent (idempotent)
  await assurerLicenceParent(env);

  // Étape 2 : générer N clés Crockford uniques (réutilise qr-gen.ts)
  const cles = await genererLotClesQrUniques(env, nb);

  // Étape 3 : INSERT batch dans licences_qr (avec colonnes expiration EXP-QR)
  const now = Math.floor(Date.now() / 1000);
  const stmts = cles.map((cle, idx) =>
    env.DB.prepare(`
      INSERT INTO licences_qr
        (cle_qr, forfait_ecole_id, licence_id_hmac, produit_id,
         numero_sequence, date_creation, source,
         expire_le, duree_apres_activation_jours)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      cle, LICENCE_PARENT_ID, produit_id, idx + 1, now, source,
      expire_le, duree_jours
    )
  );
  await env.DB.batch(stmts);

  // Étape 4 : audit log
  await ecrireAuditQr(env, 'admin_qr_genere', cles, {
    source, produit_id, nb, note_interne,
    expiration_mode, expire_le, duree_jours
  }, request);

  // Réponse : clés formatées avec tirets pour copier-coller facile
  const cles_formatees = cles.map(formaterCleQrAffichage);

  return new Response(
    JSON.stringify({
      cles_qr: cles_formatees,
      cles_brutes: cles,
      source,
      produit_id,
      created_at: now,
      note_interne: note_interne || null,
      expiration_mode,
      expire_le,
      duree_apres_activation_jours: duree_jours,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/qr/lister?source=cadeau&limit=50&offset=0
//   Réponse: { qrs: [...], total }
// ─────────────────────────────────────────────────────────────────────────────

export async function handleAdminQrLister(
  request: Request, env: Env
): Promise<Response> {
  if (!(await verifierAdminToken(request, env))) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const url = new URL(request.url);
  const source = url.searchParams.get('source');
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0), 0);

  // Filtre : QR manuels uniquement (forfait_ecole_id IS NULL)
  let where = 'WHERE forfait_ecole_id IS NULL';
  const binds: any[] = [];
  if (source && SOURCES_VALIDES.includes(source as SourceManuelle)) {
    where += ' AND source = ?';
    binds.push(source);
  }

  const res = await env.DB.prepare(`
    SELECT cle_qr, produit_id, source, date_creation, est_revoquee,
           device_fingerprint, activation_initiale_date, eleve_pseudo,
           expire_le, duree_apres_activation_jours
    FROM licences_qr
    ${where}
    ORDER BY date_creation DESC
    LIMIT ? OFFSET ?
  `).bind(...binds, limit, offset).all<{
    cle_qr: string;
    produit_id: string;
    source: string;
    date_creation: number;
    est_revoquee: number;
    device_fingerprint: string | null;
    activation_initiale_date: number | null;
    eleve_pseudo: string | null;
    expire_le: number | null;
    duree_apres_activation_jours: number | null;
  }>();

  const totalRes = await env.DB.prepare(`
    SELECT COUNT(*) as total FROM licences_qr ${where}
  `).bind(...binds).first<{ total: number }>();

  const qrs = (res.results ?? []).map(r => ({
    cle_qr: formaterCleQrAffichage(r.cle_qr),
    cle_brute: r.cle_qr,
    produit_id: r.produit_id,
    source: r.source,
    date_creation: r.date_creation,
    est_revoquee: r.est_revoquee === 1,
    est_active: r.device_fingerprint !== null,
    activation_date: r.activation_initiale_date,
    eleve: r.eleve_pseudo,
    expire_le: r.expire_le,
    duree_apres_activation_jours: r.duree_apres_activation_jours,
  }));

  return new Response(
    JSON.stringify({ qrs, total: totalRes?.total ?? 0, limit, offset }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/qr/revoquer
//   Body: { cle_qr, raison? }
//   Réponse: { success, cle_qr, raison }
// ─────────────────────────────────────────────────────────────────────────────

export async function handleAdminQrRevoquer(
  request: Request, env: Env
): Promise<Response> {
  if (!(await verifierAdminToken(request, env))) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'JSON invalide' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const cleBrute = String(body.cle_qr ?? '').replace(/-/g, '').toUpperCase();
  if (cleBrute.length !== 12) {
    return new Response(
      JSON.stringify({ error: 'cle_qr doit faire 12 chars (avec ou sans tirets)' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const raison = String(body.raison ?? 'admin_manuel').slice(0, 100);

  // Vérifier que le QR existe et est manuel (forfait_ecole_id IS NULL)
  const ligne = await env.DB.prepare(`
    SELECT cle_qr, forfait_ecole_id, est_revoquee
    FROM licences_qr WHERE cle_qr = ?
  `).bind(cleBrute).first<{
    cle_qr: string;
    forfait_ecole_id: number | null;
    est_revoquee: number;
  }>();

  if (!ligne) {
    return new Response(
      JSON.stringify({ error: 'QR introuvable' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (ligne.forfait_ecole_id !== null) {
    return new Response(
      JSON.stringify({
        error: 'Ce QR appartient à un forfait école. Utilise le flux forfait pour le révoquer.',
        forfait_ecole_id: ligne.forfait_ecole_id
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (ligne.est_revoquee === 1) {
    return new Response(
      JSON.stringify({ error: 'QR déjà révoqué' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Révocation
  await env.DB.prepare(`
    UPDATE licences_qr SET est_revoquee = 1 WHERE cle_qr = ?
  `).bind(cleBrute).run();

  // Audit
  await ecrireAuditQr(env, 'admin_qr_revoque', [cleBrute], { raison }, request);

  return new Response(
    JSON.stringify({
      success: true,
      cle_qr: formaterCleQrAffichage(cleBrute),
      raison,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/qr — Onglet dashboard HTML (réutilise le pattern de admin-forfaits)
// ─────────────────────────────────────────────────────────────────────────────

export function handleAdminQrDashboardHtml(_request: Request): Response {
  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Mathéquête — QR manuels (admin)</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="X-Frame-Options" content="DENY">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 900px;
           margin: 2rem auto; padding: 0 1rem; color: #1e3a5f; background: #fbf4e0; }
    h1 { color: #d4a017; font-family: Georgia, serif; border-bottom: 2px solid #d4a017;
         padding-bottom: 0.4rem; }
    h2 { color: #1e3a5f; margin-top: 2rem; font-family: Georgia, serif; }
    nav a { color: #1e3a5f; margin-right: 1rem; text-decoration: none; font-weight: 600; }
    nav a:hover { color: #d4a017; }
    form { background: #fff; padding: 1.5rem; border-radius: 8px;
           border: 2px solid #e8d5a8; margin: 1rem 0; }
    label { display: block; margin: 0.6rem 0 0.2rem; font-weight: 600; }
    input, select { width: 100%; padding: 0.6rem; border: 1px solid #ccc;
                    border-radius: 4px; font-size: 1rem; box-sizing: border-box; }
    button { background: #d4a017; color: #fff; border: 0; padding: 0.8rem 1.5rem;
             font-size: 1rem; font-weight: 600; border-radius: 4px; cursor: pointer;
             margin-top: 1rem; }
    button:hover { background: #a8761a; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .resultat { background: #d4f1e0; border-left: 4px solid #06A77D;
                padding: 1rem; margin: 1rem 0; border-radius: 4px; }
    .erreur { background: #fdecea; border-left: 4px solid #c1432b;
              padding: 1rem; margin: 1rem 0; border-radius: 4px; color: #c1432b; }
    .cle { font-family: 'Courier New', monospace; font-size: 1.2rem;
           background: #fff; padding: 0.4rem 0.8rem; border-radius: 4px;
           display: inline-block; margin: 0.2rem; border: 1px solid #d4a017; }
    table { width: 100%; border-collapse: collapse; background: #fff;
            margin: 1rem 0; border-radius: 4px; overflow: hidden; }
    th { background: #1e3a5f; color: #fbf4e0; padding: 0.8rem; text-align: left; }
    td { padding: 0.6rem 0.8rem; border-bottom: 1px solid #eee; }
    tr:hover td { background: #fbf4e0; }
    .badge { padding: 0.2rem 0.5rem; border-radius: 3px; font-size: 0.85rem;
             font-weight: 600; display: inline-block; }
    .badge.expire-jamais { background: #eee; color: #555; }
    .badge.expire-prochain { background: #fff3cd; color: #a8761a; }
    .badge.expire-imminent { background: #ffe5d9; color: #c1432b; font-weight: 700; }
    .badge.expire-deja { background: #fdecea; color: #c1432b; font-weight: 700; }
    .badge.cadeau { background: #d4f1e0; color: #06A77D; }
    .badge.promo { background: #fff3cd; color: #a8761a; }
    .badge.pack_familial { background: #ddeeff; color: #1e3a5f; }
    .badge.windows_direct { background: #ffe5d9; color: #c1432b; }
    .badge.revoquee { background: #fdecea; color: #c1432b; }
    .badge.active { background: #d4f1e0; color: #06A77D; }
    .badge.inactif { background: #eee; color: #555; }
    .actions button { background: #c1432b; padding: 0.3rem 0.7rem; font-size: 0.85rem;
                      margin-top: 0; }
    .actions button:hover { background: #8b2e1c; }
    .filtres { display: flex; gap: 1rem; align-items: end; margin-bottom: 1rem; }
    .filtres > * { flex: 1; }
  </style>
</head>
<body>
  <h1>🎫 Mathéquête — QR manuels (admin)</h1>
  <nav>
    <a href="/admin/forfaits">📋 Forfaits école</a>
    <a href="/admin/qr">🎫 QR manuels (ici)</a>
  </nav>

  <p style="background: #ffe5d9; padding: 0.8rem; border-radius: 4px; border-left: 4px solid #c1432b;">
    <strong>Usage :</strong> génération de QR isolés pour tests, dépannage client, cadeaux.
    Pour les forfaits école (≥ 30 QR via Stripe), utilise <a href="/admin/forfaits">l'autre onglet</a>.
  </p>

  <h2>➕ Générer de nouveaux QR</h2>
  <form id="formGenerer">
    <label>Source <span style="color: #c1432b;">*</span></label>
    <select name="source" required>
      <option value="cadeau">cadeau (défaut, gratuit/test/dépannage)</option>
      <option value="promo">promo (code promotionnel)</option>
      <option value="pack_familial">pack_familial (5 QR famille)</option>
      <option value="windows_direct">windows_direct (achat individuel site)</option>
    </select>

    <label>Produit</label>
    <select name="produit_id">
      <option value="continent_1">Continent 1 (seul jouable actuellement)</option>
      <option value="continent_2">Continent 2 (futur)</option>
      <option value="continent_3">Continent 3 (futur)</option>
      <option value="continent_4">Continent 4 (futur)</option>
      <option value="continent_5">Continent 5 (futur)</option>
      <option value="continent_6">Continent 6 (futur)</option>
      <option value="continent_7">Continent 7 (futur)</option>
      <option value="continent_8">Continent 8 (futur)</option>
    </select>

    <label>Nombre de QR (1 à 50)</label>
    <input type="number" name="nb" value="1" min="1" max="50">

    <label>Note interne (optionnel, max 200 chars)</label>
    <input type="text" name="note_interne" placeholder="Ex: Test IE-5+6 Jeff 16 mai" maxlength="200">

    <fieldset style="border: 1px solid #d4a017; padding: 0.8rem; margin-top: 1rem; border-radius: 4px;">
      <legend style="padding: 0 0.5rem; font-weight: 600;">⏳ Expiration (optionnel)</legend>

      <label style="margin-top: 0;">
        <input type="radio" name="expiration_mode" value="aucune" checked>
        Aucune (le QR ne expire jamais)
      </label>
      <label>
        <input type="radio" name="expiration_mode" value="date_fixe">
        Date fixe (ex: 30 sept 2027 pour année scolaire)
      </label>
      <div id="blocDateFixe" style="display: none; margin-left: 1.5rem; margin-top: 0.4rem;">
        <label>Expire le</label>
        <input type="date" name="expire_le_iso">
      </div>
      <label>
        <input type="radio" name="expiration_mode" value="duree_jours">
        Durée après 1ère activation (programme de test)
      </label>
      <div id="blocDureeJours" style="display: none; margin-left: 1.5rem; margin-top: 0.4rem;">
        <label>Nombre de jours (1 à 3650)</label>
        <input type="number" name="duree_jours" min="1" max="3650" value="30">
      </div>
    </fieldset>

    <button type="submit" id="btnGenerer">Générer les QR</button>
  </form>

  <div id="resultatGeneration"></div>

  <h2>📜 QR manuels existants</h2>
  <div class="filtres">
    <div>
      <label>Filtrer par source</label>
      <select id="filtreSource">
        <option value="">Toutes les sources</option>
        <option value="cadeau">cadeau</option>
        <option value="promo">promo</option>
        <option value="pack_familial">pack_familial</option>
        <option value="windows_direct">windows_direct</option>
      </select>
    </div>
    <div>
      <button id="btnRafraichir" style="margin-top: 0;">Rafraîchir</button>
    </div>
  </div>
  <div id="listeQrs">Chargement...</div>

  <script>
    // Token : prompt JS (jamais persisté côté serveur, stocké sessionStorage)
    let token = sessionStorage.getItem('admin_token');
    if (!token) {
      token = prompt('Token admin (X-Admin-Token) :');
      if (token) sessionStorage.setItem('admin_token', token);
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
      })[c]);
    }

    function formatDate(ts) {
      if (!ts) return '—';
      const d = new Date(ts * 1000);
      return d.toLocaleString('fr-CA');
    }

    function formatExpiration(q) {
      // Mode A : expire_le déjà défini (date fixe absolue)
      // Mode B activé : expire_le calculé à l'activation
      // Mode B non-activé : duree_apres_activation_jours défini, expire_le NULL
      // Aucune : tout NULL
      if (q.expire_le === null && q.duree_apres_activation_jours === null) {
        return '<span class="badge expire-jamais">Jamais</span>';
      }
      if (q.expire_le === null && q.duree_apres_activation_jours !== null) {
        return '<span class="badge expire-jamais">' + q.duree_apres_activation_jours + 'j à activation</span>';
      }
      // expire_le défini : calculer combien de temps il reste
      const now_sec = Math.floor(Date.now() / 1000);
      const diff = q.expire_le - now_sec;
      const d = new Date(q.expire_le * 1000);
      const dateStr = d.toLocaleDateString('fr-CA');
      if (diff < 0) {
        const jours_passes = Math.floor(-diff / 86400);
        return '<span class="badge expire-deja">Expiré (' + dateStr + ', il y a ' + jours_passes + 'j)</span>';
      }
      const jours_restants = Math.floor(diff / 86400);
      if (jours_restants < 7) {
        return '<span class="badge expire-imminent">' + dateStr + ' (dans ' + jours_restants + 'j)</span>';
      }
      if (jours_restants < 30) {
        return '<span class="badge expire-prochain">' + dateStr + ' (dans ' + jours_restants + 'j)</span>';
      }
      return dateStr + ' (dans ' + jours_restants + 'j)';
    }

    async function apiCall(url, opts = {}) {
      const headers = {
        'X-Admin-Token': token,
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      };
      const res = await fetch(url, { ...opts, headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erreur ' + res.status);
      return data;
    }

    // Génération
    document.getElementById('formGenerer').addEventListener('submit', async e => {
      e.preventDefault();
      const form = e.target;
      const btn = document.getElementById('btnGenerer');
      const resultat = document.getElementById('resultatGeneration');
      btn.disabled = true;
      btn.textContent = 'Génération en cours...';
      resultat.innerHTML = '';
      try {
        const body = {
          source: form.source.value,
          produit_id: form.produit_id.value,
          nb: Number(form.nb.value),
          note_interne: form.note_interne.value,
          expiration_mode: form.expiration_mode.value
        };
        if (body.expiration_mode === 'date_fixe') {
          body.expire_le_iso = form.expire_le_iso.value;
          if (!body.expire_le_iso) {
            throw new Error('Date d\\'expiration requise (mode date fixe).');
          }
        } else if (body.expiration_mode === 'duree_jours') {
          body.duree_jours = Number(form.duree_jours.value);
          if (!body.duree_jours || body.duree_jours < 1) {
            throw new Error('Nombre de jours invalide (mode durée).');
          }
        }
        const data = await apiCall('/api/admin/qr/generer', {
          method: 'POST', body: JSON.stringify(body)
        });
        resultat.innerHTML = '<div class="resultat">' +
          '<strong>✅ ' + data.cles_qr.length + ' QR généré(s)</strong> ' +
          '(source: ' + escapeHtml(data.source) + ', produit: ' +
          escapeHtml(data.produit_id) + ')<br><br>' +
          data.cles_qr.map(c => '<span class="cle">' + escapeHtml(c) + '</span>').join(' ') +
          '<br><br><small>Copie ces clés et donne-les à ton client / utilise-les pour tester.</small>' +
          '</div>';
        chargerListe();
      } catch (err) {
        resultat.innerHTML = '<div class="erreur">❌ ' + escapeHtml(err.message) + '</div>';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Générer les QR';
      }
    });

    // Liste + filtre
    async function chargerListe() {
      const liste = document.getElementById('listeQrs');
      liste.innerHTML = 'Chargement...';
      try {
        const source = document.getElementById('filtreSource').value;
        const url = '/api/admin/qr/lister' + (source ? '?source=' + encodeURIComponent(source) : '');
        const data = await apiCall(url);
        if (data.qrs.length === 0) {
          liste.innerHTML = '<p><em>Aucun QR manuel pour le moment.</em></p>';
          return;
        }
        let html = '<p>' + data.total + ' QR au total (affichés : ' + data.qrs.length + ')</p>';
        html += '<table><thead><tr>' +
          '<th>Clé</th><th>Source</th><th>Produit</th>' +
          '<th>Créé le</th><th>État</th><th>Expiration</th><th>Élève</th><th>Actions</th>' +
          '</tr></thead><tbody>';
        for (const q of data.qrs) {
          let etat = '';
          if (q.est_revoquee) etat = '<span class="badge revoquee">révoqué</span>';
          else if (q.est_active) etat = '<span class="badge active">activé</span>';
          else etat = '<span class="badge inactif">non activé</span>';
          html += '<tr>' +
            '<td class="cle" style="font-size: 0.95rem; background: none; border: 0; padding: 0.6rem 0.8rem;">' +
              escapeHtml(q.cle_qr) + '</td>' +
            '<td><span class="badge ' + escapeHtml(q.source) + '">' + escapeHtml(q.source) + '</span></td>' +
            '<td>' + escapeHtml(q.produit_id) + '</td>' +
            '<td>' + formatDate(q.date_creation) + '</td>' +
            '<td>' + etat + '</td>' +
            '<td>' + formatExpiration(q) + '</td>' +
            '<td>' + (q.eleve ? escapeHtml(q.eleve) : '—') + '</td>' +
            '<td class="actions">' +
              (q.est_revoquee ? '—' :
                '<button onclick="revoquer(\\'' + escapeHtml(q.cle_brute) + '\\')">Révoquer</button>') +
            '</td>' +
          '</tr>';
        }
        html += '</tbody></table>';
        liste.innerHTML = html;
      } catch (err) {
        liste.innerHTML = '<div class="erreur">❌ ' + escapeHtml(err.message) + '</div>';
      }
    }

    async function revoquer(cleBrute) {
      const raison = prompt('Raison de la révocation (optionnel) :', 'admin_manuel');
      if (raison === null) return; // annulé
      try {
        await apiCall('/api/admin/qr/revoquer', {
          method: 'POST',
          body: JSON.stringify({ cle_qr: cleBrute, raison: raison || 'admin_manuel' })
        });
        chargerListe();
      } catch (err) {
        alert('Erreur : ' + err.message);
      }
    }

    document.getElementById('btnRafraichir').addEventListener('click', chargerListe);
    document.getElementById('filtreSource').addEventListener('change', chargerListe);

    // ───────────────────────────────────────────────────────────────────
    // Toggle des blocs d'expiration selon le mode choisi
    // ───────────────────────────────────────────────────────────────────
    document.querySelectorAll('input[name="expiration_mode"]').forEach(radio => {
      radio.addEventListener('change', e => {
        document.getElementById('blocDateFixe').style.display =
          e.target.value === 'date_fixe' ? 'block' : 'none';
        document.getElementById('blocDureeJours').style.display =
          e.target.value === 'duree_jours' ? 'block' : 'none';
      });
    });

    // Chargement initial
    chargerListe();
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline';",
    },
  });
}
