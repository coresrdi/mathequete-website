-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0005 — Sprint D1 : Authentification prof + élèves chiffrés
-- ─────────────────────────────────────────────────────────────────────────────
-- Date    : 14 mai 2026
-- Sprint  : D1 (Fondations sécurité app prof)
-- Objet   : Tables pour l'app de gestion enseignant Tauri.
--           - profs           : comptes enseignants (auth + 2FA)
--           - prof_sessions   : sessions JWT actives (refresh tokens)
--           - prof_magic_links: liens magic pour login / réinit mot de passe
--           - prof_2fa_tokens : codes temporaires SMS/courriel pour 2FA
--           - eleves_chiffres : roster élèves chiffré AES-256-GCM par prof
--           - prof_audit_log  : journal d'audit Loi 25 (Québec)
--
-- Conformité Loi 25 (Québec) :
--   - PII (prénom, nom élève) JAMAIS en clair en DB
--   - Chiffrement AES-256-GCM avec clé dérivée HKDF par prof
--   - Audit log immuable (INSERT-only, jamais UPDATE/DELETE)
--   - Suppression compte = effacement chiffré (clé jetée → données illisibles)
--
-- IMPORTANT : Cette migration NE TOUCHE PAS aux tables existantes
--             (licences, achats, codes_actives, emails_envoyes, stats_eleves).
-- ─────────────────────────────────────────────────────────────────────────────


-- ===== Table : profs (comptes enseignants) =====
-- Mot de passe : Argon2id (jamais bcrypt/SHA)
-- Le hash inclut le sel intégré (format PHC : $argon2id$v=19$m=...$...$...)
CREATE TABLE IF NOT EXISTS profs (
  id                  TEXT PRIMARY KEY,             -- UUID v4 : "p_" + 16 hex (ex: p_a1b2c3d4e5f6a7b8)
  email               TEXT NOT NULL UNIQUE,         -- minuscules, validé côté worker
  password_hash       TEXT NOT NULL,                -- Argon2id PHC format

  -- Identité (PII non-enfants, OK en clair, Loi 25 OK)
  nom_affiche         TEXT NOT NULL,                -- prénom + nom du prof
  nom_ecole           TEXT,                         -- école (optionnel)
  ville               TEXT,                         -- ville (optionnel)
  pays                TEXT NOT NULL DEFAULT 'CA',

  -- 2FA (toujours obligatoire après signup)
  twofa_methode       TEXT NOT NULL DEFAULT 'pending',  -- 'pending' / 'totp' / 'email' / 'sms'
  twofa_totp_secret   TEXT,                         -- base32 secret TOTP (chiffré au repos avec MASTER_ENCRYPTION_KEY)
  twofa_totp_iv       TEXT,                         -- IV base64 du chiffrement du secret TOTP
  twofa_phone         TEXT,                         -- E.164 si méthode = sms (chiffré)
  twofa_phone_iv      TEXT,
  twofa_setup_at      INTEGER,                      -- timestamp Unix première activation 2FA

  -- Code classe (donné aux élèves pour lier leurs apps Godot)
  code_classe         TEXT UNIQUE,                  -- format : QC-2026-XXXX (généré au signup)

  -- Clé de chiffrement DEK (Data Encryption Key) par prof
  -- Cette clé chiffre les données élèves de ce prof.
  -- Elle-même est chiffrée par la KEK (Key Encryption Key) globale = MASTER_ENCRYPTION_KEY
  -- → suppression compte = effacement DEK = données élèves illisibles
  dek_chiffree        TEXT NOT NULL,                -- base64(AES-GCM(DEK, KEK))
  dek_iv              TEXT NOT NULL,                -- base64 IV du chiffrement DEK
  dek_version         INTEGER NOT NULL DEFAULT 1,   -- pour rotation future de KEK

  -- Consentement Loi 25
  consentement_parental_atteste  INTEGER NOT NULL DEFAULT 0,  -- 0/1 : prof atteste avoir consentement parents
  cgu_acceptees_le               INTEGER,                     -- timestamp acceptation CGU+confidentialité
  politique_version              TEXT,                        -- ex: "v2-2026-05-14"

  -- Méta
  created_at          INTEGER NOT NULL,             -- timestamp Unix création
  derniere_connexion  INTEGER,
  statut              TEXT NOT NULL DEFAULT 'actif', -- 'actif' / 'suspendu' / 'supprime'
  supprime_le         INTEGER,                       -- timestamp si statut = supprime (DEK effacée)
  failed_login_count  INTEGER NOT NULL DEFAULT 0,    -- anti-brute force
  locked_until        INTEGER                        -- timestamp Unix : compte verrouillé jusqu'à
);

