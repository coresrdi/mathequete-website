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
 * (Plan v3.1 §3.3). Prix en cents CAD HT (avant taxes Québec). */
export const PRIX_TIERS_CENTS: Record<string, {
  prix_cents: number;
  nb_eleves: number;
  nom: string;
}> = {
  'continent_1':    { prix_cents: 499,    nb_eleves: 1,    nom: 'Continent 1 — Famille' },
  'classe_petite':  { prix_cents: 3500,   nb_eleves: 30,   nom: 'Classe Petite' },
  'classe_moyenne': { prix_cents: 9800,   nb_eleves: 100,  nom: 'Classe Moyenne' },
  'petite_ecole':   { prix_cents: 26500,  nb_eleves: 300,  nom: 'Petite École' },
  'ecole_standard': { prix_cents: 39300,  nb_eleves: 500,  nom: 'École Standard' },
  'grande_ecole':   { prix_cents: 65000,  nb_eleves: 1000, nom: 'Grande École' },
  'mega_ecole':     { prix_cents: 71600,  nb_eleves: 1300, nom: 'Méga École' }
};
