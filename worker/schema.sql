-- Mathéquête D1 schema (SQLite serverless)
-- À exécuter : npx wrangler d1 execute mathequete-db --file=schema.sql
--
-- 4 tables principales :
--   licences         : codes émis (vendus ou promo/essai)
--   achats           : historique des transactions Stripe
--   codes_actives    : codes activés par device (pour limiter abus)
--   emails_envoyes   : audit log des envois Resend

-- ===== Table : licences =====
CREATE TABLE IF NOT EXISTS licences (
  id              TEXT PRIMARY KEY,           -- ex: c1748131200a3f9 (12 chars unique)
  code            TEXT NOT NULL UNIQUE,        -- MQ-CLAS-XXXX-XXXX-XXXX-XXXX (28 chars)
  type            TEXT NOT NULL,               -- CLASSE / ECOLE / CONTINENT / LIFETIME / PROMO / ESSAI
  tier            TEXT,                        -- classe_petite, petite_ecole, etc. (NULL pour PROMO/ESSAI)
  nb_eleves_max   INTEGER NOT NULL,            -- 30, 100, 300, 500, 1000, 1300
  emis_le         INTEGER NOT NULL,            -- timestamp Unix création
  expire_le       INTEGER NOT NULL,            -- timestamp Unix expiration (0 = jamais)
  email_acheteur  TEXT,                        -- email destinataire
  nom_acheteur    TEXT,                        -- nom école/prof
  stripe_session  TEXT,                        -- cs_test_XXXX (NULL si promo/essai)
  source          TEXT NOT NULL,               -- 'stripe' / 'cli_promo' / 'cli_essai' / 'cli_manuel'
  metadata_json   TEXT                          -- JSON libre : notes internes, partenariat, etc.
);

CREATE INDEX IF NOT EXISTS idx_licences_email ON licences(email_acheteur);
CREATE INDEX IF NOT EXISTS idx_licences_code  ON licences(code);
CREATE INDEX IF NOT EXISTS idx_licences_type  ON licences(type);
CREATE INDEX IF NOT EXISTS idx_licences_emis  ON licences(emis_le);

-- ===== Table : achats Stripe =====
CREATE TABLE IF NOT EXISTS achats (
  stripe_session_id   TEXT PRIMARY KEY,        -- cs_test_XXXX ou cs_live_XXXX
  stripe_payment_id   TEXT,                    -- pi_XXXX
  tier                TEXT NOT NULL,           -- classe_petite, etc.
  montant_cents       INTEGER NOT NULL,        -- en centimes CAD HT
  tps_cents           INTEGER NOT NULL,
  tvq_cents           INTEGER NOT NULL,
  total_cents         INTEGER NOT NULL,        -- montant_cents + tps + tvq
  devise              TEXT NOT NULL DEFAULT 'cad',
  email_acheteur      TEXT NOT NULL,
  nom_acheteur        TEXT,
  licence_id          TEXT,                    -- → licences.id
  paye_le             INTEGER NOT NULL,        -- timestamp Unix
  statut              TEXT NOT NULL,           -- 'paid' / 'refunded' / 'failed'
  raw_event_json      TEXT,                    -- webhook complet pour audit
  FOREIGN KEY (licence_id) REFERENCES licences(id)
);

CREATE INDEX IF NOT EXISTS idx_achats_email ON achats(email_acheteur);
CREATE INDEX IF NOT EXISTS idx_achats_date  ON achats(paye_le);

-- ===== Table : activations (anti-abus partage) =====
CREATE TABLE IF NOT EXISTS codes_actives (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  licence_id      TEXT NOT NULL,                -- → licences.id
  device_hash     TEXT NOT NULL,                -- SHA-256 d'un identifiant device anonyme
  active_le       INTEGER NOT NULL,             -- timestamp Unix
  ip_pays         TEXT,                         -- 'CA', 'US', etc. (via cf.country)
  user_agent      TEXT,
  FOREIGN KEY (licence_id) REFERENCES licences(id)
);

CREATE INDEX IF NOT EXISTS idx_actives_licence ON codes_actives(licence_id);
CREATE INDEX IF NOT EXISTS idx_actives_device  ON codes_actives(device_hash);

-- ===== Table : emails envoyés (audit Resend) =====
CREATE TABLE IF NOT EXISTS emails_envoyes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  destinataire    TEXT NOT NULL,
  sujet           TEXT NOT NULL,
  type            TEXT NOT NULL,                -- 'licence_emise' / 'rappel_expiration' / 'support'
  licence_id      TEXT,
  envoye_le       INTEGER NOT NULL,
  resend_id       TEXT,                          -- ID Resend pour debug
  statut          TEXT NOT NULL,                 -- 'sent' / 'failed' / 'bounced'
  erreur          TEXT
);

CREATE INDEX IF NOT EXISTS idx_emails_dest ON emails_envoyes(destinataire);
CREATE INDEX IF NOT EXISTS idx_emails_date ON emails_envoyes(envoye_le);

-- ===== Vues utilitaires =====

-- Licences actives non expirées
CREATE VIEW IF NOT EXISTS v_licences_actives AS
SELECT * FROM licences
WHERE expire_le = 0 OR expire_le > unixepoch();

-- Stats vente mensuelles
CREATE VIEW IF NOT EXISTS v_stats_mensuel AS
SELECT
  strftime('%Y-%m', datetime(paye_le, 'unixepoch')) AS mois,
  COUNT(*) AS nb_achats,
  SUM(total_cents) / 100.0 AS total_cad,
  GROUP_CONCAT(DISTINCT tier) AS tiers
FROM achats
WHERE statut = 'paid'
GROUP BY mois
ORDER BY mois DESC;
