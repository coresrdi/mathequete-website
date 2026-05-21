/**
 * Types partagés du Worker Mathéquête.
 * Toutes les bindings et secrets déclarés dans wrangler.toml.
 *
 * TARIFICATION mise à jour 20 mai 2026 — Registre v4.36 §4B (Jeff 18 mai 8h24 EDT)
 * Sprint S2 terminé 20 mai 2026 — stripe_price_id école branchés (price_id existaient déjà en livemode).
 * Tous les tiers (individuels + école) ont maintenant leur stripe_price_id complet.
 */

export interface Env {
  // ===== Bindings =====
  DB: D1Database;

  // Sprint PB1 — R2 bucket pour stockage des PDFs de QR école (D5 + D8).
  R2_PDFS: R2Bucket;

  // ===== Variables publiques (wrangler.toml [vars]) =====
  ENVIRONMENT: 'production' | 'development';
  STRIPE_API_VERSION: string;
  RESEND_FROM_EMAIL: string;
  RESEND_FROM_NAME: string;
  PUBLIC_SITE_URL: string;

  // ===== Secrets (wrangler secret put XXX) =====
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_API_KEY: string;
  HMAC_SECRET_KEY: string;

  // Sprint D1 — Master Encryption Key (32 octets hex = 64 caractères)
  // Génération : openssl rand -hex 32
  // Pose : npx wrangler secret put MASTER_ENCRYPTION_KEY
  // ⚠️ NE JAMAIS PERDRE : sa perte rend illisibles toutes les données chiffrées.
  MASTER_ENCRYPTION_KEY: string;

  // Sprint PB1 — Admin token pour endpoints /api/admin/*
  ADMIN_API_TOKEN: string;
}

/* Paliers tarifaires côté serveur — DOIT correspondre au front
 * (Plan v3.1 §3.3 + Sprint S3.C + PB1 D4). Prix en cents CAD HT (avant taxes Québec).
 *
 * nb_codes        : codes HMAC `licences` émis par achat (1 ou 5).
 * nb_cles_qr      : QR Crockford Base32 12 chars distincts dans `licences_qr`.
 * nb_eleves       : appareils actifs max PAR CODE HMAC.
 * stripe_price_id : Price ID Stripe livemode — identifie le palier dans le webhook
 *                   checkout.session.completed.
 * duree           : 'annuel' = 1 an après activation (date_expiration à gérer)
 *                   'permanent' = à vie (expire_le = 0 dans licences_qr)
 *                   'ecole' = année scolaire
 *
 * ANCIEN price_id désactivé UI (conserver pour achats historiques) :
 *   price_1TX3EUAtSQMHh0M879yhFTt4  (one_time, 499 ¢, continent_1 à 4,99 $)
 */
