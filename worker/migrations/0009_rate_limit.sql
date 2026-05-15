-- Migration 0009 — Sprint D5 : Table rate-limit (anti brute force)
-- Mai 2026
--
-- BUT
--   Stocker des compteurs par clé pour limiter les requêtes sur endpoints sensibles.
--   Pas de KV séparé : on utilise D1 directement.
--
-- MODÈLE
--   key : composite "endpoint:facteur" (ex: "login:ip:1.2.3.4", "dek-upgrade:prof:abc")
--   count : nombre de hits dans la fenêtre courante
--   window_start : timestamp UTC seconde du début de la fenêtre
--   updated_at : dernier hit (pour purge éventuelle)
--
-- FENÊTRE
--   Sliding window simple : si (now - window_start) > window_sec → reset.
--   Sinon : count++. Si count > max → bloqué.
--
-- PURGE
--   Pas de TTL automatique en D1, mais les buckets ne grandissent pas indéfiniment
--   car réutilisés (UPSERT). Job manuel possible : DELETE WHERE updated_at < now - 1day.

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_updated ON rate_limit_buckets(updated_at);
