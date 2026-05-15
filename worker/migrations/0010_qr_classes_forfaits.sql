-- Migration 0010 — Sprint PB1
-- Pont prof ↔ jeu : forfaits école + licences QR distinctes + classes
--
-- Ajoute les tables nécessaires au modèle « 1 QR = 1 licence = 1 continent
-- = 1 appareil, code classe partagé » (décision D4 validée 15 mai 2026).
--
-- Coexiste avec la table `licences` existante (HMAC-coded) qui reste
-- l'identifiant principal des achats. Le pont vers ce nouveau système est
-- assuré par `licences_qr.licence_id_hmac` qui pointe vers `licences.id`.
-- Cela permet d'émettre N QR distincts pour 1 achat école sans casser
-- la compatibilité ascendante (Pack 5 et achats individuels existants).

-- ============================================================================
-- TABLE forfaits_ecole — un achat école groupé
-- ============================================================================
CREATE TABLE IF NOT EXISTS forfaits_ecole (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_session_id        TEXT UNIQUE NOT NULL,
  stripe_payment_id        TEXT,
  licence_id_hmac          TEXT NOT NULL,            -- FK vers licences(id) historique
  ecole_nom                TEXT NOT NULL,
  code_court               TEXT UNIQUE NOT NULL,     -- ex: 'vjolie' (4-12 chars)
  produit_id               TEXT NOT NULL,            -- 'continent_1' par défaut, futur: 'anglais_continent_1'
  tier                     TEXT NOT NULL,            -- 'classe_petite', 'grande_ecole', etc.
  nb_licences_total        INTEGER NOT NULL,
  prix_paye_cents          INTEGER NOT NULL,
  email_admin              TEXT NOT NULL,
  nom_admin                TEXT,
  date_achat               INTEGER NOT NULL,
  pdf_r2_path              TEXT,
  pdf_genere_date          INTEGER,
  FOREIGN KEY (licence_id_hmac) REFERENCES licences(id)
);

CREATE INDEX IF NOT EXISTS idx_forfaits_code_court ON forfaits_ecole(code_court);
CREATE INDEX IF NOT EXISTS idx_forfaits_stripe ON forfaits_ecole(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_forfaits_licence ON forfaits_ecole(licence_id_hmac);

-- ============================================================================
-- TABLE classes — un groupe d'élèves rattaché à un prof
-- ============================================================================
CREATE TABLE IF NOT EXISTS classes (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  code_classe              TEXT UNIQUE NOT NULL,     -- 'Nadia-3A-2026-vjolie' (UNIQUE GLOBAL)
  prof_id                  TEXT NOT NULL,            -- FK profs(id) (TEXT id format)
  forfait_ecole_id         INTEGER,                  -- NULL si classe sans forfait école rattaché
  nom_affiche              TEXT,                     -- 'Classe 3A — Mme Nadia'
  annee_scolaire           INTEGER NOT NULL,         -- 2026 (année de la rentrée septembre)
  date_creation            INTEGER NOT NULL,
  est_archivee             INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (prof_id)          REFERENCES profs(id),
  FOREIGN KEY (forfait_ecole_id) REFERENCES forfaits_ecole(id)
);

CREATE INDEX IF NOT EXISTS idx_classes_prof    ON classes(prof_id);
CREATE INDEX IF NOT EXISTS idx_classes_forfait ON classes(forfait_ecole_id);

-- ============================================================================
-- TABLE licences_qr — un QR distinct par élève (Crockford Base32 12 chars)
-- ============================================================================
CREATE TABLE IF NOT EXISTS licences_qr (
  cle_qr                       TEXT PRIMARY KEY,     -- 12 chars Crockford (sans tirets)
  forfait_ecole_id             INTEGER,              -- NULL pour licence individuelle
  licence_id_hmac              TEXT NOT NULL,        -- FK licences(id) du lot (parent)
  produit_id                   TEXT NOT NULL,        -- 'continent_1', etc.
  numero_sequence              INTEGER,              -- 247/1000 dans le PDF
  -- Attribution prof (renseigné à scan dans app Tauri)
  classe_id                    INTEGER,
  attribution_prof_email       TEXT,                 -- traçabilité distribution (PB1.5)
  date_attribution             INTEGER,
  -- Activation élève (renseigné à la 1ère activation côté jeu)
  eleve_pseudo                 TEXT,
  device_fingerprint           TEXT,
  activation_initiale_date     INTEGER,
  derniere_activation_date     INTEGER,
  nb_transferts_auto           INTEGER NOT NULL DEFAULT 0,
  nb_transferts_prof           INTEGER NOT NULL DEFAULT 0,
  -- État
  est_revoquee                 INTEGER NOT NULL DEFAULT 0,
  date_creation                INTEGER NOT NULL,
  FOREIGN KEY (forfait_ecole_id) REFERENCES forfaits_ecole(id),
  FOREIGN KEY (licence_id_hmac)  REFERENCES licences(id),
  FOREIGN KEY (classe_id)        REFERENCES classes(id)
);

CREATE INDEX IF NOT EXISTS idx_licences_qr_classe       ON licences_qr(classe_id);
CREATE INDEX IF NOT EXISTS idx_licences_qr_forfait      ON licences_qr(forfait_ecole_id);
CREATE INDEX IF NOT EXISTS idx_licences_qr_licence_hmac ON licences_qr(licence_id_hmac);
CREATE INDEX IF NOT EXISTS idx_licences_qr_eleve        ON licences_qr(eleve_pseudo, classe_id);
CREATE INDEX IF NOT EXISTS idx_licences_qr_device       ON licences_qr(device_fingerprint);

-- ============================================================================
-- TABLE attributions_prof — sous-distributions admin école → profs (PB1.5)
-- Préparée maintenant pour éviter une migration supplémentaire au moment du
-- portail école.
-- ============================================================================
CREATE TABLE IF NOT EXISTS attributions_prof (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  forfait_ecole_id         INTEGER NOT NULL,
  prof_email               TEXT NOT NULL,
  nb_licences              INTEGER NOT NULL,
  cles_qr_json             TEXT NOT NULL,            -- JSON array des clés attribuées
  pdf_r2_path              TEXT,
  date_attribution         INTEGER NOT NULL,
  FOREIGN KEY (forfait_ecole_id) REFERENCES forfaits_ecole(id)
);

CREATE INDEX IF NOT EXISTS idx_attributions_forfait ON attributions_prof(forfait_ecole_id);
CREATE INDEX IF NOT EXISTS idx_attributions_email   ON attributions_prof(prof_email);
