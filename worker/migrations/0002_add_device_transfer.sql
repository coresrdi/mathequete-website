-- ============================================================
-- Migration 0002 — Sprint A : transfert 6 mois d'appareil
-- Ajout des colonnes nécessaires au mécanisme de désactivation/transfert
-- ============================================================

-- Étendre codes_actives pour suivre statut et historique de transfert.
ALTER TABLE codes_actives ADD COLUMN statut TEXT NOT NULL DEFAULT 'active';
-- valeurs : 'active' | 'liberee' | 'expiree' | 'bloquee'

ALTER TABLE codes_actives ADD COLUMN liberee_le INTEGER;
-- timestamp Unix de désactivation (NULL tant qu'active)

ALTER TABLE codes_actives ADD COLUMN raison_liberation TEXT;
-- 'user_demand' | 'admin_force' | 'fraud_detected' | 'auto_timeout'

-- Index pour accélérer recherche par code + statut
CREATE INDEX IF NOT EXISTS idx_actives_licence_statut
  ON codes_actives(licence_id, statut);

-- ============================================================
-- Table : journal des transferts (audit trail)
-- ============================================================
CREATE TABLE IF NOT EXISTS transferts_appareils (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  licence_id          TEXT NOT NULL,           -- → licences.id
  code_active_id      INTEGER,                  -- → codes_actives.id (ancien device)
  ancien_device_hash  TEXT NOT NULL,
  nouveau_device_hash TEXT,                     -- NULL si seulement désactivation
  date_transfert      INTEGER NOT NULL,
  date_achat_origine  INTEGER NOT NULL,         -- pour audit fenêtre 6 mois
  delta_jours         INTEGER NOT NULL,         -- (transfert - achat) en jours
  source              TEXT NOT NULL,            -- 'user_action' | 'admin_force'
  ip_pays             TEXT,
  note                TEXT,
  FOREIGN KEY (licence_id) REFERENCES licences(id)
);

CREATE INDEX IF NOT EXISTS idx_transferts_licence ON transferts_appareils(licence_id);
CREATE INDEX IF NOT EXISTS idx_transferts_date    ON transferts_appareils(date_transfert);

-- ============================================================
-- Vue : codes actifs (statut = 'active' uniquement, pour join)
-- ============================================================
DROP VIEW IF EXISTS v_codes_actifs_courants;
CREATE VIEW v_codes_actifs_courants AS
SELECT
  ca.id,
  ca.licence_id,
  ca.device_hash,
  ca.active_le,
  ca.statut,
  l.code,
  l.type,
  l.emis_le,
  l.expire_le,
  -- Fenêtre 6 mois post-achat (6*30*24*3600 = 15552000 s)
  CASE
    WHEN (unixepoch() - l.emis_le) <= 15552000 THEN 1
    ELSE 0
  END AS transfert_autorise
FROM codes_actives ca
JOIN licences l ON l.id = ca.licence_id
WHERE ca.statut = 'active';
