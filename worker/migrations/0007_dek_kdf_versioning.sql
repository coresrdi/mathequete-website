-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0007 — Sprint D4 : Versioning explicite du KDF
-- ─────────────────────────────────────────────────────────────────────────────
-- Date    : 15 mai 2026
-- Sprint  : D4 (Upgrade DEK + migration Argon2id)
-- Objet   : Ajoute une colonne TEXT dek_kdf pour identifier explicitement
--           l'algorithme KDF utilisé pour wrapper la DEK avec K_user.
--
-- Motivation :
--   Avant cette migration, dek_user_version (INTEGER) servait à la fois de
--   compteur d'upgrade ET d'indicateur de KDF. C'est ambigu :
--     - version = 1 -> PBKDF2-SHA256 100k ? ou 200k ? ou 300k ?
--     - version = 2 -> Argon2id ? ou Argon2d ? quels paramètres m/t/p ?
--
--   En ajoutant dek_kdf comme chaîne libre (mais validée côté serveur),
--   on rend l'identification du KDF non-ambiguë et on garde
--   dek_user_version comme simple compteur monotone d'upgrade (utile pour
--   éviter les races de double upgrade concurrent).
--
-- Valeurs supportées au déploiement (la liste s'étoffera avec le temps) :
--   - 'pbkdf2_sha256_100k'  : PBKDF2-SHA256 100 000 itérations (legacy D3)
--   - 'argon2id_m64_t3_p1'  : Argon2id m=65536 KiB, t=3 itérations, p=1 lane
--
-- Stratégie de migration des lignes existantes :
--   - Profs qui ont fait signup en D3 (dek_user_version >= 1) :
--     -> dek_kdf = 'pbkdf2_sha256_100k' (c'était l'unique option à l'époque)
--   - Profs créés avant D3 (dek_user_version = 0) :
--     -> dek_kdf reste NULL : ils n'ont pas encore de wrap_user de toute
--        façon, donc pas de KDF à identifier. Au prochain login (avec leur
--        nouveau mdp encore en RAM), le client générera un wrap Argon2id
--        directement (skip de PBKDF2).
--
-- IMPORTANT : Cette migration est purement additive et compatible arrière.
--             Si le worker continue à servir l'ancien code, dek_kdf est
--             simplement ignorée.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE profs ADD COLUMN dek_kdf TEXT;

-- Backfill : les profs qui ont déjà un wrap_user (D3 PBKDF2) sont marqués
-- explicitement. WHERE garantit qu'on ne touche pas les profs legacy
-- (dek_user_version = 0) qui n'ont pas de wrap_user.
UPDATE profs
   SET dek_kdf = 'pbkdf2_sha256_100k'
 WHERE dek_user_version >= 1
   AND dek_wrap_user IS NOT NULL
   AND dek_kdf IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Pas d'index nécessaire : on ne cherche jamais par dek_kdf, seulement par
-- prof.id (clé primaire).
-- ─────────────────────────────────────────────────────────────────────────────