CREATE INDEX IF NOT EXISTS idx_profs_email       ON profs(email);
CREATE INDEX IF NOT EXISTS idx_profs_code_classe ON profs(code_classe);
CREATE INDEX IF NOT EXISTS idx_profs_statut      ON profs(statut);


-- ===== Table : prof_sessions (refresh tokens actifs) =====
-- JWT d'accès court (8h) émis par le worker, refresh token (30j) stocké ici.
-- Une révocation = DELETE de la ligne → refresh impossible.
CREATE TABLE IF NOT EXISTS prof_sessions (
  id                  TEXT PRIMARY KEY,             -- "s_" + 32 hex
  prof_id             TEXT NOT NULL,
  refresh_token_hash  TEXT NOT NULL,                -- SHA-256 du refresh token (jamais le token en clair)
  device_label        TEXT,                         -- "Windows / Chrome / Québec" (anonymisé)
  ip_pays             TEXT,                         -- 'CA' depuis cf.country
  created_at          INTEGER NOT NULL,
  expire_le           INTEGER NOT NULL,             -- created_at + 30 jours
  derniere_utilisation INTEGER,
  revoquee_le         INTEGER,                      -- NULL si active
  FOREIGN KEY (prof_id) REFERENCES profs(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_prof   ON prof_sessions(prof_id);
CREATE INDEX IF NOT EXISTS idx_sessions_hash   ON prof_sessions(refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expire ON prof_sessions(expire_le);


-- ===== Table : prof_magic_links =====
-- Liens uniques courriel pour : signup confirm, login passwordless, reset password
CREATE TABLE IF NOT EXISTS prof_magic_links (
  token_hash      TEXT PRIMARY KEY,             -- SHA-256 du token (jamais le token en clair)
  prof_id         TEXT,                         -- NULL si signup (email pas encore associé à un compte)
  email           TEXT NOT NULL,
  purpose         TEXT NOT NULL,                -- 'signup_confirm' / 'login' / 'reset_password' / 'email_change'
  created_at      INTEGER NOT NULL,
  expire_le       INTEGER NOT NULL,             -- created_at + 15 min
  utilise_le      INTEGER,                      -- NULL si pas encore consommé
  ip_demande      TEXT
);

CREATE INDEX IF NOT EXISTS idx_magic_email  ON prof_magic_links(email);
CREATE INDEX IF NOT EXISTS idx_magic_expire ON prof_magic_links(expire_le);


-- ===== Table : prof_2fa_tokens =====
-- Codes 6 chiffres pour 2FA par email/SMS (TOTP n'utilise pas cette table)
CREATE TABLE IF NOT EXISTS prof_2fa_tokens (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  prof_id         TEXT NOT NULL,
  code_hash       TEXT NOT NULL,                -- SHA-256(code 6 chiffres) — jamais en clair
  methode         TEXT NOT NULL,                -- 'email' / 'sms'
  created_at      INTEGER NOT NULL,
  expire_le       INTEGER NOT NULL,             -- created_at + 5 min
  utilise_le      INTEGER,                      -- NULL si pas encore consommé
  tentatives      INTEGER NOT NULL DEFAULT 0,   -- max 3 tentatives sinon expire
  FOREIGN KEY (prof_id) REFERENCES profs(id)
);

CREATE INDEX IF NOT EXISTS idx_2fa_prof   ON prof_2fa_tokens(prof_id);
CREATE INDEX IF NOT EXISTS idx_2fa_expire ON prof_2fa_tokens(expire_le);


-- ===== Table : eleves_chiffres =====
-- Roster élèves chiffré par prof. Toute PII enfant est AES-256-GCM.
CREATE TABLE IF NOT EXISTS eleves_chiffres (
  id                  TEXT PRIMARY KEY,             -- "e_" + 16 hex (UUID stable côté app prof)
  prof_id             TEXT NOT NULL,

  -- PII enfant CHIFFRÉE (clé = DEK du prof)
  prenom_chiffre      BLOB NOT NULL,
  prenom_iv           BLOB NOT NULL,
  nom_chiffre         BLOB,                         -- nullable : Loi 25 = minimisation, prénom+initiale suffit
  nom_iv              BLOB,

  -- Identifiant local côté app Godot (élève entre ce code pour se lier)
  code_eleve_hash     TEXT,                         -- SHA-256 du code court (ex: "RT-A47K") -- jamais en clair

  -- Stats agrégées CHIFFRÉES (JSON intérieur chiffré)
  stats_chiffre       BLOB,                         -- JSON {total_examens, total_reussites, ...}
  stats_iv            BLOB,
  stats_push_at       INTEGER,                      -- timestamp dernier push depuis app Godot
  stats_version       INTEGER NOT NULL DEFAULT 1,   -- pour évolution schéma JSON stats

  -- Méta non-PII
  created_at          INTEGER NOT NULL,
  archive             INTEGER NOT NULL DEFAULT 0,   -- 0/1 : prof a archivé cet élève (fin d'année)
  supprime_le         INTEGER,                      -- soft delete avant purge réelle après 30j

  FOREIGN KEY (prof_id) REFERENCES profs(id)
);

CREATE INDEX IF NOT EXISTS idx_eleves_prof      ON eleves_chiffres(prof_id);
CREATE INDEX IF NOT EXISTS idx_eleves_code      ON eleves_chiffres(code_eleve_hash);
CREATE INDEX IF NOT EXISTS idx_eleves_push_at   ON eleves_chiffres(stats_push_at);


-- ===== Table : prof_audit_log (Loi 25) =====
-- Journal INSERT-only, jamais modifié. Trace tous les accès aux données enfants.
CREATE TABLE IF NOT EXISTS prof_audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  prof_id         TEXT,                         -- NULL si action anonyme (ex: tentative login échouée)
  action          TEXT NOT NULL,                -- 'login_success' / 'login_failed' / 'eleve_create'
                                                -- 'eleve_view' / 'eleve_update' / 'eleve_delete'
                                                -- 'stats_push' / 'stats_view' / 'export_done' / 'compte_supprime'
                                                -- '2fa_setup' / '2fa_changed' / 'password_changed'
  cible           TEXT,                         -- ex: id élève ou ressource concernée
  ip_pays         TEXT,
  user_agent      TEXT,
  meta_json       TEXT,                         -- contexte JSON (jamais de PII enfant en clair)
  at              INTEGER NOT NULL              -- timestamp Unix immuable
);

CREATE INDEX IF NOT EXISTS idx_audit_prof   ON prof_audit_log(prof_id);
CREATE INDEX IF NOT EXISTS idx_audit_at     ON prof_audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON prof_audit_log(action);


-- ===== Vue utilitaire =====
CREATE VIEW IF NOT EXISTS v_profs_actifs AS
SELECT id, email, nom_affiche, code_classe, twofa_methode, created_at, derniere_connexion
FROM profs
WHERE statut = 'actif';
