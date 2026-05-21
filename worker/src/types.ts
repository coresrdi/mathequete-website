/**
 * Types partagés du Worker Mathéquête.
 * Toutes les bindings et secrets déclarés dans wrangler.toml.
 *
 * TARIFICATION mise à jour 20 mai 2026 — Registre v4.36 §4B (Jeff 18 mai 8h24 EDT)
 * Anciens prix : continent_1 = 499 ¢ (4,99 $), pack_5 = 1999 ¢ (19,99 $)
 * Nouveaux prix : voir table ci-dessous.
 * Deux nouveaux tiers ajoutés : solo_permanent (9,99 $) et pack_5_permanent (39,99 $).
 * Fenêtre de transfert DEC-45 : 6 mois → 1 an (pour tiers _permanent).
 */

export interface Env {
  // ===== Bindings =====
  DB: D1Database;

  // Sprint PB1 — R2 bucket pour stockage des PDFs de QR école (D5 + D8).
  // À créer en prod : `wrangler r2 bucket create mathequete-pdfs`
  // Binding configuré dans wrangler.toml section [[r2_buckets]].
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
  // Chiffre les DEK par prof et les secrets TOTP au repos.
  // ⚠️ NE JAMAIS PERDRE : sa perte rend illisibles toutes les données chiffrées.
  MASTER_ENCRYPTION_KEY: string;

  // Sprint PB1 — Admin token pour endpoints /api/admin/* (D8 régénération PDF
  // manuel pour gros forfaits). À poser : `wrangler secret put ADMIN_API_TOKEN`.
  // Comparaison constant-time côté endpoint.
  ADMIN_API_TOKEN: string;
}

