-- Migration 0003 — Activation manuelle (Sprint S2.A, mai 2026)
--
-- Objectif : permettre la creation de codes promo reutilisables qui demandent
-- une validation manuelle de l'admin (Claude) avant activation par le joueur.
--
-- Flux :
--   1. Admin cree un code dans `activation_codes` (ex: PROMO-FAMILLE-2026, max 50)
--   2. Joueur entre le code dans le jeu + email + nom + message
--      -> POST /api/activation/request -> insert dans `activation_requests` (status=pending)
--      -> email envoye a coresrdi@gmail.com avec lien magique
--   3. Admin clique lien magique -> page de decision (approuver lifetime/1an/6mois ou refuser)
--   4. Joueur poll /api/activation/status -> recoit status approved
--   5. Joueur POST /api/activation/redeem -> recoit code HMAC, l'active localement

-- ===== Table : activation_codes (codes promo reutilisables) =====
CREATE TABLE IF NOT EXISTS activation_codes (
  code               TEXT PRIMARY KEY,           -- ex: PROMO-FAMILLE-2026 (uppercase, 4-32 chars)
  label              TEXT NOT NULL,              -- description humaine (ex: "Famille Noel 2026")
  max_activations    INTEGER NOT NULL DEFAULT 1, -- nombre max d'activations distinctes
  used_activations   INTEGER NOT NULL DEFAULT 0, -- compteur incremente a chaque approbation
  actif              INTEGER NOT NULL DEFAULT 1, -- 0 = desactive (admin peut suspendre)
  cree_le            INTEGER NOT NULL,           -- timestamp Unix
  expire_le          INTEGER NOT NULL DEFAULT 0, -- 0 = jamais; sinon le code refuse les demandes apres
  cree_par           TEXT,                       -- email admin createur (futur multi-admin)
  notes_internes     TEXT                        -- libre, vu uniquement par admin
);

CREATE INDEX IF NOT EXISTS idx_actcodes_actif ON activation_codes(actif);

-- ===== Table : activation_requests (demandes en attente) =====
CREATE TABLE IF NOT EXISTS activation_requests (
  request_id         TEXT PRIMARY KEY,           -- ex: req_<32 hex random>
  code               TEXT NOT NULL,              -- FK -> activation_codes.code
  email_joueur       TEXT NOT NULL,
  nom_joueur         TEXT NOT NULL,
  message            TEXT,                       -- libre (ex: "Cousin de mes filles")
  device_hash        TEXT NOT NULL,              -- SHA-256 du device (anti-replay)
  status             TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | expired
  -- Champs remplis a l'approbation :
  licence_type       TEXT,                       -- LIFETIME / PROMO / ESSAI (selon decision admin)
  expire_le          INTEGER DEFAULT 0,          -- 0 = jamais
  licence_id         TEXT,                       -- FK -> licences.id (apres redeem)
  code_affiche       TEXT,                       -- MQ-PROM-XXXX-XXXX-XXXX-XXXX (apres redeem)
  -- Token magique pour le lien admin :
  magic_token_hash   TEXT NOT NULL,              -- SHA-256 du token magique (jamais en clair en DB)
  magic_expire       INTEGER NOT NULL,           -- timestamp Unix (token valide 24h)
  -- Audit :
  cree_le            INTEGER NOT NULL,
  decide_le          INTEGER,                    -- timestamp decision
  redeem_le          INTEGER,                    -- timestamp activation cote client
  decide_par         TEXT,                       -- email admin
  raison_refus       TEXT,                       -- si rejected
  ip_pays            TEXT,                       -- cf.country
  FOREIGN KEY (code) REFERENCES activation_codes(code),
  FOREIGN KEY (licence_id) REFERENCES licences(id)
);

CREATE INDEX IF NOT EXISTS idx_actreq_status ON activation_requests(status);
CREATE INDEX IF NOT EXISTS idx_actreq_email  ON activation_requests(email_joueur);
CREATE INDEX IF NOT EXISTS idx_actreq_code   ON activation_requests(code);
CREATE INDEX IF NOT EXISTS idx_actreq_cree   ON activation_requests(cree_le);

-- ===== Code de demonstration (a supprimer en prod si besoin) =====
-- Cree un code DEMO permettant 5 activations a vie pour les tests.
INSERT OR IGNORE INTO activation_codes (code, label, max_activations, used_activations, actif, cree_le, expire_le, cree_par, notes_internes)
VALUES (
  'DEMO-MATHQ-2026',
  'Code de demonstration interne',
  5,
  0,
  1,
  strftime('%s', 'now'),
  0,
  'coresrdi@gmail.com',
  'Code initial cree par migration 0003 pour tests internes.'
);
