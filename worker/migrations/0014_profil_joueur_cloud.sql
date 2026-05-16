-- Migration 0014 — Sprint DEC-63 (16 mai 2026, 14h30 UTC)
-- Décision DEC-63 (PROFIL-JOUEUR-CLOUD) — modèle hybride device+profil pour
-- multi-licences cumulatives validé par Jeff 16 mai 10h28 EDT.
--
-- ============================================================================
-- Contexte (raisonnement Jeff)
-- ============================================================================
--
-- Avant cette migration : 1 QR = 1 device_fingerprint = 1 produit débloqué.
-- Un appareil ne pouvait pas cumuler plusieurs licences QR provenant de
-- canaux différents (ex: 1 QR école Continent 1 + 1 QR pack familial Continent 2).
--
-- Limites du modèle actuel :
--   - Pas de "compte joueur" portable entre appareils
--   - Transfert d'appareil = perte temporaire de toutes les licences
--   - Pas de vue claire "tous mes produits actifs" pour un même utilisateur
--
-- Nouveau modèle hybride :
--   1. Le QR reste lié à un device_fingerprint courant (champ existant
--      `licences_qr.device_fingerprint` — pas touché par cette migration).
--   2. UN profil joueur cloud peut "réclamer" plusieurs QR.
--   3. Un appareil peut avoir 0, 1 ou N QR actifs simultanément.
--   4. L'état "version gratuite" est CALCULÉ (pas stocké) :
--      = aucune ligne active dans `activations_appareil` pour ce device/profil.
--
-- ============================================================================
-- Table 1 : profils_joueur (compte cloud joueur — léger, opt-in)
-- ============================================================================
--
-- Note : c'est différent des comptes `profs` (DEC-51). Les joueurs (enfants
-- 6-12 ans) ne créent PAS de compte avec email/mot de passe. Le profil cloud
-- est créé automatiquement à la 1ère activation QR et identifié par un
-- `recovery_code` que l'enfant note quelque part (ou que le prof imprime).
--
-- Loi 25 : aucune donnée nominative ici. Pas de prénom/nom/email/âge.
-- Le `eleve_pseudo` reste dans `licences_qr` (champ existant) sans lien direct.

CREATE TABLE IF NOT EXISTS profils_joueur (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  recovery_code       TEXT NOT NULL UNIQUE,    -- 16 chars Crockford "MQJ-XXXX-XXXX-XXXX"
                                                -- imprimé/noté par l'enfant ou le prof
  date_creation       INTEGER NOT NULL,        -- epoch seconds
  date_derniere_act   INTEGER NOT NULL,        -- pour cleanup profils orphelins futurs
  est_archive         INTEGER NOT NULL DEFAULT 0  -- soft delete (RGPD/Loi 25)
);

CREATE INDEX IF NOT EXISTS idx_profils_joueur_recovery
  ON profils_joueur(recovery_code) WHERE est_archive = 0;

-- ============================================================================
-- Table 2 : activations_appareil (liaison N-N entre QR et appareils)
-- ============================================================================
--
-- 1 rangée ACTIVE (date_revocation IS NULL) = 1 produit débloqué sur 1 appareil.
-- Un appareil peut avoir N rangées actives → N produits cumulés.
-- Un QR peut avoir plusieurs rangées historiques mais 1 seule active à la fois
--   (l'ancienne est révoquée lors d'un transfert via item 13 PB1).
--
-- Le champ profil_joueur_id est OPTIONNEL :
--   - NULL = activation hors profil cloud (ancien comportement, encore valide)
--   - Non-NULL = activation rattachée à un profil cloud (nouveau, recommandé)
--
-- C'est ça l'aspect "hybride" : on peut migrer progressivement les anciennes
-- activations vers le modèle cloud sans tout casser.

