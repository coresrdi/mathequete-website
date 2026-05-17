-- Migration 0015 — Sprint EXP-QR (17 mai 2026)
-- Ajout des champs d'expiration aux QR licences.
--
-- ============================================================================
-- But
-- ============================================================================
--
-- Permettre au générateur admin (et plus tard à la génération automatique) de
-- créer des QR avec une durée de vie limitée, selon 2 modes :
--
--   Mode A — Expiration absolue : `expire_le = <timestamp Unix>` fixe.
--            Ex: licence école valide jusqu'au 30 septembre 2027.
--
--   Mode B — Durée glissante : `duree_apres_activation_jours = N`.
--            `expire_le` est NULL à la création, puis CALCULÉ à la première
--            activation = activation_initiale_date + N × 86400.
--            Ex: testeur reçoit un QR qui dure 30 jours dès qu'il l'active.
--
--   Mode "jamais" (legacy) : les deux colonnes restent NULL.
--            Comportement actuel préservé pour tous les QR existants.
--
-- ============================================================================
-- Vérification côté worker
-- ============================================================================
--
-- Helper estExpiree(lqr) :
--   if (lqr.expire_le === null) return false;
--   return Math.floor(Date.now() / 1000) >= lqr.expire_le;
--
-- À appeler dans /api/jeu/activer-qr ET dans tout endpoint qui consulte une
-- licence active (refresh, info-qr, etc.). Si expiré → renvoyer
-- code: 'EXPIRED' avec status 410.
--
-- ============================================================================
-- Backward compatibility
-- ============================================================================
--
-- Les 2 colonnes sont nullable, pas de DEFAULT non-NULL. Tous les QR émis
-- avant cette migration restent fonctionnels (expire_le IS NULL = jamais
-- expirer). Aucune migration de données nécessaire.
--
-- ============================================================================

ALTER TABLE licences_qr
  ADD COLUMN expire_le INTEGER;

ALTER TABLE licences_qr
  ADD COLUMN duree_apres_activation_jours INTEGER;

-- Index pour purge périodique des QR expirés (cron futur)
CREATE INDEX IF NOT EXISTS idx_licences_qr_expire_le
  ON licences_qr(expire_le) WHERE expire_le IS NOT NULL;