export const PRIX_TIERS_CENTS: Record<string, {
  prix_cents: number;
  nb_eleves: number;
  nb_codes: number;
  nb_cles_qr: number;
  nom: string;
  stripe_price_id: string;
  duree: 'annuel' | 'permanent' | 'ecole';
}> = {

  // ---- Individuels --------------------------------------------------------

  // 1,99 $/an — abonnement annuel (recurring year)
  // product prod_UW5Prr6X8LYJGX — prix créé 20 mai 2026
  'continent_1': {
    prix_cents:      199,
    nb_eleves:       1,
    nb_codes:        1,
    nb_cles_qr:      1,
    nom:             'Continent 1 — Annuel solo',
    stripe_price_id: 'price_1TZLUzAtSQMHh0M8k0h1Zmw8',
    duree:           'annuel',
  },

  // 7,99 $/an — abonnement annuel, 5 codes (recurring year)
  // product prod_UYSQxgqhFdLW5H — créé 20 mai 2026
  'pack_5_continent_1': {
    prix_cents:      799,
    nb_eleves:       1,
    nb_codes:        5,
    nb_cles_qr:      5,
    nom:             'Continent 1 — Pack 5 Annuel',
    stripe_price_id: 'price_1TZLXRAtSQMHh0M8U6ZrKR1X',
    duree:           'annuel',
  },

  // 9,99 $ — achat unique permanent (one_time)
  // product prod_UYSSaFjbHc2ggu — créé 20 mai 2026
  // DEC-45 : fenêtre transfert 1 an
  'solo_permanent': {
    prix_cents:      999,
    nb_eleves:       1,
    nb_codes:        1,
    nb_cles_qr:      1,
    nom:             'Continent 1 — Permanent solo',
    stripe_price_id: 'price_1TZLXgAtSQMHh0M8ZROkEC9k',
    duree:           'permanent',
  },

  // 39,99 $ — achat unique permanent 5 codes (one_time)
  // product prod_UYSSgaiJ01F2sU — créé 20 mai 2026
  // DEC-45 : fenêtre transfert 1 an par code
  'pack_5_permanent': {
    prix_cents:      3999,
    nb_eleves:       1,
    nb_codes:        5,
    nb_cles_qr:      5,
    nom:             'Continent 1 — Pack 5 Permanent',
    stripe_price_id: 'price_1TZLXmAtSQMHh0M8d0y6tzgT',
    duree:           'permanent',
  },

  // ---- École (année scolaire) — price_id existaient déjà en livemode --------

  // 35,00 $ — 30 QR — product prod_UW5PcDk5PtVnLV
  'classe_petite': {
    prix_cents:      3500,
    nb_eleves:       30,
    nb_codes:        1,
    nb_cles_qr:      30,
    nom:             'Classe Petite',
    stripe_price_id: 'price_1TX3F7AtSQMHh0M8b06wRCb0',
    duree:           'ecole',
  },

  // 98,00 $ — 100 QR — product prod_UW5Qz9NfHwilbS
  'classe_moyenne': {
    prix_cents:      9800,
    nb_eleves:       100,
    nb_codes:        1,
    nb_cles_qr:      100,
    nom:             'Classe Moyenne',
    stripe_price_id: 'price_1TX3FoAtSQMHh0M8tsnTlzeh',
    duree:           'ecole',
  },

  // 265,00 $ — 300 QR — product prod_UW5Roqj2HYIMZb
  'petite_ecole': {
    prix_cents:      26500,
    nb_eleves:       300,
    nb_codes:        1,
    nb_cles_qr:      300,
    nom:             'Petite École',
    stripe_price_id: 'price_1TX3GVAtSQMHh0M8c7ghO7lF',
    duree:           'ecole',
  },

  // 393,00 $ — 500 QR — product prod_UW5S8UTm2EC8Dq
  'ecole_standard': {
    prix_cents:      39300,
    nb_eleves:       500,
    nb_codes:        1,
    nb_cles_qr:      500,
    nom:             'École Standard',
    stripe_price_id: 'price_1TX3H8AtSQMHh0M8ZiSMVv2c',
    duree:           'ecole',
  },

  // 650,00 $ — 1 000 QR — product prod_UW5SvIvozIdmRt
  'grande_ecole': {
    prix_cents:      65000,
    nb_eleves:       1000,
    nb_codes:        1,
    nb_cles_qr:      1000,
    nom:             'Grande École',
    stripe_price_id: 'price_1TX3HcAtSQMHh0M8hh5dtrEr',
    duree:           'ecole',
  },

  // 716,00 $ — 1 300 QR — product prod_UW5TXSfHTVvrvp
  'mega_ecole': {
    prix_cents:      71600,
    nb_eleves:       1300,
    nb_codes:        1,
    nb_cles_qr:      1300,
    nom:             'Méga École',
    stripe_price_id: 'price_1TX3IcAtSQMHh0M8XgfyfFdB',
    duree:           'ecole',
  },
};

/**
 * STRIPE PRICE IDs DE RÉFÉRENCE COMPLÈTE (livemode) — Sprint S2 terminé 20 mai 2026
 *
 * | Tier                | Price ID                              | Montant     | Type        |
 * |---------------------|---------------------------------------|-------------|-------------|
 * | continent_1         | price_1TZLUzAtSQMHh0M8k0h1Zmw8        | 1,99 $/an   | recurring   |
 * | pack_5_continent_1  | price_1TZLXRAtSQMHh0M8U6ZrKR1X        | 7,99 $/an   | recurring   |
 * | solo_permanent      | price_1TZLXgAtSQMHh0M8ZROkEC9k        | 9,99 $      | one_time    |
 * | pack_5_permanent    | price_1TZLXmAtSQMHh0M8d0y6tzgT        | 39,99 $     | one_time    |
 * | classe_petite       | price_1TX3F7AtSQMHh0M8b06wRCb0        | 35,00 $     | one_time    |
 * | classe_moyenne      | price_1TX3FoAtSQMHh0M8tsnTlzeh        | 98,00 $     | one_time    |
 * | petite_ecole        | price_1TX3GVAtSQMHh0M8c7ghO7lF        | 265,00 $    | one_time    |
 * | ecole_standard      | price_1TX3H8AtSQMHh0M8ZiSMVv2c        | 393,00 $    | one_time    |
 * | grande_ecole        | price_1TX3HcAtSQMHh0M8hh5dtrEr        | 650,00 $    | one_time    |
 * | mega_ecole          | price_1TX3IcAtSQMHh0M8XgfyfFdB        | 716,00 $    | one_time    |
 *
 * ANCIEN price_id désactivé UI — ne plus proposer sur le site :
 *   price_1TX3EUAtSQMHh0M879yhFTt4  (one_time, 499 ¢, continent_1 à 4,99 $)
 */
