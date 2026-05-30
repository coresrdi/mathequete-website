/**
 * Branche école du webhook Stripe — Sprint PB1 (D5/D7/D8/D9/D10).
 *
 * Activée quand `tier` correspond à un palier école (>1 clé QR).
 *
 * Flux :
 *   1. Récupère metadata étendue : ecole_nom, code_court, commission_*
 *   2. (Re)crée la commission scolaire (D10) → commission_code
 *   3. Re-vérifie la dispo du code école (D9) — défense en profondeur
 *      (le front a déjà validé via /api/commissions/disponibilite-code).
 *   4. INSERT 1 ligne `licences` "parent" HMAC (D7 additif, pas de mutation).
 *   5. INSERT 1 ligne `achats`.
 *   6. INSERT 1 ligne `forfaits_ecole` (statut PDF = 'en_attente').
 *   7. Génère N clés QR uniques (qr-gen.ts) + INSERT batch dans `licences_qr`.
 *   8. Si nbCles ≤ SEUIL_PDF_AUTO (D8) :
 *        - ctx.waitUntil(genererPdfEtNotifier(...)) → PDF + R2 + email
 *      Sinon :
 *        - pdf_statut='manuel_requis' + email "manuel sous 24-48h"
 *
 * IMPORTANT : tout l'INSERT (étapes 4-7) doit être atomique. D1 supporte
 * `batch()` qui exécute en transaction implicite.
 */

import type { Env } from './types';
import { PRIX_TIERS_CENTS } from './types';
import type Stripe from 'stripe';
import {
  genererId,
  genererCode,
  tierVersType,
  expirationParDefaut,
  nbElevesPourTier,
  nbClesQrPourTier
} from './generate-codes';
import { genererLotClesQrUniques } from './qr-gen';
import { genererPdfForfait, type InfosForfaitPdf } from './pdf-gen';
import {
  obtenirOuCreerCommission,
  verifierDisponibiliteCodeEcole,
  validerFormatCodeCourt
} from './commissions';
import {
  cheminR2Pdf,
  uploaderPdfR2,
  genererJetonPdf,
  urlTelechargementPdf
} from './r2-upload';
import { envoyerEmail } from './email';

/** Seuil D8 : au-dessus, génération PDF différée manuellement sur CPU local. */
export const SEUIL_PDF_AUTO = 100;

/** Métadonnées Stripe métier pour un achat école. */
export interface MetadataAchatEcole {
  tier: string;
  ecole_nom: string;
  code_court: string;
  commission_type: 'publique' | 'privee';
  commission_nom: string;     // nom CS publique OU nom école (réutilisé pour virtuelle privée)
}

/** Lit + valide les metadata Stripe pour une session école.
 *  Retourne null si une donnée critique manque (le webhook doit refuser).
 */
export function lireMetadataEcole(session: Stripe.Checkout.Session): MetadataAchatEcole | null {
  const m = session.metadata ?? {};
  if (!m.tier || !m.ecole_nom || !m.code_court || !m.commission_type || !m.commission_nom) {
    return null;
  }
  if (m.commission_type !== 'publique' && m.commission_type !== 'privee') return null;
  return {
    tier: m.tier,
    ecole_nom: m.ecole_nom,
    code_court: m.code_court,
    commission_type: m.commission_type,
    commission_nom: m.commission_nom
  };
}

/** Détecte si le tier est un palier école (nb_cles_qr > 1 ET pas un pack_5 individuel). */
export function estTierEcole(tier: string): boolean {
  const tarif = PRIX_TIERS_CENTS[tier];
  if (!tarif) return false;
  // Paliers école : nb_eleves > 1 ET tier ne commence pas par 'pack_5_'
  return tarif.nb_eleves > 1 && !tier.startsWith('pack_5_');
}

/* ──────────────────────────── Handler principal ────────────────────────── */

