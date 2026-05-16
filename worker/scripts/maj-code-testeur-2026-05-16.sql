-- ════════════════════════════════════════════════════════════════════════════════
-- Mise à jour ponctuelle — 16 mai 2026, 10h42 EDT
-- ════════════════════════════════════════════════════════════════════════════════
--
-- Objet : remonter la limite max_activations du code testeur Jeff à 250.
-- Demande : Jeff a atteint la limite actuelle et veut continuer à tester.
--
-- ⚠️  Ce fichier N'EST PAS DANS migrations/ — c'est une opération de données
-- ponctuelle, pas un changement de schéma. Le rejouer est sans effet (idempotent).
--
-- Trace : à inscrire dans registre v4.16 sous §10 (opérations DB manuelles).
--
-- Comment l'appliquer (à lancer côté Jeff, dans Git Bash) :
--
--   cd /c/mathequete/mathequete-website/worker
--   npx wrangler d1 execute mathequete-db --remote --file=scripts/maj-code-testeur-2026-05-16.sql
--
-- Pour tester en local (D1 dev) avant prod :
--
--   npx wrangler d1 execute mathequete-db --local --file=scripts/maj-code-testeur-2026-05-16.sql
-- ════════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. UPDATE — couvre toutes les variantes de casse (manu-test-2026,
--    MANU-TEST-2026, Manu-Test-2026, etc.) en une seule requête grâce à LOWER().
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Garde-fous :
--   - 250 >= used_activations : on n'écrase pas si Jeff a déjà dépassé 250
--     (auquel cas il faudra monter encore plus haut manuellement).
--   - COALESCE sur notes_internes : préserve l'historique précédent s'il existe.

UPDATE activation_codes
   SET max_activations = 250,
       notes_internes = COALESCE(notes_internes || ' | ', '')
                        || 'Limite remontée à 250 le 2026-05-16 (Jeff via deploy.sh)'
 WHERE LOWER(code) = 'manu-test-2026'
   AND 250 >= used_activations;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Vérification — affiche l'état final pour confirmation visuelle.
-- ─────────────────────────────────────────────────────────────────────────────

SELECT code,
       label,
       max_activations,
       used_activations,
       (max_activations - used_activations) AS restant,
       actif,
       CASE WHEN expire_le = 0 THEN 'jamais'
            ELSE datetime(expire_le, 'unixepoch')
       END AS expire,
       notes_internes
  FROM activation_codes
 WHERE LOWER(code) = 'manu-test-2026';
