/**
 * Sprint S2 — Activation manuelle par admin (mai 2026)
 *
 * Permet au joueur de soumettre un code promo réutilisable + email + nom + message.
 * L'admin (Claude) reçoit un email avec un lien magique pour approuver/refuser
 * et choisir la durée. Le joueur poll le statut et active automatiquement.
 *
 * Endpoints :
 *   POST /api/activation/request       (joueur soumet la demande)
 *   GET  /api/activation/status        (joueur poll toutes les 30s)
 *   POST /api/activation/redeem        (joueur récupère le code HMAC après approbation)
 *   GET  /admin/decide                 (admin clique le lien magique → form HTML)
 *   POST /admin/decide                 (admin soumet la décision)
 */

import type { Env } from './types';
import { genererCode, genererId } from './generate-codes';
import { envoyerEmailNotificationAdmin } from './email';

/* ===== Constantes ===== */

const MAGIC_TOKEN_VALIDITE_SECS = 24 * 3600; // 24h
const REQUEST_VALIDITE_SECS     = 7 * 24 * 3600; // 7j max pour redeem une fois approuve

const RESPONSES_DUREE: Record<string, number> = {
  'lifetime': 0,
  '1an':      365 * 24 * 3600,
  '6mois':    180 * 24 * 3600,
  '3mois':    90  * 24 * 3600,
};

/* ===== Helpers HTTP ===== */

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

