/**
 * Types partagés du Worker Mathéquête.
 * Toutes les bindings et secrets déclarés dans wrangler.toml.
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
 */
export const PRIX_TIERS_CENTS: Record<string, {
  prix_cents: number;
  nb_eleves: number;
  nb_codes: number;
  nb_cles_qr: number;
  nom: string;
}> = {
  'continent_1':         { prix_cents: 499,    nb_eleves: 1,    nb_codes: 1, nb_cles_qr: 1,    nom: 'Continent 1 — Individuelle' },
  'pack_5_continent_1':  { prix_cents: 1999,   nb_eleves: 1,    nb_codes: 5, nb_cles_qr: 5,    nom: 'Continent 1 — Pack 5' },
  'classe_petite':       { prix_cents: 3500,   nb_eleves: 30,   nb_codes: 1, nb_cles_qr: 30,   nom: 'Classe Petite' },
  'classe_moyenne':      { prix_cents: 9800,   nb_eleves: 100,  nb_codes: 1, nb_cles_qr: 100,  nom: 'Classe Moyenne' },
  'petite_ecole':        { prix_cents: 26500,  nb_eleves: 300,  nb_codes: 1, nb_cles_qr: 300,  nom: 'Petite École' },
  'ecole_standard':      { prix_cents: 39300,  nb_eleves: 500,  nb_codes: 1, nb_cles_qr: 500,  nom: 'École Standard' },
  'grande_ecole':        { prix_cents: 65000,  nb_eleves: 1000, nb_codes: 1, nb_cles_qr: 1000, nom: 'Grande École' },
  'mega_ecole':          { prix_cents: 71600,  nb_eleves: 1300, nb_codes: 1, nb_cles_qr: 1300, nom: 'Méga École' }
};
