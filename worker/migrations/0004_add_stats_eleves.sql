-- Migration 0004 — Table stats agrégées par élève par licence
-- Push périodique depuis l'app de gestion enseignant (Tauri future Sprint F)
-- Sprint C — mai 2026

CREATE TABLE IF NOT EXISTS stats_eleves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  licence_id TEXT NOT NULL,
  eleve_id TEXT NOT NULL,  -- identifiant local côté app prof (uuid stable)
  prenom TEXT,             -- prénom affiché (non-PII, choisi par le prof)
  total_examens INTEGER NOT NULL DEFAULT 0,
  total_reussites INTEGER NOT NULL DEFAULT 0,
  total_echecs INTEGER NOT NULL DEFAULT 0,
  iles_completees INTEGER NOT NULL DEFAULT 0,
  derniere_session_at INTEGER,  -- unix timestamp
  push_at INTEGER NOT NULL,     -- moment du push
  payload_json TEXT,            -- détail complet (operations breakdown, etc.) JSON brut
  UNIQUE(licence_id, eleve_id)
);

CREATE INDEX IF NOT EXISTS idx_stats_licence ON stats_eleves(licence_id);
CREATE INDEX IF NOT EXISTS idx_stats_push_at ON stats_eleves(push_at);