function jsonError(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

/* ===== Helpers crypto ===== */

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function genererTokenMagique(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

function genererRequestId(): string {
  const ts = Math.floor(Date.now() / 1000).toString(16);
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return `req_${ts}${rand}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]!);
}

/* ===== Validations ===== */

function validerEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200;
}

function validerCode(code: string): boolean {
  // 4-40 chars, uppercase, tirets et chiffres ok
  return /^[A-Z0-9\-]{4,40}$/.test(code);
}

/* ===== ENDPOINT 1 : POST /api/activation/request ===== */

interface RequestActivationBody {
  code?: string;
  email?: string;
  nom?: string;
  message?: string;
  device_hash?: string;
}

export async function handleActivationRequest(
  request: Request, env: Env
): Promise<Response> {
  if (request.method !== 'POST') return jsonError('POST required', 405);

  const body = await request.json().catch(() => null) as RequestActivationBody | null;
  if (!body) return jsonError('JSON body required', 400);

  // Validation des champs
  const code = String(body.code || '').trim().toUpperCase();
  const email = String(body.email || '').trim().toLowerCase();
  const nom = String(body.nom || '').trim();
  const message = String(body.message || '').trim().slice(0, 500);
  const deviceHash = String(body.device_hash || '').trim();

  if (!validerCode(code))     return jsonError('Code invalide', 400);
  if (!validerEmail(email))   return jsonError('Email invalide', 400);
  if (!nom || nom.length > 80) return jsonError('Nom invalide', 400);
  if (!/^[a-f0-9]{32,128}$/i.test(deviceHash)) return jsonError('device_hash invalide', 400);

  // Verifier que le code existe, est actif et non-expire
  const codeRow = await env.DB.prepare(
    'SELECT code, max_activations, used_activations, actif, expire_le, label FROM activation_codes WHERE code = ?'
  ).bind(code).first<{
    code: string, max_activations: number, used_activations: number,
    actif: number, expire_le: number, label: string
  }>();

  if (!codeRow)      return jsonError('Code inconnu', 404);
  if (!codeRow.actif) return jsonError('Code desactive', 403);
  if (codeRow.expire_le > 0 && codeRow.expire_le < Math.floor(Date.now() / 1000)) {
    return jsonError('Code expire', 410);
  }
  if (codeRow.used_activations >= codeRow.max_activations) {
    return jsonError('Code epuise (toutes activations utilisees)', 409);
  }

  // Generer request + magic token
  const requestId = genererRequestId();
  const magicToken = genererTokenMagique();
  const magicTokenHash = await sha256Hex(magicToken);
  const now = Math.floor(Date.now() / 1000);
  const magicExpire = now + MAGIC_TOKEN_VALIDITE_SECS;

  // Pays (Cloudflare)
  const ipPays = (request as any).cf?.country || 'XX';

  await env.DB.prepare(`
    INSERT INTO activation_requests (
      request_id, code, email_joueur, nom_joueur, message, device_hash,
      status, magic_token_hash, magic_expire, cree_le, ip_pays
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).bind(
    requestId, code, email, nom, message, deviceHash,
    magicTokenHash, magicExpire, now, ipPays
  ).run();

  // Envoyer email admin (le magicToken EN CLAIR seulement dans l'email)
  try {
    await envoyerEmailNotificationAdmin(env, {
      requestId,
      magicToken,
      code,
      codeLabel: codeRow.label,
      utilisationsRestantes: codeRow.max_activations - codeRow.used_activations - 1,
      email,
      nom,
      message,
      ipPays
    });
  } catch (err) {
    console.error('[manual-activation] erreur envoi email admin :', err);
    // On continue : la demande est sauvegardee, l'admin pourra voir via /admin/list plus tard
  }

  return jsonResponse({
    request_id: requestId,
    status: 'pending',
    message: 'Demande envoyee. L\'administrateur va la valider sous peu.'
  });
}

/* ===== ENDPOINT 2 : GET /api/activation/status ===== */

export async function handleActivationStatus(
  request: Request, env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const requestId = url.searchParams.get('request_id') || '';
  const deviceHash = url.searchParams.get('device_hash') || '';

  if (!requestId || !deviceHash) return jsonError('request_id et device_hash requis', 400);

  const row = await env.DB.prepare(
    'SELECT status, device_hash, raison_refus, decide_le FROM activation_requests WHERE request_id = ?'
  ).bind(requestId).first<{ status: string, device_hash: string, raison_refus: string | null, decide_le: number | null }>();

  if (!row) return jsonError('Demande inconnue', 404);

  // Anti-enumeration : verifier que c'est bien le meme device qui poll
  if (row.device_hash !== deviceHash) return jsonError('device_hash incoherent', 403);

  return jsonResponse({
    status: row.status,
    raison_refus: row.raison_refus,
    decide_le: row.decide_le
  });
}

/* ===== ENDPOINT 3 : POST /api/activation/redeem ===== */

interface RedeemBody {
  request_id?: string;
  device_hash?: string;
}

export async function handleActivationRedeem(
  request: Request, env: Env
): Promise<Response> {
  if (request.method !== 'POST') return jsonError('POST required', 405);

  const body = await request.json().catch(() => null) as RedeemBody | null;
  if (!body) return jsonError('JSON body required', 400);

  const requestId = String(body.request_id || '').trim();
  const deviceHash = String(body.device_hash || '').trim();

  if (!requestId || !deviceHash) return jsonError('request_id et device_hash requis', 400);

  const row = await env.DB.prepare(`
    SELECT status, device_hash, licence_type, expire_le, code, code_affiche, cree_le
    FROM activation_requests WHERE request_id = ?
  `).bind(requestId).first<{
    status: string, device_hash: string,
    licence_type: string | null, expire_le: number,
    code: string, code_affiche: string | null, cree_le: number
  }>();

  if (!row) return jsonError('Demande inconnue', 404);
  if (row.device_hash !== deviceHash) return jsonError('device_hash incoherent', 403);
  if (row.status !== 'approved')      return jsonError(`Statut: ${row.status}`, 409);
  if (!row.licence_type)              return jsonError('licence_type manquant', 500);

  // Validite de la demande : 7 jours apres creation
  const now = Math.floor(Date.now() / 1000);
  if (now - row.cree_le > REQUEST_VALIDITE_SECS) {
    return jsonError('Demande expiree (7 jours apres creation)', 410);
  }

  // Si deja redeem, on retourne le meme code (idempotent)
  if (row.code_affiche) {
    // Regenerer le code_brut depuis la base licences pour le renvoyer au client
    const licRow = await env.DB.prepare(
      'SELECT id FROM licences WHERE code = ?'
    ).bind(row.code_affiche).first<{ id: string }>();
    if (!licRow) return jsonError('Licence introuvable apres approbation', 500);
    const codeBrut = await regenererCodeBrut(env, row.licence_type, licRow.id, row.expire_le);
    return jsonResponse({
      code_affiche: row.code_affiche,
      code_brut: codeBrut,
      type: row.licence_type,
      expire_le: row.expire_le
    });
  }

  // Premiere fois : generer le code HMAC, l'inserer dans licences,
  // mettre a jour activation_requests + incrementer used_activations
  const licenceId = genererId('m'); // 'm' = manuel
  const codeGen = await genererCode({
    type: row.licence_type as any,
    id: licenceId,
    expire_le: row.expire_le
  }, env.HMAC_SECRET_KEY);

  // Determiner nb_eleves_max selon le type (LIFETIME/PROMO = illimite cote backend = 9999)
  const nbElevesMax = row.licence_type === 'CLASSE' ? 30
                     : row.licence_type === 'ECOLE' ? 500
                     : 9999;

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO licences (
        id, code, type, tier, nb_eleves_max, emis_le, expire_le,
        email_acheteur, nom_acheteur, source, metadata_json
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'cli_manuel', ?)
    `).bind(
      licenceId, codeGen.code_affiche, row.licence_type, nbElevesMax,
      now, row.expire_le, '', '', // email/nom dans activation_requests
      JSON.stringify({ request_id: requestId, source_code: row.code })
    ),
    env.DB.prepare(`
      UPDATE activation_requests
      SET licence_id = ?, code_affiche = ?, redeem_le = ?
      WHERE request_id = ?
    `).bind(licenceId, codeGen.code_affiche, now, requestId),
    env.DB.prepare(`
      UPDATE activation_codes
      SET used_activations = used_activations + 1
      WHERE code = ?
    `).bind(row.code)
  ]);

  return jsonResponse({
    code_affiche: codeGen.code_affiche,
    code_brut: codeGen.code_brut,
    type: row.licence_type,
    expire_le: row.expire_le
  });
}

async function regenererCodeBrut(env: Env, type: string, id: string, expire_le: number): Promise<string> {
  const gen = await genererCode({ type: type as any, id, expire_le }, env.HMAC_SECRET_KEY);
  return gen.code_brut;
}

/* ===== ENDPOINT 4 : GET /admin/decide?token=X ===== */

export async function handleAdminDecidePage(
  request: Request, env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';
  if (!token) return htmlResponse('<h1>Token manquant</h1>', 400);

  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);

  const row = await env.DB.prepare(`
    SELECT r.request_id, r.code, r.email_joueur, r.nom_joueur, r.message,
           r.status, r.magic_expire, r.cree_le, r.ip_pays, r.raison_refus,
           r.licence_type, r.expire_le,
           c.label as code_label, c.max_activations, c.used_activations
    FROM activation_requests r
    LEFT JOIN activation_codes c ON c.code = r.code
    WHERE r.magic_token_hash = ?
  `).bind(tokenHash).first<any>();

  if (!row) return htmlResponse('<h1>Token invalide ou expire</h1>', 404);
  if (row.magic_expire < now) {
    return htmlResponse('<h1>Lien expire</h1><p>Ce lien magique a depasse les 24h. Recharger l\'email pour generer un nouveau lien n\'est pas possible : creer manuellement le code via /admin si necessaire.</p>', 410);
  }

  return htmlResponse(renderAdminDecidePage(row, token));
}

export async function handleAdminDecideSubmit(
  request: Request, env: Env
): Promise<Response> {
  if (request.method !== 'POST') return htmlResponse('<h1>POST requis</h1>', 405);

  const form = await request.formData();
  const token = String(form.get('token') || '');
  const action = String(form.get('action') || ''); // 'approve' | 'reject'
  const duree = String(form.get('duree') || 'lifetime'); // lifetime | 1an | 6mois | 3mois
  const licenceType = String(form.get('licence_type') || 'PROMO'); // PROMO | LIFETIME | ESSAI
  const raisonRefus = String(form.get('raison_refus') || '').slice(0, 300);

  if (!token) return htmlResponse('<h1>Token manquant</h1>', 400);

  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);

  const row = await env.DB.prepare(
    'SELECT request_id, status, magic_expire FROM activation_requests WHERE magic_token_hash = ?'
  ).bind(tokenHash).first<{ request_id: string, status: string, magic_expire: number }>();

  if (!row)                       return htmlResponse('<h1>Token invalide</h1>', 404);
  if (row.magic_expire < now)     return htmlResponse('<h1>Lien expire</h1>', 410);
  if (row.status !== 'pending')   return htmlResponse(`<h1>Deja decide (${row.status})</h1>`, 409);

  if (action === 'approve') {
    const dureeSecs = RESPONSES_DUREE[duree] ?? 0;
    const expireLe = dureeSecs === 0 ? 0 : (now + dureeSecs);
    await env.DB.prepare(`
      UPDATE activation_requests
      SET status = 'approved', licence_type = ?, expire_le = ?, decide_le = ?,
          decide_par = 'coresrdi@gmail.com'
      WHERE request_id = ?
    `).bind(licenceType, expireLe, now, row.request_id).run();

    return htmlResponse(renderAdminConfirmation('approve', row.request_id, licenceType, duree));
  } else if (action === 'reject') {
    await env.DB.prepare(`
      UPDATE activation_requests
      SET status = 'rejected', raison_refus = ?, decide_le = ?,
          decide_par = 'coresrdi@gmail.com'
      WHERE request_id = ?
    `).bind(raisonRefus || 'Refuse par admin', now, row.request_id).run();

    return htmlResponse(renderAdminConfirmation('reject', row.request_id, '', ''));
  } else {
    return htmlResponse('<h1>Action inconnue</h1>', 400);
  }
}

/* ===== Templates HTML admin ===== */

function renderAdminDecidePage(row: any, token: string): string {
  const dateCree = new Date(row.cree_le * 1000).toLocaleString('fr-CA');
  const restant = (row.max_activations ?? 0) - (row.used_activations ?? 0);

  return `<!DOCTYPE html>
<html lang="fr-CA">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Decision activation Mathequete</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; padding: 20px; margin: 0; }
  .card { max-width: 600px; margin: 30px auto; background: #1e293b; padding: 24px; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.4); }
  h1 { color: #60a5fa; margin-top: 0; }
  .info { background: #0f172a; padding: 12px; border-radius: 6px; margin: 8px 0; font-size: 14px; }
  .info strong { color: #93c5fd; }
  .actions { display: flex; gap: 12px; margin-top: 20px; flex-wrap: wrap; }
  button { padding: 12px 24px; border-radius: 8px; border: none; cursor: pointer; font-size: 15px; font-weight: 600; }
  .approve { background: #16a34a; color: white; }
  .reject  { background: #dc2626; color: white; }
  select, input, textarea { background: #0f172a; color: #e2e8f0; border: 1px solid #334155; padding: 10px; border-radius: 6px; width: 100%; box-sizing: border-box; margin-bottom: 12px; font-size: 14px; }
  label { display: block; margin-top: 12px; color: #cbd5e1; font-weight: 600; }
  .small { font-size: 13px; color: #94a3b8; }
</style>
</head>
<body>
  <div class="card">
    <h1>Decision activation</h1>
    <div class="info"><strong>Code :</strong> ${escapeHtml(row.code)} <span class="small">(${escapeHtml(row.code_label || '?')}, ${restant} activation(s) restante(s))</span></div>
    <div class="info"><strong>Joueur :</strong> ${escapeHtml(row.nom_joueur)} &lt;${escapeHtml(row.email_joueur)}&gt;</div>
    <div class="info"><strong>Message :</strong> ${escapeHtml(row.message || '(aucun)')}</div>
    <div class="info"><strong>Pays :</strong> ${escapeHtml(row.ip_pays || '?')} &nbsp;&nbsp; <strong>Demande le :</strong> ${dateCree}</div>

    <hr style="border-color: #334155; margin: 20px 0;">

    <form method="POST" action="/admin/decide">
      <input type="hidden" name="token" value="${escapeHtml(token)}">

      <label for="licence_type">Type de licence (si approuve) :</label>
      <select name="licence_type" id="licence_type">
        <option value="PROMO">PROMO (Pack Aventure, illimite)</option>
        <option value="LIFETIME">LIFETIME (Pack Aventure, illimite)</option>
        <option value="ESSAI">ESSAI (acces limite)</option>
      </select>

      <label for="duree">Duree :</label>
      <select name="duree" id="duree">
        <option value="lifetime">A vie (0)</option>
        <option value="1an">1 an</option>
        <option value="6mois">6 mois</option>
        <option value="3mois">3 mois</option>
      </select>

      <label for="raison_refus">Raison du refus (si refus) :</label>
      <textarea name="raison_refus" id="raison_refus" rows="2" placeholder="Optionnel"></textarea>

      <div class="actions">
        <button type="submit" name="action" value="approve" class="approve">Approuver</button>
        <button type="submit" name="action" value="reject"  class="reject">Refuser</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}

function renderAdminConfirmation(action: string, requestId: string, licenceType: string, duree: string): string {
  const titre = action === 'approve' ? 'Approuvee' : 'Refusee';
  const couleur = action === 'approve' ? '#16a34a' : '#dc2626';
  const detail = action === 'approve'
    ? `<p>Type : <strong>${escapeHtml(licenceType)}</strong> &nbsp;|&nbsp; Duree : <strong>${escapeHtml(duree)}</strong></p>
       <p>Le joueur va recevoir le code automatiquement au prochain poll (max 30s).</p>`
    : `<p>Le joueur verra le refus au prochain poll.</p>`;

  return `<!DOCTYPE html>
<html lang="fr-CA"><head><meta charset="UTF-8"><title>Decision enregistree</title>
<style>body { font-family: sans-serif; background: #0f172a; color: #e2e8f0; padding: 40px; text-align: center; }
.card { max-width: 500px; margin: 0 auto; background: #1e293b; padding: 30px; border-radius: 12px; }
h1 { color: ${couleur}; }
</style></head>
<body>
  <div class="card">
    <h1>Demande ${titre}</h1>
    <p>Request ID : <code>${escapeHtml(requestId)}</code></p>
    ${detail}
  </div>
</body></html>`;
}
