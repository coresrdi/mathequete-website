/**
 * Webhook Stripe — événement `checkout.session.completed` (DEC-29).
 *
 * Flow :
 * 1. Stripe envoie le webhook après paiement réussi
 * 2. Vérification signature HMAC Stripe (sécurité)
 * 3. Lecture du tier dans metadata.tier
 * 4. Génération d'un code de licence HMAC (generate-codes.ts)
 * 5. Persistance en D1 (tables `licences` + `achats`)
 * 6. Envoi email Resend avec code + CSV
 * 7. Retour 200 à Stripe (sinon il retente)
 *
 * PATCH abonnement — 22 mai 2026 :
 * Les tiers avec duree: 'annuel' (continent_1, pack_5_continent_1) utilisent
 * mode: 'subscription' + price_id Stripe livemode au lieu de price_data inline.
 * Stripe interdit price_data en mode subscription.
 */

import Stripe from 'stripe';
import type { Env } from './types';
import { PRIX_TIERS_CENTS } from './types';
import {
  genererId,
  genererCode,
  tierVersType,
  expirationParDefaut,
  nbElevesPourTier,
  nbCodesPourTier
} from './generate-codes';
import { envoyerLicenceEmise } from './email';
import {
  estTierEcole,
  lireMetadataEcole,
  traiterAchatEcole
} from './webhook-school';
import {
  validerFormatCodeCourt,
  verifierDisponibiliteCodeEcole,
  obtenirOuCreerCommission
} from './commissions';