CREATE TABLE IF NOT EXISTS activations_appareil (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  cle_qr                   TEXT NOT NULL,           -- FK licences_qr.cle_qr
  device_fingerprint       TEXT NOT NULL,
  profil_joueur_id         INTEGER,                 -- NULL = pas encore lié à un profil cloud
  produit_id               TEXT NOT NULL,           -- snapshot du licences_qr.produit_id
                                                     -- au moment de l'activation
  date_activation          INTEGER NOT NULL,
  date_revocation          INTEGER,                 -- NULL = active ; sinon = transférée
  motif_revocation         TEXT,                    -- 'transfer_auto', 'transfer_prof',
                                                     -- 'revoked_admin', 'replaced'
  FOREIGN KEY (cle_qr)           REFERENCES licences_qr(cle_qr),
  FOREIGN KEY (profil_joueur_id) REFERENCES profils_joueur(id)
);

-- Index hot path : "quelles sont les activations actives pour ce device ?"
-- (appelé à chaque démarrage du jeu côté Godot)
CREATE INDEX IF NOT EXISTS idx_activations_device_active
  ON activations_appareil(device_fingerprint, date_revocation)
  WHERE date_revocation IS NULL;

-- Index : "quels appareils utilisent actuellement ce QR ?" (pour transferts)
CREATE INDEX IF NOT EXISTS idx_activations_qr_active
  ON activations_appareil(cle_qr, date_revocation)
  WHERE date_revocation IS NULL;

-- Index : "tous les produits actifs pour un profil cloud" (cross-device)
CREATE INDEX IF NOT EXISTS idx_activations_profil_active
  ON activations_appareil(profil_joueur_id, date_revocation)
  WHERE profil_joueur_id IS NOT NULL AND date_revocation IS NULL;

-- ============================================================================
-- Migration douce des activations existantes (idempotent)
-- ============================================================================
--
-- Pour chaque licences_qr déjà activé (device_fingerprint NOT NULL),
-- on crée une rangée dans activations_appareil pour ne pas perdre l'historique.
-- L'activation existante est marquée profil_joueur_id = NULL (à rattacher plus
-- tard si l'utilisateur crée un profil cloud).

INSERT INTO activations_appareil
  (cle_qr, device_fingerprint, profil_joueur_id, produit_id,
   date_activation, date_revocation, motif_revocation)
SELECT
  cle_qr,
  device_fingerprint,
  NULL,                              -- pas de profil cloud rétroactif
  produit_id,
  COALESCE(activation_initiale_date, date_creation),
  NULL,                              -- toujours active
  NULL
FROM licences_qr
WHERE device_fingerprint IS NOT NULL
  AND activation_initiale_date IS NOT NULL
  AND est_revoquee = 0
  AND NOT EXISTS (
    -- garde-fou idempotence : ne recrée pas si déjà migré
    SELECT 1 FROM activations_appareil a
    WHERE a.cle_qr = licences_qr.cle_qr
      AND a.device_fingerprint = licences_qr.device_fingerprint
      AND a.date_revocation IS NULL
  );

-- ============================================================================
-- Note implementation (rappel agent §11)
-- ============================================================================
--
-- Cette migration N'ENLÈVE PAS les champs licences_qr.device_fingerprint /
-- activation_initiale_date / derniere_activation_date / nb_transferts_*.
-- Ils restent comme "vue actuelle" rapide pour rétrocompat avec le code existant.
--
-- Mais à terme (DEC-63 phase 2, après refactor complet activer-qr) on pourra
-- les déprécier au profit de activations_appareil. Pour PB1 on coexiste.
--
-- Le nouvel endpoint GET /api/jeu/mes-licences/:device_fingerprint lit
-- UNIQUEMENT activations_appareil.
--
-- Le endpoint POST /api/jeu/activer-qr (item 12 PB1) sera refactoré pour :
--   1. Continuer à updater licences_qr (compat)
--   2. ET aussi INSERT dans activations_appareil
-- Sa logique de transfert (item 13 PB1) marquera la ligne précédente
-- date_revocation = now + motif_revocation = 'transfer_auto'/'transfer_prof'.
