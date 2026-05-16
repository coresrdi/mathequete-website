-- Migration 0011 — Sprint PB1 item 11.0 (16 mai 2026, 02h45 UTC)
-- Décisions PB1-DEC-10 (rôles admin/membre) + PB1-DEC-11 (table de liaison)
--
-- Liaison N:N entre profs (table `profs`, migration 0005) et forfaits école
-- (table `forfaits_ecole`, migration 0010).
--
-- Rôles :
--   * 'admin'  : l'admin de l'école (== `forfaits_ecole.email_admin`). UN SEUL
--                par forfait (CHECK applicatif côté Worker, pas DB).
--   * 'membre' : prof qui s'est lié à l'école par code_court + email_admin et
--                attend la validation de l'admin pour recevoir des QR.
--
-- Statut :
--   * 'en_attente' : demande envoyée par le prof, pas encore validée par l'admin
--                    (les `admin` sont créés directement en 'valide' au signup
--                    du forfait — pas de validation à eux-mêmes).
--   * 'valide'     : actif, peut recevoir des QR (membre) ou en assigner (admin).
--   * 'revoque'    : retiré par l'admin (ou prof a quitté). Conserve l'historique
--                    pour audit Loi 25 mais bloque toute opération QR.
--
-- Attribution des QR (PB1-DEC-11) :
--   * `nb_qr_max`     : quota maximal de QR que ce prof peut attribuer (set par admin)
--   * `qr_cles_json`  : JSON array TEXT des clés QR effectivement assignées par admin.
--                       Exemple : '["ABCD1234EFGH","WXYZ9876MNOP"]'
--                       Mise à jour atomique côté Worker. Pas de table pivot QR<->prof
--                       car les QR ont déjà `licences_qr.classe_id` qui pointe vers
--                       `classes.prof_id` — la jointure suffit à retrouver "QR du prof X".
--                       Le `qr_cles_json` sert UNIQUEMENT à la phase pré-attribution
--                       (admin a donné mais prof n'a pas encore attribué à une classe).
--
-- Couplage :
--   * FK `prof_id` → `profs(id)` (texte, format `p_xxxxxxxx`)
--   * FK `forfait_ecole_id` → `forfaits_ecole(id)` (autoincrement)
--   * FK `valide_par_prof_id` → `profs(id)` (l'admin qui a validé — NULL si auto-valide)

CREATE TABLE IF NOT EXISTS profs_ecole_lien (
  prof_id                  TEXT NOT NULL,
  forfait_ecole_id         INTEGER NOT NULL,
  role                     TEXT NOT NULL CHECK (role IN ('admin','membre')),
  statut                   TEXT NOT NULL CHECK (statut IN ('en_attente','valide','revoque')),
  nb_qr_max                INTEGER NOT NULL DEFAULT 0,
  qr_cles_json             TEXT NOT NULL DEFAULT '[]',  -- JSON array, jamais NULL
  date_demande             INTEGER NOT NULL,            -- epoch sec
  date_validation          INTEGER,                     -- epoch sec, NULL tant que en_attente
  valide_par_prof_id       TEXT,                        -- prof_id de l'admin (NULL pour rôle 'admin' auto-validé)
  date_revocation          INTEGER,                     -- epoch sec, NULL sauf si statut='revoque'
  raison_revocation        TEXT,                        -- texte libre, NULL sauf si statut='revoque'
  PRIMARY KEY (prof_id, forfait_ecole_id),
  FOREIGN KEY (prof_id)            REFERENCES profs(id),
  FOREIGN KEY (forfait_ecole_id)   REFERENCES forfaits_ecole(id),
  FOREIGN KEY (valide_par_prof_id) REFERENCES profs(id)
);

-- Index pour les requêtes courantes :
-- 1. « Liste mes écoles » côté prof connecté → WHERE prof_id = ?
CREATE INDEX IF NOT EXISTS idx_pel_prof          ON profs_ecole_lien(prof_id, statut);
-- 2. « Liste les profs de mon école » côté admin → WHERE forfait_ecole_id = ?
CREATE INDEX IF NOT EXISTS idx_pel_forfait       ON profs_ecole_lien(forfait_ecole_id, statut, role);
-- 3. « Demandes en attente pour mon école » → WHERE forfait_ecole_id = ? AND statut = 'en_attente'
CREATE INDEX IF NOT EXISTS idx_pel_en_attente    ON profs_ecole_lien(forfait_ecole_id, statut)
  WHERE statut = 'en_attente';

-- Note : pas d'UNIQUE séparé sur (forfait_ecole_id, role='admin') car SQLite ne
-- supporte pas les index UNIQUE partiels avec WHERE pour les contraintes
-- d'unicité applicatives. L'unicité "1 seul admin par forfait" est garantie
-- par le code Worker au moment de la création du forfait école via Stripe.
