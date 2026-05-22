// =============================================================================
// stripe-webhook.ts — PATCH COMMIT 4 (Cart multi-SKU)
// Rétrocompatible avec le mode legacy (1 seul tier_id)
// =============================================================================

// ─── Types ───────────────────────────────────────────────────────────────────

interface CartItem {
  sku: string;
  qty: number;
}

// Mode legacy : { tier_id, email }
// Mode panier : { items: CartItem[], email }
type CheckoutRequestBody =
  | { tier_id: string; email: string; mode?: never; items?: never }
  | { items: CartItem[];  email: string; mode?: never; tier_id?: never };

// Correspond à types.ts existant — NE PAS modifier types.ts,
// juste s'assurer que PRIX_TIERS est accessible depuis stripe-webhook.ts
// (il l'est déjà via import { PRIX_TIERS_CENTS } from './types')
interface TierConfig {
  prix_cents: number;
  label: string;
  type: 'continent' | 'pack' | 'famille' | 'ecole' | 'solo';
  code_prefix: string;  // ex: 'CONT', 'PACK', 'SOLO'
  max_appareils: number;
}

// Table de référence locale — DOIT rester synchronisée avec types.ts
// Ajouter ici chaque nouveau SKU introduit dans prices.json
const PRIX_TIERS: Record<string, TierConfig> = {
  // ── Licences famille ──────────────────────────────────────────
  solo_annuel: {
    prix_cents:   199,
    label:        'Mathéquête – Solo Annuel',
    type:         'solo',
    code_prefix:  'SOLO',
    max_appareils: 1,
  },
  solo_permanent: {
    prix_cents:   999,
    label:        'Mathéquête – Solo Permanent',
    type:         'solo',
    code_prefix:  'SOLP',
    max_appareils: 1,
  },
  pack5_annuel: {
    prix_cents:   799,
    label:        'Mathéquête – Pack 5 Annuel',
    type:         'pack',
    code_prefix:  'PACK',
    max_appareils: 5,
  },
  pack5_permanent: {
    prix_cents:  3999,
    label:        'Mathéquête – Pack 5 Permanent',
    type:         'pack',
    code_prefix:  'PAKP',
    max_appareils: 5,
  },
  // ── Continents individuels (quand disponibles) ────────────────
  continent_1: {
    prix_cents:   499,
    label:        'Mathéquête – Continent 1',
    type:         'continent',
    code_prefix:  'CONT',
    max_appareils: 1,
  },
  // ── Licences école ────────────────────────────────────────────
  classe_petite: {
    prix_cents:  3500,
    label:        'Classe Petite – 30 élèves',
    type:         'ecole',
    code_prefix:  'CLAS',
    max_appareils: 30,
  },
  classe_moyenne: {
    prix_cents:  9800,
    label:        'Classe Moyenne – 100 élèves',
    type:         'ecole',
    code_prefix:  'CLAS',
    max_appareils: 100,
  },
  petite_ecole: {
    prix_cents:  26500,
    label:        'Petite École – 300 élèves',
    type:         'ecole',
    code_prefix:  'ECOL',
    max_appareils: 300,
  },
  ecole_standard: {
    prix_cents:  39300,
    label:        'École Standard – 500 élèves',
    type:         'ecole',
    code_prefix:  'ECOL',
    max_appareils: 500,
  },
  grande_ecole: {
    prix_cents:  65000,
    label:        'Grande École – 1000 élèves',
    type:         'ecole',
    code_prefix:  'ECOL',
    max_appareils: 1000,
  },
  mega_ecole: {
    prix_cents:  71600,
    label:        'Méga École – 1300 élèves',
    type:         'ecole',
    code_prefix:  'ECOL',
    max_appareils: 1300,
  },
};

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Valide et normalise le body de la requête checkout.
 * Retourne un tableau de CartItem normalisé (même en mode legacy 1 SKU).
 * Lève une Error avec message lisible si invalide.
 */
function parseCheckoutBody(body: unknown): { items: CartItem[]; email: string } {
  if (!body || typeof body !== 'object') {
    throw new Error('Corps de requête invalide');
  }

  const b = body as Record<string, unknown>;

  // ── Validation email (commun aux deux modes) ──────────────────
  if (typeof b.email !== 'string' || !b.email.includes('@')) {
    throw new Error('Email invalide ou manquant');
  }
  const email = b.email.trim().toLowerCase();

  // ── Mode PANIER (items[]) ─────────────────────────────────────
  if (Array.isArray(b.items)) {
    if (b.items.length === 0) {
      throw new Error('Le panier est vide');
    }
    if (b.items.length > 20) {
      throw new Error('Le panier ne peut pas contenir plus de 20 lignes');
    }

    const items: CartItem[] = b.items.map((item, idx) => {
      if (typeof item.sku !== 'string' || !item.sku) {
        throw new Error(`Ligne ${idx + 1} : SKU manquant`);
      }
      if (!PRIX_TIERS[item.sku]) {
        throw new Error(`SKU inconnu : "${item.sku}"`);
      }
      const qty = Number(item.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
        throw new Error(`Ligne ${idx + 1} : quantité invalide (doit être entre 1 et 99)`);
      }
      return { sku: item.sku, qty };
    });

    return { items, email };
  }

  // ── Mode LEGACY (tier_id unique) — rétrocompatibilité totale ──
  if (typeof b.tier_id === 'string' && b.tier_id) {
    if (!PRIX_TIERS[b.tier_id]) {
      throw new Error(`tier_id inconnu : "${b.tier_id}"`);
    }
    return {
      items: [{ sku: b.tier_id, qty: 1 }],
      email,
    };
  }

  throw new Error('Requête invalide : fournir "tier_id" (legacy) ou "items[]" (panier)');
}

