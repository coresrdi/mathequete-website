-- Migration 0012 — Sprint IMPORT-ELEVES item IE-1 (16 mai 2026, 00h00 UTC)
-- Décisions DEC-56 (Godot saisie code classe) + DEC-57 (matching Worker) + DEC-58 (Tauri import)
--
-- Cette migration ajoute le support du matching suggestif entre les élèves
-- pré-créés par le prof (via import .xlsx/.csv/Sheets) et les activations
-- élèves réelles (scan QR + saisie infos dans le profil joueur Godot).
--
-- ============================================================================
-- 1. Enrichissement de `licences_qr` (migration 0010)
-- ============================================================================
--
-- `match_statut` : 4 états possibles pour traçabilité du matching
--   - 'non_active'  : QR existe en DB mais aucune activation élève encore reçue
--                     (état par défaut au CREATE — DEC-57)
--   - 'auto'        : exact-match sur tous les champs fournis → lié auto à un
--                     eleve_pre_cree_id (DEC-57.a)
--   - 'conflit'     : N candidats homonymes → élève peut jouer mais prof doit
--                     valider manuellement (DEC-57.b, UI jaune côté Tauri)
--   - 'non_associe' : 0 candidat → élève hors liste, prof voit en orange et
--                     peut soit créer entrée soit refuser (DEC-57.c, UI orange)
--
-- `eleve_pre_cree_id` : FK vers `eleves_pre_crees.id` quand match auto ou
--                       résolu manuellement. NULL si pas encore lié.
--                       N'a PAS de FK SQL (D1 ne supporte pas REFERENCES sur
--                       ALTER TABLE — on garde la cohérence côté Worker).

ALTER TABLE licences_qr
  ADD COLUMN match_statut TEXT NOT NULL DEFAULT 'non_active'
  CHECK (match_statut IN ('non_active','auto','conflit','non_associe'));

ALTER TABLE licences_qr
  ADD COLUMN eleve_pre_cree_id INTEGER;

-- Index pour les requêtes "élèves en conflit/non associés de ma classe"
CREATE INDEX IF NOT EXISTS idx_licences_qr_match_statut
  ON licences_qr(classe_id, match_statut)
  WHERE classe_id IS NOT NULL;

-- ============================================================================
-- 2. Nouvelle table `eleves_pre_crees`
-- ============================================================================
--
-- Entrées importées par le prof AVANT que les élèves activent leurs QR.
-- Chiffrement E2E : tous les champs PII sont chiffrés côté client avec la DEK
-- du prof (Sprint D4 Argon2id) puis stockés en BLOB. Le Worker N'A PAS accès
-- aux clairs.
--
-- Pour le matching DEC-57, on stocke aussi des **hashs côté client** des
-- champs normalisés (lowercase + NFD sans accents + trim) qui permettent au
-- Worker de comparer sans déchiffrer :
--   - prenom_hash      : SHA-256("prenom_normalise") — toujours présent
--   - nom_hash         : SHA-256("nom_normalise")    — optionnel
--   - niveau_hash      : SHA-256("niveau_normalise") — optionnel
--   - code_court_hash  : SHA-256("code_normalise")   — optionnel
--
-- Le Worker fait : `WHERE prenom_hash = ? AND (nom_hash IS NULL OR nom_hash = ?)`
-- → 1 match exact = 'auto', N matches = 'conflit', 0 match = 'non_associe'.
--
-- Le prof ré-importera s'il modifie sa liste — pas de update partiel pour
-- limiter la complexité (DEC-58 silencieux sur ce point, on tranche
-- "import = replace" pour PB1, à revoir pour PB2 si nécessaire).
--
-- IMPORTANT Loi 25 : aucun clair côté serveur. Audit log immuable sur INSERT.

CREATE TABLE IF NOT EXISTS eleves_pre_crees (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  classe_id                INTEGER NOT NULL,
  prof_id                  TEXT NOT NULL,
  -- Champs chiffrés client (BLOB, base64 sur le wire)
  prenom_chiffre           BLOB NOT NULL,
  prenom_iv                BLOB NOT NULL,
  nom_chiffre              BLOB,            -- optionnel
  nom_iv                   BLOB,
  niveau_chiffre           BLOB,            -- optionnel
  niveau_iv                BLOB,
  code_court_chiffre       BLOB,            -- optionnel
  code_court_iv            BLOB,
  -- Hashs SHA-256 pour matching côté Worker (32 octets chacun, en hex 64 chars)
  prenom_hash              TEXT NOT NULL,   -- requis (matching minimum)
  nom_hash                 TEXT,            -- NULL si nom non fourni
  niveau_hash              TEXT,
  code_court_hash          TEXT,
  -- Méta
  ordre_dans_import        INTEGER NOT NULL,  -- ligne dans le .xlsx d'origine (1, 2, 3...)
  date_import              INTEGER NOT NULL,
  est_archive              INTEGER NOT NULL DEFAULT 0,  -- soft delete si prof retire
  FOREIGN KEY (classe_id) REFERENCES classes(id),
  FOREIGN KEY (prof_id)   REFERENCES profs(id)
);

CREATE INDEX IF NOT EXISTS idx_eleves_pre_crees_classe
  ON eleves_pre_crees(classe_id, est_archive);

-- Index composite pour le matching (hot path)
-- WHERE classe_id = ? AND prenom_hash = ? AND est_archive = 0
CREATE INDEX IF NOT EXISTS idx_eleves_pre_crees_match
  ON eleves_pre_crees(classe_id, prenom_hash, est_archive)
  WHERE est_archive = 0;
