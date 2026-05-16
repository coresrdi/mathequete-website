-- Migration 0013 — Sprint DEC-59 (16 mai 2026, 14h15 UTC)
-- Décision DEC-59 (LICENCES-QR-SOURCES) du registre v4.6+
--
-- Cette migration ajoute le champ `source` à `licences_qr` pour tracer l'origine
-- de chaque QR (école, promo, pack familial, activation Windows directe, cadeau).
-- C'est le pré-requis de DEC-60 (ACTIVATION-EXTERNE) qui veut un système universel
-- d'activation QR+code 12-chars, et permet la séparation comptable/analytique des
-- différents canaux de distribution.
--
-- ============================================================================
-- Choix d'implémentation (validé par Jeff 16 mai 10h12 EDT)
-- ============================================================================
--
-- Option A retenue : NOT NULL DEFAULT 'cadeau' rétroactive.
--
-- Justification :
--   - Tous les QR existants avant cette migration n'ont pas d'origine tracée
--     formellement → 'cadeau' = valeur neutre la plus prudente (signale "origine
--     non spécifiée / historique pré-DEC-59").
--   - Pour les nouvelles INSERT (post-0013), le code Worker DOIT toujours
--     fournir explicitement la source — la DEFAULT n'est qu'un filet pour
--     éviter de casser le legacy.
--   - Si Jeff identifie plus tard la vraie source d'un QR existant, simple
--     UPDATE manuel possible (audit log laissera trace).
--
-- ============================================================================
-- Valeurs autorisées (CHECK CONSTRAINT)
-- ============================================================================
--
--   - 'ecole'           : QR distribué via un forfait_ecole_id (achat école)
--                          → `forfait_ecole_id` DOIT être renseigné en pratique
--                            (vérification métier côté Worker, pas SQL)
--   - 'promo'           : QR généré pour campagne marketing/concours/influence
--                          (codes promo, démo presse, etc.)
--   - 'pack_familial'   : QR vendu par lot (ex: pack 5 enfants pour une famille)
--                          → `forfait_ecole_id` peut être NULL
--   - 'windows_direct'  : QR acheté directement via app Tauri Windows ou page web
--                          d'achat individuel (canal alternatif au Play Store)
--   - 'cadeau'          : QR offert manuellement (legacy avant DEC-59, ou cadeau
--                          ponctuel, ou test interne)
--
-- ============================================================================
-- Migration
-- ============================================================================

ALTER TABLE licences_qr
  ADD COLUMN source TEXT NOT NULL DEFAULT 'cadeau'
  CHECK (source IN ('ecole','promo','pack_familial','windows_direct','cadeau'));

-- ============================================================================
-- Index analytique (DEC-59)
-- ============================================================================
--
-- Permet des rapports rapides "combien de QR par source", "QR ecole vs promo
-- ce mois-ci", etc. Composite avec date_creation pour les requêtes temporelles.

CREATE INDEX IF NOT EXISTS idx_licences_qr_source
  ON licences_qr(source, date_creation);

-- ============================================================================
-- Note pour les futures INSERT (rappel agent §11)
-- ============================================================================
--
-- Tout nouveau code Worker qui crée un licences_qr DOIT fournir `source`
-- explicitement, par exemple :
--
--   INSERT INTO licences_qr (cle_qr, ..., source, date_creation)
--   VALUES (?, ..., 'ecole', strftime('%s','now')*1000);
--
-- Ne PAS s'appuyer sur la DEFAULT 'cadeau' pour le nouveau code — elle existe
-- uniquement pour la compatibilité rétro avec les rangées créées avant 0013.
