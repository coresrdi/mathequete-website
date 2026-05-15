-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0006 — Sprint D3 : Double wrapping DEK (hybride)
-- ─────────────────────────────────────────────────────────────────────────────
-- Date    : 15 mai 2026
-- Sprint  : D3 (CRUD élèves chiffré)
-- Objet   : Ajoute le wrapping client (PBKDF2 mdp) de la DEK en plus du
--           wrapping serveur (KEK Cloudflare) qui existe déjà.
--
-- Modèle hybride :
--   - dek_chiffree / dek_iv          : wrap par KEK serveur (existant, backup)
--   - dek_wrap_user / dek_iv_user    : wrap par K_user = PBKDF2(mdp prof)
--   - dek_salt_user                  : sel PBKDF2 unique par prof
--   - dek_iter_user                  : nombre d'itérations PBKDF2 (versionné)
--
-- Au login normal : le client dérive K_user à partir du mot de passe entré
-- et déchiffre dek_wrap_user. Le serveur n'a PAS besoin de toucher à la KEK.
--
-- Le KEK serveur reste en place pour :
--   - Permettre un reset password administré (admin + consentement prof)
--   - Récupération en cas d'oubli mdp (vie réelle classe)
--   - Profs existants (signup avant cette migration) : fallback automatique
--
-- Loi 25 : double wrapping = défense en profondeur. Un attaquant doit
-- compromettre soit (a) mdp du prof, soit (b) KEK Cloudflare + DB.
--
-- IMPORTANT : Compatible avec profs existants. Les nouvelles colonnes sont
--             nullable. Les profs sans wrap_user retombent sur le wrap KEK
--             au login et seront re-wrappés transparemment au prochain login
--             réussi.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE profs ADD COLUMN dek_wrap_user TEXT;       -- base64(AES-GCM(DEK, K_user))
ALTER TABLE profs ADD COLUMN dek_iv_user   TEXT;       -- base64 IV
ALTER TABLE profs ADD COLUMN dek_salt_user TEXT;       -- base64 sel PBKDF2 (16 octets)
ALTER TABLE profs ADD COLUMN dek_iter_user INTEGER;    -- itérations PBKDF2 (typiquement 100000)
ALTER TABLE profs ADD COLUMN dek_user_version INTEGER NOT NULL DEFAULT 0;
                                                       -- 0 = pas encore wrappé côté user
                                                       -- 1 = PBKDF2-SHA256-100k (actuel)
                                                       -- 2 = Argon2id (futur Sprint D4)

-- Index optionnel : pas nécessaire, on ne cherche pas par dek_wrap_user.

-- ─────────────────────────────────────────────────────────────────────────────
-- Note : aucune donnée existante n'est modifiée. Les profs créés avant cette
-- migration verront dek_user_version = 0 et seront migrés au prochain login
-- (logique dans worker/src/prof-routes.ts handleLogin).
-- ─────────────────────────────────────────────────────────────────────────────