/* Paliers tarifaires côté serveur — DOIT correspondre au front
 * (Plan v3.1 §3.3 + Sprint S3.C + PB1 D4). Prix en cents CAD HT (avant taxes Québec).
 *
 * nb_codes   : nombre de codes HMAC `licences` émis par achat (1 par défaut,
 *              5 pour Pack 5). Chaque code HMAC est indépendant.
 *              Pour les paliers école, ce champ reste à 1 — un seul code
 *              HMAC « licence-parent » sert d'identité Stripe et porte
 *              les N clés QR via la table `licences_qr`.
 * nb_cles_qr : nombre de clés QR Crockford Base32 (12 chars) distinctes
 *              générées dans `licences_qr` (Sprint PB1, décision D4).
 *              Égale à `nb_eleves` pour les paliers école, et à `nb_codes`
 *              pour les paliers individuels (1 ou 5).
 *              1 QR = 1 licence = 1 continent = 1 appareil.
 * nb_eleves  : nombre maximum d'appareils actifs PAR CODE HMAC.
 *              (Pour les paliers école, c'est le nombre d'élèves du palier ;
 *              désormais aussi le nombre de clés QR émises.)
 * stripe_price_id : Price ID Stripe actif pour ce palier (livemode).
 *              Utilisé par le webhook checkout.session.completed pour identifier
 *              le palier et générer les QR + PDF correspondants.
 *              IMPORTANT : le price_id 499 ¢ (price_1TX3EUAtSQMHh0M879yhFTt4)
 *              est désactivé côté UI — il reste en DB pour les achats historiques
 *              mais ne doit plus être proposé sur le site.
 *
 * TYPE de durée :
 *   'annuel'    = 1 an après activation (EntitlementManager doit vérifier date_expiration)
 *   'permanent' = à vie (expire_le = 0 dans licences_qr)
 *   'ecole'     = durée année scolaire (gérée par date_expiration du forfait_ecole)
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
  // -------------------------------------------------------------------------
  // Tiers individuels — Continent 1
  // -------------------------------------------------------------------------

  // 1,99 $ CAD/an — abonnement annuel renouvelable
  // Stripe : product prod_UW5Prr6X8LYJGX (Mathéquête — Continent 1)
  // Nouveau price_id créé 20 mai 2026 (remplace price_1TX3EUAtSQMHh0M879yhFTt4 à 4,99 $)
  'continent_1': {
    prix_cents:     199,
    nb_eleves:      1,
    nb_codes:       1,
    nb_cles_qr:     1,
    nom:            'Continent 1 — Annuel solo',
    stripe_price_id: 'price_1TZLUzAtSQMHh0M8k0h1Zmw8',
    duree:          'annuel',
  },

  // 7,99 $ CAD/an — abonnement annuel, 5 codes
  // Stripe : product prod_UYSQxgqhFdLW5H (Mathéquête — Pack 5 Annuel)
  'pack_5_continent_1': {
    prix_cents:     799,
    nb_eleves:      1,
    nb_codes:       5,
    nb_cles_qr:     5,
    nom:            'Continent 1 — Pack 5 Annuel',
    stripe_price_id: 'price_1TZLXRAtSQMHh0M8U6ZrKR1X',
    duree:          'annuel',
  },

  // 9,99 $ CAD — achat unique permanent (one-time)
  // Stripe : product prod_UYSSaFjbHc2ggu (Mathéquête — Permanent Solo)
  // DEC-45 : fenêtre de transfert 1 an (anciennement 6 mois — voir TODO sprint séparé)
  'solo_permanent': {
    prix_cents:     999,
    nb_eleves:      1,
    nb_codes:       1,
    nb_cles_qr:     1,
    nom:            'Continent 1 — Permanent solo',
    stripe_price_id: 'price_1TZLXgAtSQMHh0M8ZROkEC9k',
    duree:          'permanent',
  },

  // 39,99 $ CAD — achat unique permanent (one-time), 5 codes
  // Stripe : product prod_UYSSgaiJ01F2sU (Mathéquête — Pack 5 Permanent)
  // DEC-45 : fenêtre de transfert 1 an par code
  'pack_5_permanent': {
    prix_cents:     3999,
    nb_eleves:      1,
    nb_codes:       5,
    nb_cles_qr:     5,
    nom:            'Continent 1 — Pack 5 Permanent',
    stripe_price_id: 'price_1TZLXmAtSQMHh0M8d0y6tzgT',
    duree:          'permanent',
  },

  // -------------------------------------------------------------------------
  // Tiers école — Licences année scolaire (prix et stripe_price_id inchangés)
  // TODO sprint S2 : ajouter les stripe_price_id école une fois créés dans Stripe
  // -------------------------------------------------------------------------
  'classe_petite': {
    prix_cents:     3500,
    nb_eleves:      30,
    nb_codes:       1,
    nb_cles_qr:     30,
    nom:            'Classe Petite',
    stripe_price_id: '',  // TODO sprint S2
    duree:          'ecole',
  },
  'classe_moyenne': {
    prix_cents:     9800,
    nb_eleves:      100,
    nb_codes:       1,
    nb_cles_qr:     100,
    nom:            'Classe Moyenne',
    stripe_price_id: '',  // TODO sprint S2
    duree:          'ecole',
  },
  'petite_ecole': {
    prix_cents:     26500,
    nb_eleves:      300,
    nb_codes:       1,
    nb_cles_qr:     300,
    nom:            'Petite École',
    stripe_price_id: '',  // TODO sprint S2
    duree:          'ecole',
  },
  'ecole_standard': {
    prix_cents:     39300,
    nb_eleves:      500,
    nb_codes:       1,
    nb_cles_qr:     500,
    nom:            'École Standard',
    stripe_price_id: '',  // TODO sprint S2
    duree:          'ecole',
  },
  'grande_ecole': {
    prix_cents:     65000,
    nb_eleves:      1000,
    nb_codes:       1,
    nb_cles_qr:     1000,
    nom:            'Grande École',
    stripe_price_id: '',  // TODO sprint S2
    duree:          'ecole',
  },
  'mega_ecole': {
    prix_cents:     71600,
    nb_eleves:      1300,
    nb_codes:       1,
    nb_cles_qr:     1300,
    nom:            'Méga École',
    stripe_price_id: '',  // TODO sprint S2
    duree:          'ecole',
  },
};

/**
 * STRIPE PRICE IDs DE RÉFÉRENCE (livemode) — mis à jour 20 mai 2026
 *
 * | Tier                | Price ID                              | Montant   | Type        |
 * |---------------------|---------------------------------------|-----------|-------------|
 * | continent_1         | price_1TZLUzAtSQMHh0M8k0h1Zmw8        | 1,99 $/an | recurring   |
 * | pack_5_continent_1  | price_1TZLXRAtSQMHh0M8U6ZrKR1X        | 7,99 $/an | recurring   |
 * | solo_permanent      | price_1TZLXgAtSQMHh0M8ZROkEC9k        | 9,99 $    | one_time    |
 * | pack_5_permanent    | price_1TZLXmAtSQMHh0M8d0y6tzgT        | 39,99 $   | one_time    |
 *
 * ANCIEN price_id à 4,99 $ (désactivé UI, conserver pour achats historiques) :
 *   price_1TX3EUAtSQMHh0M879yhFTt4  (one_time, 499 cents, prod_UW5Prr6X8LYJGX)
 *
 * Pour les tiers école : stripe_price_id vide jusqu'au sprint S2
 * où les produits et prix Stripe école seront créés et liés.
 */