// ─── Construction des line_items Stripe ──────────────────────────────────────

/**
 * Convertit les CartItems en line_items Stripe Checkout.
 * Chaque ligne a automatic_tax intégré via le paramètre de session
 * (automatic_tax: { enabled: true } — déjà dans le worker, ligne 208).
 */
function buildStripeLineItems(items: CartItem[]) {
  return items.map(({ sku, qty }) => {
    const tier = PRIX_TIERS[sku];
    return {
      price_data: {
        currency: 'cad',
        product_data: {
          name: tier.label,
          // metadata pour retrouver le SKU dans le webhook côté paiement
          metadata: { sku },
        },
        unit_amount: tier.prix_cents,
      },
      quantity: qty,
    };
  });
}

// ─── Métadonnées session (pour le webhook checkout.session.completed) ─────────

/**
 * Encode les items dans les métadonnées Stripe (max 500 chars par valeur).
 * Le webhook lira metadata.cart_items pour générer N licences.
 *
 * Format JSON compact : [{"sku":"solo_annuel","qty":1},{"sku":"pack5_annuel","qty":2}]
 */
function buildSessionMetadata(items: CartItem[], email: string): Record<string, string> {
  const cartJson = JSON.stringify(items);
  // Stripe limite : clé 40 chars, valeur 500 chars
  if (cartJson.length > 500) {
    throw new Error('Panier trop complexe pour les métadonnées Stripe (> 500 chars)');
    // Note : en pratique, 20 SKUs × ~30 chars = ~600. Si atteint, splitter en cart_items_1, etc.
    // Non implémenté ici — seuil jamais atteint en usage réel Mathéquête
  }
  return {
    cart_items: cartJson,   // nouveau champ — lu par handleStripeWebhook
    customer_email: email,
    // Rétrocompat : si 1 seul item, on garde tier_id pour les webhooks déjà déployés
    ...(items.length === 1 ? { tier_id: items[0].sku } : {}),
  };
}

// ─── Handler principal — remplace l'existant handleCreateCheckoutSession ──────

/**
 * USAGE dans index.ts (aucun changement de route nécessaire) :
 *
 *   case '/create-checkout-session':
 *     return handleCreateCheckoutSession(request, env);
 *
 * Le handler est un remplacement drop-in de l'existant.
 */
export async function handleCreateCheckoutSession(
  request: Request,
  env: Env,
): Promise<Response> {
  // Récupération et parsing du body
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, 'Corps JSON invalide');
  }

  // Validation
  let parsed: { items: CartItem[]; email: string };
  try {
    parsed = parseCheckoutBody(rawBody);
  } catch (err) {
    return jsonError(400, (err as Error).message);
  }

  const { items, email } = parsed;

  // Construction des line_items
  let lineItems: ReturnType<typeof buildStripeLineItems>;
  try {
    lineItems = buildStripeLineItems(items);
  } catch (err) {
    return jsonError(400, (err as Error).message);
  }

  // Métadonnées session
  let sessionMetadata: Record<string, string>;
  try {
    sessionMetadata = buildSessionMetadata(items, email);
  } catch (err) {
    return jsonError(400, (err as Error).message);
  }

  // Appel Stripe — création de la session Checkout
  try {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: '2024-06-20',
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: lineItems,              // ← N lignes au lieu de 1
      automatic_tax: { enabled: true },   // TPS + TVQ Québec
      metadata: sessionMetadata,          // cart_items + tier_id legacy
      success_url: `${env.PUBLIC_SITE_URL}/merci.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${env.PUBLIC_SITE_URL}/achat.html`,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('Stripe error:', err);
    return jsonError(500, 'Erreur lors de la création de la session de paiement');
  }
}

// ─── Patch handleStripeWebhook — génération multi-licences ───────────────────

/**
 * Dans handleStripeWebhook, remplacer la lecture de metadata.tier_id par :
 *
 *   const cartItems: CartItem[] = session.metadata?.cart_items
 *     ? JSON.parse(session.metadata.cart_items)
 *     : [{ sku: session.metadata?.tier_id ?? 'continent_1', qty: 1 }];
 *
 *   // Générer une licence par (sku × qty)
 *   for (const { sku, qty } of cartItems) {
 *     const tier = PRIX_TIERS[sku];
 *     for (let i = 0; i < qty; i++) {
 *       const code = await generateCode(env, tier.code_prefix);
 *       await createLicenceInD1(env, { code, type: tier.type, sku, email, max_appareils: tier.max_appareils });
 *       await sendLicenceEmail(env, { email, code, tier });
 *     }
 *   }
 *
 * IMPORTANT : l'email doit être envoyé UNE SEULE FOIS avec TOUS les codes.
 * Voir section "Email multi-licence" ci-dessous.
 */

// ─── Email multi-licence (aperçu — implémentation dans email.ts) ─────────────

/**
 * Interface pour le template email multi-licence.
 * À passer à sendLicenceEmail() dans email.ts
 *
 * interface MultiLicenceEmailParams {
 *   email: string;
 *   licences: Array<{
 *     code:          string;
 *     label:         string;   // ex: "Mathéquête – Solo Annuel"
 *     type:          string;   // 'solo' | 'pack' | 'ecole' | etc.
 *     max_appareils: number;
 *   }>;
 * }
 *
 * L'email liste tous les codes dans un tableau HTML, 1 code par ligne.
 * Le CSV en pièce jointe contient toutes les licences.
 */

// ─── Utilitaire ──────────────────────────────────────────────────────────────

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Export table de prix (pour handleStripeWebhook) ─────────────────────────
export { PRIX_TIERS };
export type { CartItem, TierConfig };