export async function traiterAchatEcole(
  env: Env,
  ctx: ExecutionContext,
  session: Stripe.Checkout.Session,
  meta: MetadataAchatEcole,
  rawEvent: unknown
): Promise<Response> {
  const tier = meta.tier;
  const tarif = PRIX_TIERS_CENTS[tier];
  const email = session.customer_details?.email ?? session.customer_email;
  const nom = session.customer_details?.name ?? null;

  if (!email) {
    console.error('[Webhook École] email manquant', session.id);
    return new Response('Email manquant', { status: 400 });
  }

  // ===== Validation format code_court (défense en profondeur) =====
  const formatChk = validerFormatCodeCourt(meta.code_court);
  if (!formatChk.ok) {
    console.error('[Webhook École] code_court invalide :', formatChk.erreur);
    return new Response('Code école invalide', { status: 400 });
  }

  // ===== Idempotence : session déjà traitée ? =====
  const dejaFaitForfait = await env.DB
    .prepare('SELECT id FROM forfaits_ecole WHERE stripe_session_id = ?')
    .bind(session.id)
    .first<{ id: number }>();
  if (dejaFaitForfait) {
    console.log('[Webhook École] session déjà traitée :', session.id);
    return new Response('OK (déjà traité)', { status: 200 });
  }

  // ===== Étape 2 : Commission (D10) =====
  const { code: commission_code } = await obtenirOuCreerCommission(env, {
    nom: meta.commission_nom,
    type: meta.commission_type,
    email_admin: email,
    ecole_nom: meta.ecole_nom
  });

  // ===== Étape 3 : Re-vérif dispo code école (D9) — défense en profondeur =====
  // En cas de course Stripe (2 paiements concurrents avec même code), c'est
  // ici qu'on bloque. Le front a déjà validé, mais ce check est notre filet.
  const dispo = await verifierDisponibiliteCodeEcole(env, {
    commission_code,
    code_court: meta.code_court,
    email_admin: email
  });
  if (!dispo.disponible) {
    // Conflit rare : on remboursera manuellement. On loggue et alerte.
    console.error('[Webhook École] CONFLIT D9 post-paiement', {
      session: session.id, commission_code, code_court: meta.code_court, email
    });
    // On retourne 200 pour ne pas faire retenter Stripe — c'est traité hors-bande.
    // TODO PB1.1 : email automatique à coresrdi@gmail.com pour remboursement.
    return new Response('OK (conflit D9 — traitement manuel)', { status: 200 });
  }

  // ===== Étape 4 : Génération de la licence HMAC parent (D7 additif) =====
  const type = tierVersType(tier);                  // 'classe' | 'ecole'
  const expire_le = expirationParDefaut(type);
  const now = Math.floor(Date.now() / 1000);
  const nbCles = nbClesQrPourTier(tier);
  const nbElevesMax = nbElevesPourTier(tier);

  const licenceParentId = genererId('c');
  const { code_affiche } = await genererCode(
    { type, id: licenceParentId, expire_le },
    env.HMAC_SECRET_KEY
  );

  // ===== Étape 5+6+7 : Persistance atomique D1 =====
  // ORDRE :  1) licences (parent)
  //          2) achats
  //          3) forfaits_ecole
  //          4) (après batch) génération clés QR + INSERT licences_qr en batch
  //
  // On NE PEUT PAS insérer licences_qr dans le même batch que forfaits_ecole
  // car on a besoin du forfait_ecole.id (AUTOINCREMENT) qu'on récupère après.

  const stmtsPrincipaux = [
    env.DB.prepare(`
      INSERT INTO licences
        (id, code, type, tier, nb_eleves_max, emis_le, expire_le,
         email_acheteur, nom_acheteur, stripe_session, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stripe')
    `).bind(
      licenceParentId, code_affiche, type, tier, nbElevesMax,
      now, expire_le, email, nom, session.id
    ),
    env.DB.prepare(`
      INSERT INTO achats
        (stripe_session_id, stripe_payment_id, tier, montant_cents,
         tps_cents, tvq_cents, total_cents, email_acheteur, nom_acheteur,
         licence_id, paye_le, statut, raw_event_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?)
    `).bind(
      session.id,
      typeof session.payment_intent === 'string' ? session.payment_intent : null,
      tier,
      tarif.prix_cents,
      Math.round(tarif.prix_cents * 0.05),
      Math.round(tarif.prix_cents * 0.09975),
      session.amount_total ?? tarif.prix_cents,
      email,
      nom,
      licenceParentId,
      now,
      JSON.stringify(rawEvent)
    ),
    env.DB.prepare(`
      INSERT INTO forfaits_ecole
        (stripe_session_id, stripe_payment_id, licence_id_hmac, commission_code,
         ecole_nom, code_court, produit_id, tier, nb_licences_total,
         prix_paye_cents, email_admin, nom_admin, date_achat, pdf_statut)
      VALUES (?, ?, ?, ?, ?, ?, 'continent_1', ?, ?, ?, ?, ?, ?, 'en_attente')
    `).bind(
      session.id,
      typeof session.payment_intent === 'string' ? session.payment_intent : null,
      licenceParentId,
      commission_code,
      meta.ecole_nom,
      meta.code_court,
      tier,
      nbCles,
      tarif.prix_cents,
      email,
      nom,
      now
    )
  ];

  await env.DB.batch(stmtsPrincipaux);

  // Récupère l'ID auto-incrémenté du forfait_ecole qu'on vient d'insérer
  const ligneForfait = await env.DB
    .prepare('SELECT id FROM forfaits_ecole WHERE stripe_session_id = ?')
    .bind(session.id)
    .first<{ id: number }>();
  if (!ligneForfait) {
    // Très improbable, mais on doit savoir
    console.error('[Webhook École] forfait_ecole introuvable après INSERT', session.id);
    return new Response('Erreur interne forfait', { status: 500 });
  }
  const forfaitId = ligneForfait.id;

  // ===== Étape 7 : Génération + INSERT batch des N clés QR =====
  const clesQr = await genererLotClesQrUniques(env, nbCles);
  // DEC-59 : source = 'ecole' (achat forfait école via Stripe)
  const stmtsQr = clesQr.map((cle, idx) => env.DB.prepare(`
    INSERT INTO licences_qr
      (cle_qr, forfait_ecole_id, licence_id_hmac, produit_id,
       numero_sequence, source, date_creation)
    VALUES (?, ?, ?, 'continent_1', ?, 'ecole', ?)
  `).bind(cle, forfaitId, licenceParentId, idx + 1, now));
  await env.DB.batch(stmtsQr);

  console.log(`[Webhook École] forfait ${forfaitId} : ${nbCles} QR insérés pour ${meta.ecole_nom} (${meta.code_court})`);

  // ===== Étape 8 : PDF auto (D8) ou différé manuel =====
  if (nbCles <= SEUIL_PDF_AUTO) {
    // Différé en background — la Response Stripe part avant la fin du PDF.
    ctx.waitUntil(genererPdfEtNotifier(env, {
      forfait_id: forfaitId,
      ecole_nom: meta.ecole_nom,
      code_court: meta.code_court,
      tier_nom: tarif.nom,
      nb_licences: nbCles,
      email_admin: email,
      nom_admin: nom,
      date_achat: now,
      cles_qr: clesQr
    }));
  } else {
    // Au-delà du seuil : marquer + email "manuel"
    await env.DB
      .prepare(`UPDATE forfaits_ecole SET pdf_statut = 'manuel_requis' WHERE id = ?`)
      .bind(forfaitId).run();
    ctx.waitUntil(envoyerEmailAttenteManuel(env, {
      email_admin: email,
      nom_admin: nom,
      ecole_nom: meta.ecole_nom,
      tier_nom: tarif.nom,
      nb_licences: nbCles,
      forfait_id: forfaitId
    }));
  }

  return new Response(
    JSON.stringify({
      ok: true,
      forfait_id: forfaitId,
      licence_parent_id: licenceParentId,
      nb_cles_qr: nbCles,
      pdf_statut: nbCles <= SEUIL_PDF_AUTO ? 'en_cours_auto' : 'manuel_requis'
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

/* ─────────────────────── Génération PDF différée (auto ≤100) ─────────── */

interface ParamsGenerationPdf {
  forfait_id: number;
  ecole_nom: string;
  code_court: string;
  tier_nom: string;
  nb_licences: number;
  email_admin: string;
  nom_admin: string | null;
  date_achat: number;
  cles_qr: string[];
}

/** Genere le PDF, upload vers R2, met à jour forfaits_ecole, envoie email. */
async function genererPdfEtNotifier(env: Env, p: ParamsGenerationPdf): Promise<void> {
  try {
    const infos: InfosForfaitPdf = {
      ecole_nom: p.ecole_nom,
      code_court: p.code_court,
      tier_nom: p.tier_nom,
      produit_nom: 'Continent 1',
      nb_licences: p.nb_licences,
      email_admin: p.email_admin,
      date_achat: p.date_achat
    };
    const pdfBytes = await genererPdfForfait(infos, p.cles_qr);

    const chemin = cheminR2Pdf(p.forfait_id, p.date_achat);
    await uploaderPdfR2(env, chemin, pdfBytes, {
      forfait_id: p.forfait_id,
      ecole_nom: p.ecole_nom,
      code_court: p.code_court
    });

    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`
      UPDATE forfaits_ecole
      SET pdf_r2_path = ?, pdf_genere_date = ?, pdf_statut = 'genere'
      WHERE id = ?
    `).bind(chemin, now, p.forfait_id).run();

    // Génère lien signé 30j + envoie email
    const jeton = await genererJetonPdf(env, p.forfait_id);
    const urlPdf = urlTelechargementPdf(env, p.forfait_id, jeton);
    await envoyerEmailForfaitPret(env, {
      email_admin: p.email_admin,
      nom_admin: p.nom_admin,
      ecole_nom: p.ecole_nom,
      tier_nom: p.tier_nom,
      nb_licences: p.nb_licences,
      url_pdf: urlPdf
    });
    console.log(`[PDF auto] forfait ${p.forfait_id} OK → ${chemin}`);
  } catch (err) {
    console.error('[PDF auto] échec forfait', p.forfait_id, err);
    // On laisse pdf_statut='en_attente' pour qu'un endpoint admin puisse retry.
  }
}

/* ─────────────────────── Emails (à factoriser avec email.ts) ───────────── */

interface ParamsEmailForfaitPret {
  email_admin: string;
  nom_admin: string | null;
  ecole_nom: string;
  tier_nom: string;
  nb_licences: number;
  url_pdf: string;
}

async function envoyerEmailForfaitPret(env: Env, p: ParamsEmailForfaitPret) {
  const sujet = `★ Vos ${p.nb_licences} codes Mathéquête — ${p.ecole_nom}`;
  const html = `
<!DOCTYPE html>
<html lang="fr"><body style="font-family:system-ui,Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222;">
<h2 style="color:#0a6;">Vos codes Mathéquête sont prêts</h2>
<p>Bonjour${p.nom_admin ? ' ' + escapeHtml(p.nom_admin) : ''},</p>
<p>Merci pour votre achat. Votre forfait <strong>${escapeHtml(p.tier_nom)}</strong> pour
<strong>${escapeHtml(p.ecole_nom)}</strong> contient <strong>${p.nb_licences}</strong> codes QR
prêts à être distribués à vos élèves.</p>
<p style="text-align:center;margin:30px 0;">
  <a href="${p.url_pdf}" style="background:#0a6;color:#fff;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;">📥 Télécharger le PDF des codes</a>
</p>
<p style="font-size:13px;color:#666;">⚠️ Ce lien est valide <strong>30 jours</strong>.
Téléchargez et conservez le PDF en lieu sûr — il contient toutes vos licences.</p>
<h3>Étapes suivantes</h3>
<ol>
  <li>Téléchargez et imprimez (ou découpez numériquement) la grille de codes QR.</li>
  <li>Installez l'app prof Mathéquête sur votre poste, créez vos classes.</li>
  <li>Scannez les QR pour les attribuer à vos élèves.</li>
</ol>
<p style="font-size:12px;color:#999;border-top:1px solid #ddd;padding-top:12px;margin-top:24px;">
Mathéquête · CORES RDI · support@mathequete.com
</p></body></html>`;

  const resp = await envoyerEmail(env, {
    destinataire: p.email_admin,
    sujet,
    html
  });
  await loguerEmail(env, p.email_admin, sujet, 'forfait_ecole_pret', resp);
}

interface ParamsEmailAttenteManuel {
  email_admin: string;
  nom_admin: string | null;
  ecole_nom: string;
  tier_nom: string;
  nb_licences: number;
  forfait_id: number;
}

async function envoyerEmailAttenteManuel(env: Env, p: ParamsEmailAttenteManuel) {
  const sujet = `✓ Achat confirmé — Mathéquête ${p.tier_nom} (${p.ecole_nom})`;
  const html = `
<!DOCTYPE html>
<html lang="fr"><body style="font-family:system-ui,Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222;">
<h2 style="color:#0a6;">Votre achat est confirmé</h2>
<p>Bonjour${p.nom_admin ? ' ' + escapeHtml(p.nom_admin) : ''},</p>
<p>Merci pour votre achat du forfait <strong>${escapeHtml(p.tier_nom)}</strong>
(<strong>${p.nb_licences}</strong> codes QR) pour
<strong>${escapeHtml(p.ecole_nom)}</strong>.</p>
<p style="background:#fff8e0;border-left:4px solid #f5a623;padding:12px;margin:20px 0;">
<strong>⏳ Préparation manuelle en cours</strong><br>
Vu le grand nombre de codes (${p.nb_licences}), votre PDF est en préparation
sur notre poste dédié. Vous recevrez un second courriel avec le lien de
téléchargement <strong>sous 24 à 48 heures ouvrables</strong>.
</p>
<p>Si vous n'avez rien reçu après 48h, écrivez à
<a href="mailto:support@mathequete.com">support@mathequete.com</a> en mentionnant
le numéro de forfait <code>#${p.forfait_id}</code>.</p>
<p style="font-size:12px;color:#999;border-top:1px solid #ddd;padding-top:12px;margin-top:24px;">
Mathéquête · CORES RDI · support@mathequete.com
</p></body></html>`;

  const resp = await envoyerEmail(env, {
    destinataire: p.email_admin,
    sujet,
    html
  });
  await loguerEmail(env, p.email_admin, sujet, 'forfait_ecole_attente_manuel', resp);
}

/** Helper pour logger un envoi email dans `emails_envoyes`.
 *  Aligné sur la convention déjà utilisée par stripe-webhook.ts.
 */
async function loguerEmail(
  env: Env,
  destinataire: string,
  sujet: string,
  typeLog: string,
  resp: { id?: string; error?: { message: string } }
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`
    INSERT INTO emails_envoyes
      (destinataire, sujet, type, licence_id, envoye_le, resend_id, statut, erreur)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
  `).bind(
    destinataire, sujet, typeLog, now,
    resp.id ?? null,
    resp.error ? 'failed' : 'sent',
    resp.error ? resp.error.message : null
  ).run();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]!));
}