export async function handleStripeWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const sig = request.headers.get('stripe-signature');
  if (!sig) return new Response('Missing stripe-signature', { status: 400 });

  const payload = await request.text();
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: env.STRIPE_API_VERSION as Stripe.LatestApiVersion,
    httpClient: Stripe.createFetchHttpClient()
  });

  // ===== 1. Vérification signature webhook =====
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      payload,
      sig,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[Stripe webhook] signature invalide :', err);
    return new Response('Signature invalide', { status: 400 });
  }

  // ===== 2. Filtre événements pertinents =====
  if (event.type !== 'checkout.session.completed') {
    return new Response(`Événement ignoré : ${event.type}`, { status: 200 });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const tier = session.metadata?.tier;
  const email = session.customer_details?.email ?? session.customer_email;
  const nom = session.customer_details?.name ?? undefined;

  if (!tier || !PRIX_TIERS_CENTS[tier]) {
    console.error('[Webhook] tier manquant ou inconnu :', tier);
    return new Response('Tier invalide', { status: 400 });
  }
  if (!email) {
    console.error('[Webhook] email manquant dans session', session.id);
    return new Response('Email manquant', { status: 400 });
  }

  // ===== 2.5. Branche école (Sprint PB1, D7 additif) =====
  // Si le tier est un palier école (>1 élève, pas un pack_5), on délègue
  // à webhook-school.ts qui génère N clés QR + PDF + email. La branche
  // individuelle existante (continent_1, pack_5_continent_1) reste intacte.
  if (estTierEcole(tier)) {
    const metaEcole = lireMetadataEcole(session);
    if (!metaEcole) {
      console.error('[Webhook] metadata école incomplète', session.id, session.metadata);
      return new Response('Metadata école manquante', { status: 400 });
    }
    return traiterAchatEcole(env, ctx, session, metaEcole, event);
  }

  // ===== 3. Vérifier qu'on n'a pas déjà traité cette session (idempotence) =====
  const dejaFait = await env.DB
    .prepare('SELECT licence_id FROM achats WHERE stripe_session_id = ?')
    .bind(session.id)
    .first<{ licence_id: string }>();

  if (dejaFait?.licence_id) {
    console.log('[Webhook] session déjà traitée :', session.id);
    return new Response('OK (déjà traité)', { status: 200 });
  }

  // ===== 4. Génération des codes de licence (1 ou plusieurs pour Pack 5) =====
  const type = tierVersType(tier);
  const expire_le = expirationParDefaut(type);
  const nbCodes = nbCodesPourTier(tier);
  const nbElevesMax = nbElevesPourTier(tier);
  const now = Math.floor(Date.now() / 1000);
  const tarif = PRIX_TIERS_CENTS[tier];

  const licences: Array<{ id: string; code_affiche: string }> = [];
  for (let i = 0; i < nbCodes; i++) {
    const id = genererId('c');
    const { code_affiche } = await genererCode(
      { type, id, expire_le },
      env.HMAC_SECRET_KEY
    );
    licences.push({ id, code_affiche });
  }

  // licence_id stocké dans la table `achats` pointe sur la première licence du lot
  const primaryLicenceId = licences[0].id;
  const codesAffiches = licences.map(l => l.code_affiche);

  // ===== 5. Persistance D1 (atomique : N licences + 1 achat) =====
  const stmts = licences.map(l => env.DB.prepare(`
    INSERT INTO licences
    (id, code, type, tier, nb_eleves_max, emis_le, expire_le,
     email_acheteur, nom_acheteur, stripe_session, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stripe')
  `).bind(
    l.id, l.code_affiche, type, tier, nbElevesMax,
    now, expire_le, email, nom ?? null, session.id
  ));

  stmts.push(
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
      nom ?? null,
      primaryLicenceId,
      now,
      JSON.stringify(event)
    )
  );

  await env.DB.batch(stmts);

  // ===== 6. Envoi email Resend (1 email avec tous les codes) =====
  const totalCAD = (session.amount_total ?? tarif.prix_cents) / 100;
  const resp = await envoyerLicenceEmise(env, {
    email,
    nom,
    codes_affiches: codesAffiches,
    tier,
    nb_eleves_max: nbElevesMax,
    expire_le,
    montant_paye_cad: totalCAD
  });

  // Audit log envoi email
  const sujetEmail = nbCodes > 1
    ? `★ Vos ${nbCodes} licences Mathéquête (Pack 5)`
    : `★ Votre licence Mathéquête : ${codesAffiches[0]}`;
  await env.DB.prepare(`
    INSERT INTO emails_envoyes
    (destinataire, sujet, type, licence_id, envoye_le, resend_id, statut, erreur)
    VALUES (?, ?, 'licence_emise', ?, ?, ?, ?, ?)
  `).bind(
    email,
    sujetEmail,
    primaryLicenceId,
    now,
    resp.id ?? null,
    resp.error ? 'failed' : 'sent',
    resp.error ? resp.error.message : null
  ).run();

  console.log(`[Webhook] ${nbCodes} licence(s) émise(s) pour ${email} (${tier}) : ${codesAffiches.join(', ')}`);

  return new Response(
    JSON.stringify({ ok: true, codes_affiches: codesAffiches, licence_id: primaryLicenceId }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

/* ===== Création d'une session Stripe Checkout =====
 * Appelée depuis le bouton "Acheter" du site (achat.html).
 *
 * PATCH abonnement (22 mai 2026) :
 * - duree === 'annuel'  → mode: 'subscription' + price_id Stripe livemode
 * - duree === 'permanent' | 'ecole' → mode: 'payment' + price_data inline (inchangé)
 */
export async function handleCreateCheckoutSession(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: {
    tier?: string;
    email_admin?: string;   // requis pour paliers école
    ecole_nom?: string;
    code_court?: string;
    commission_type?: 'publique' | 'privee';
    commission_nom?: string;
  };
  try {
    body = await request.json();
  } catch {
    return jsonError('Corps JSON invalide', 400);
  }

  const tier = body.tier;
  if (!tier || !PRIX_TIERS_CENTS[tier]) {
    return jsonError('Tier invalide', 400);
  }
  const tarif = PRIX_TIERS_CENTS[tier];

  // ===== Branche école : validation + réservation atomique du code (D9+D10) =====
  // On exige toute la metadata métier AVANT de créer la session Stripe pour
  // éviter qu'un paiement valide soit bloqué en webhook par un code en conflit.
  let metadataExtra: Record<string, string> = {};
  if (estTierEcole(tier)) {
    if (!body.email_admin || !body.ecole_nom || !body.code_court
        || !body.commission_type || !body.commission_nom) {
      return jsonError('Champs requis manquants pour palier école (email_admin, ecole_nom, code_court, commission_type, commission_nom)', 400);
    }
    const formatChk = validerFormatCodeCourt(body.code_court);
    if (!formatChk.ok) return jsonError(formatChk.erreur ?? 'Code école invalide', 400);

    // Résolution commission (création différée à webhook — ici on vérifie juste
    // la dispo logique ; on ne touche pas la DB tant que Stripe n'a pas payé).
    // EXCEPTION : on doit créer la commission pour pouvoir tester la dispo D9,
    // car celle-ci s'exprime par (commission_code, code_court). On crée donc
    // la commission ici — c'est sans impact même si l'achat est abandonné
    // (la commission existe juste, elle ne consomme rien).
    const { code: commission_code } = await obtenirOuCreerCommission(env, {
      nom: body.commission_nom,
      type: body.commission_type,
      email_admin: body.email_admin,
      ecole_nom: body.ecole_nom
    });
    const dispo = await verifierDisponibiliteCodeEcole(env, {
      commission_code,
      code_court: body.code_court,
      email_admin: body.email_admin
    });
    if (!dispo.disponible) {
      return new Response(
        JSON.stringify({
          error: 'Code école déjà utilisé par un autre administrateur dans les 180 derniers jours.',
          raison: dispo.raison,
          alternatives: dispo.alternatives ?? []
        }),
        { status: 409, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      );
    }
    metadataExtra = {
      ecole_nom: body.ecole_nom,
      code_court: body.code_court,
      commission_type: body.commission_type,
      commission_nom: body.commission_nom
    };
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: env.STRIPE_API_VERSION as Stripe.LatestApiVersion,
    httpClient: Stripe.createFetchHttpClient()
  });

  // ===== PATCH abonnement : détecter si le tier est récurrent =====
  // duree === 'annuel' → subscription (continent_1, pack_5_continent_1)
  // duree === 'permanent' | 'ecole' → payment one-time (inchangé)
  const isRecurring = tarif.duree === 'annuel';

  let session: Stripe.Checkout.Session;

  if (isRecurring) {
    // ── Mode abonnement ───────────────────────────────────────────────────────
    // price_data interdit en mode subscription — on utilise le price_id livemode
    // stocké dans PRIX_TIERS_CENTS[tier].stripe_price_id (types.ts).
    session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price: tarif.stripe_price_id,
        quantity: 1
      }],
      automatic_tax: { enabled: true },
      metadata: { tier, ...metadataExtra },
      customer_email: body.email_admin,
      success_url: `${env.PUBLIC_SITE_URL}/merci.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.PUBLIC_SITE_URL}/achat.html`
    });
  } else {
    // ── Mode paiement unique (code original inchangé) ─────────────────────────
    const isIndividuel = tier.startsWith('continent') || tier.startsWith('pack_5_continent');
    const description = tarif.nb_codes > 1
      ? `${tarif.nb_codes} codes permanents, 1 appareil par code`
      : (isIndividuel
        ? `Licence permanente, 1 appareil`
        : `Licence annuelle ${tarif.nb_eleves} élèves`);

    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'cad',
          product_data: {
            name: `Mathéquête — ${tarif.nom}`,
            description: description
          },
          unit_amount: tarif.prix_cents
        },
        quantity: 1
      }],
      automatic_tax: { enabled: true },
      metadata: { tier, ...metadataExtra },
      customer_email: body.email_admin,
      success_url: `${env.PUBLIC_SITE_URL}/merci.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.PUBLIC_SITE_URL}/achat.html`
    });
  }

  return new Response(
    JSON.stringify({ url: session.url, session_id: session.id }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    }
  );
}

function jsonError(message: string, status: number): Response {
  return new Response(
    JSON.stringify({ error: message }),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    }
  );
}
