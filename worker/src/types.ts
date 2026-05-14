/**
 * Types partagés du Worker Mathéquête.
 * Toutes les bindings et secrets déclarés dans wrangler.toml.
 */

export interface Env {
  // ===== Bindings =====
  DB: D1Database;

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
}

/* Paliers tarifaires côté serveur — DOIT correspondre au front
 * (Plan v3.1 §3.3 + Sprint S3.C). Prix en cents CAD HT (avant taxes Québec).
 *
 * nb_codes : nombre de codes émis par achat (1 par défaut, 5 pour Pack 5).
 *            Chaque code est indépendant et activable sur 1 appareil.
 * nb_eleves : nombre maximum d'appareils actifs PAR CODE.
 *             (Pour les paliers école, c'est le nombre d'élèves du palier.)
 */
export const PRIX_TIERS_CENTS: Record<string, {
  prix_cents: number;
  nb_eleves: number;
  nb_codes: number;
  nom: string;
}> = {
  'continent_1':         { prix_cents: 499,    nb_eleves: 1,    nb_codes: 1, nom: 'Continent 1 — Individuelle' },
  'pack_5_continent_1':  { prix_cents: 1999,   nb_eleves: 1,    nb_codes: 5, nom: 'Continent 1 — Pack 5' },
  'classe_petite':       { prix_cents: 3500,   nb_eleves: 30,   nb_codes: 1, nom: 'Classe Petite' },
  'classe_moyenne':      { prix_cents: 9800,   nb_eleves: 100,  nb_codes: 1, nom: 'Classe Moyenne' },
  'petite_ecole':        { prix_cents: 26500,  nb_eleves: 300,  nb_codes: 1, nom: 'Petite École' },
  'ecole_standard':      { prix_cents: 39300,  nb_eleves: 500,  nb_codes: 1, nom: 'École Standard' },
  'grande_ecole':        { prix_cents: 65000,  nb_eleves: 1000, nb_codes: 1, nom: 'Grande École' },
  'mega_ecole':          { prix_cents: 71600,  nb_eleves: 1300, nb_codes: 1, nom: 'Méga École' }
};
