-- Migration 0008 — Sprint D5 : Chiffrement at-rest du payload_json des stats élèves
-- Mai 2026
--
-- BUT
--   Protéger les données détaillées des élèves (payload_json) contre un dump DB.
--   On ajoute 3 colonnes : payload_chiffre (BLOB), payload_iv (BLOB), payload_kdf (TEXT).
--   Le champ legacy payload_json reste pour rétro-compat des lignes existantes.
--
-- STRATÉGIE
--   - Nouveaux INSERT : worker chiffre payload_json → payload_chiffre + payload_iv,
--     met payload_json = NULL, payload_kdf = 'hkdf_sha256_master_v1'.
--   - SELECT côté worker : si payload_chiffre IS NOT NULL → déchiffre, sinon → payload_json.
--   - Migration progressive : les vieilles lignes restent lisibles ; un script de
--     migration ultérieur pourra les chiffrer rétroactivement si nécessaire.
--
-- CLÉ
--   K_stats(licence_id) = HKDF-SHA256(
--     ikm  = MASTER_ENCRYPTION_KEY,
--     salt = "mathequete-stats-v1",
--     info = licence_id
--   )
--   → 32 octets, AES-256-GCM IV 12 octets.

ALTER TABLE stats_eleves ADD COLUMN payload_chiffre BLOB;
ALTER TABLE stats_eleves ADD COLUMN payload_iv BLOB;
ALTER TABLE stats_eleves ADD COLUMN payload_kdf TEXT;
