# Runbook Production — Mathéquête API Worker

**Dernière mise à jour :** 13 mai 2026
**Auteur :** Setup initial (Cores RDI)
**Version Worker :** v1.0 (premier flux E2E validé)

---

## 0. Vue d'ensemble

Mathéquête utilise une infrastructure **serverless gratuite** pour gérer la vente de licences :

```
Acheteur → Stripe Checkout → Webhook → Cloudflare Worker → D1 (SQLite) + Resend (email)
```

**Coûts mensuels actuels :** **0 $** (tous les services en plan gratuit).

| Service | Rôle | Plan |
|---|---|---|
| Cloudflare Worker | API backend (webhook, checkout) | Free (100k req/jour) |
| Cloudflare D1 | Base de données SQLite | Free (5 GB) |
| Stripe | Traitement paiements | Test mode (gratuit) — 2,9% + 0,30 $ par tx en live |
| Resend | Envoi emails transactionnels | Free (100 emails/jour, 3000/mois) |

---

## 1. Identifiants de production (publics, safe)

| Élément | Valeur |
|---|---|
| Worker URL | `https://mathequete-api.coresrdi.workers.dev` |
| Worker name | `mathequete-api` |
| Subdomain CF | `coresrdi.workers.dev` |
| Account ID CF | `5b900ac6492c6f6df7b5a483edad56a1` |
| D1 database ID | `e3c52431-082b-463f-b6d3-bd777e76dc97` |
| D1 database name | `mathequete-db` |
| Email business | `coresrdi@gmail.com` |

**URLs endpoints du Worker :**
- `GET  /health` — ping santé (retourne `{status:"ok", env, ts}`)
- `POST /create-checkout-session` — crée session Stripe Checkout (body: `{tier: "classe_petite"}`)
- `POST /stripe-webhook` — réception webhook Stripe (auto par Stripe)
- `POST /verify-license` — vérification offline d'un code

---

## 2. Secrets sensibles (à NE JAMAIS coller en chat ou en code)

Tous les secrets sont stockés en **double** :
1. **OneDrive → Coffre-fort → mathequete-secrets.txt** (référence locale chiffrée Microsoft)
2. **Cloudflare Worker secrets** (production)

| Secret | Format | Usage |
|---|---|---|
| `HMAC_SECRET_KEY` | 64 hex chars | Signature des codes de licence (côté Worker + côté Godot) |
| `STRIPE_SECRET_KEY` | `sk_test_xxx` (passera à `sk_live_xxx` plus tard) | Appels API Stripe |
| `STRIPE_WEBHOOK_SECRET` | `whsec_xxx` | Validation signature webhooks entrants |
| `RESEND_API_KEY` | `re_xxx` | Envoi emails via Resend |

**⚠️ Si un secret est exposé** (collé en chat, push GitHub par erreur, etc.) :
1. Révoquer immédiatement dans le dashboard du service
2. Générer un nouveau secret
3. Mettre à jour le Coffre-fort
4. Re-push au Worker (voir §5)

---

## 3. Variables d'environnement (non sensibles, dans wrangler.toml)

| Variable | Valeur actuelle | À changer quand... |
|---|---|---|
| `ENVIRONMENT` | `"production"` | jamais |
| `STRIPE_API_VERSION` | `"2024-12-18.acacia"` | Stripe annonce nouvelle version stable |
| `RESEND_FROM_EMAIL` | `"onboarding@resend.dev"` | Domaine mathequete.ca acheté + vérifié sur Resend |
| `RESEND_FROM_NAME` | `"Mathéquête"` | jamais |
| `PUBLIC_SITE_URL` | `"https://mathequete-api.coresrdi.workers.dev"` | Domaine mathequete.ca acheté + DNS configuré |

---

## 4. Architecture du code

**Repo GitHub :** `https://github.com/coresrdi/mathequete-website`
**Dossier local :** `~/OneDrive/projet speciaux/mathequete-website/worker/`

```
worker/
├── src/
│   ├── index.ts            ← Routing principal (4 routes)
│   ├── stripe-webhook.ts   ← handleStripeWebhook + handleCreateCheckoutSession
│   ├── generate-codes.ts   ← Génération code HMAC, types, IDs
│   ├── email.ts            ← Template HTML + appel Resend
│   └── types.ts            ← Env interface + PRIX_TIERS_CENTS
├── schema.sql              ← 4 tables D1 + 2 vues
├── wrangler.toml           ← Config Cloudflare (env vars, D1 binding)
└── package.json
```

**Tables D1 :**
- `licences` — codes émis (un par achat ou code promo)
- `achats` — historique transactions Stripe (idempotence via `stripe_session_id`)
- `codes_actives` — devices ayant activé une licence (anti-abus partage)
- `emails_envoyes` — audit log envois Resend

---

## 5. Commandes opérationnelles courantes

**Prérequis :** Être dans le dossier worker.
```bash
cd ~/OneDrive/projet\ speciaux/mathequete-website/worker
```

### 5.1 Déployer une modification de code

```bash
wrangler deploy
```

⚠️ Le warning "Multiple environments are defined... no target environment was specified" est bénin — Wrangler prend le top-level env par défaut = production.

### 5.2 Voir les logs en direct

```bash
wrangler tail --format pretty
```

Garde ouvert, déclenche une action, observe les `console.log` / `console.error`.

Si timeout, alternative : Dashboard Cloudflare → Worker → onglet "Observability" → Logs → Begin stream.

### 5.3 Push d'un secret (méthode SANS Notepad — recommandée)

⚠️ **Ne PAS utiliser Notepad** — il ajoute un `\r\n` Windows qui corrompt la valeur.

```bash
printf '%s' 'COLLE_TON_SECRET_ICI_ENTRE_APOSTROPHES' > /c/Users/renoc/secret_clean.txt
wc -c /c/Users/renoc/secret_clean.txt    # Vérifier taille (sans \n final)
wrangler secret put NOM_DU_SECRET < /c/Users/renoc/secret_clean.txt
wrangler deploy
rm /c/Users/renoc/secret_clean.txt
```

### 5.4 Lister les secrets stockés

```bash
wrangler secret list
```

(N'affiche que les noms, pas les valeurs — Cloudflare ne permet pas de relire un secret.)

### 5.5 Requêtes SQL sur D1 (production)

⚠️ **Toujours `--remote`** sinon wrangler tape dans le SQLite local, pas la prod.

```bash
# Lister les tables
wrangler d1 execute mathequete-db --remote --command="SELECT name FROM sqlite_master WHERE type='table'"

# Compter licences émises
wrangler d1 execute mathequete-db --remote --command="SELECT COUNT(*) FROM licences"

# Voir derniers achats
wrangler d1 execute mathequete-db --remote --command="SELECT email_acheteur, total_cents/100.0 AS cad, paye_le FROM achats ORDER BY paye_le DESC LIMIT 10"

# Voir derniers emails envoyés
wrangler d1 execute mathequete-db --remote --command="SELECT destinataire, statut, envoye_le, erreur FROM emails_envoyes ORDER BY envoye_le DESC LIMIT 10"

# Stats mensuelles (vue prédéfinie)
wrangler d1 execute mathequete-db --remote --command="SELECT * FROM v_stats_mensuel"
```

### 5.6 Réinjecter le schéma D1 (si tables manquantes)

```bash
wrangler d1 execute mathequete-db --remote --file=schema.sql
```

Avec `CREATE TABLE IF NOT EXISTS` partout, c'est idempotent — ne casse rien si tables existent.

### 5.7 Re-login Wrangler (si timeout OAuth)

```bash
wrangler login
```

Ouvre navigateur → Allow access → retour terminal "Successfully logged in".

---

## 6. Procédure de test end-to-end

### 6.1 Générer une session checkout

```bash
curl -X POST https://mathequete-api.coresrdi.workers.dev/create-checkout-session \
  -H "Content-Type: application/json" \
  -d '{"tier":"classe_petite"}'
```

Réponse attendue : `{"url":"https://checkout.stripe.com/...","session_id":"cs_test_..."}`

**Tiers disponibles :** `classe_petite` (35$), `classe_moyenne` (98$), `petite_ecole` (265$), `ecole_standard` (393$), `grande_ecole` (650$), `mega_ecole` (716$).

### 6.2 Payer en mode test

Ouvre l'URL retournée → page Stripe Checkout. Remplis :

| Champ | Valeur test |
|---|---|
| Email | `coresrdi@gmail.com` (le seul autorisé en mode test Resend sans domaine vérifié) |
| Carte | `4242 4242 4242 4242` |
| Expiration | `12 / 30` (n'importe quelle date future) |
| CVC | `123` |
| Adresse | adresse valide au QC (taxes calculées) |

### 6.3 Vérifier le flux

```bash
# 1. Webhook reçu par Stripe (dashboard.stripe.com/test/workbench/webhooks) → 200 OK
# 2. Licence créée :
wrangler d1 execute mathequete-db --remote --command="SELECT * FROM licences ORDER BY emis_le DESC LIMIT 1"

# 3. Email envoyé :
wrangler d1 execute mathequete-db --remote --command="SELECT * FROM emails_envoyes ORDER BY envoye_le DESC LIMIT 1"

# 4. Boîte Gmail coresrdi@gmail.com → email avec code MQ-CLAS-XXXX-XXXX-XXXX-XXXX (vérifier Promotions et Spam)
```

### 6.4 Trigger événement via Stripe CLI (sans paiement réel)

```bash
/c/Users/renoc/stripe.exe login    # si pas déjà connecté
/c/Users/renoc/stripe.exe trigger checkout.session.completed
```

⚠️ **Limite** : l'événement généré par CLI n'a PAS de `metadata.tier`, donc le Worker retourne "Tier invalide". Pour un test réel, faire un vrai paiement via 6.1+6.2.

---

## 7. Troubleshooting — Erreurs vues en setup initial

### 7.1 Webhook retourne 404 Not Found
**Cause :** URL du webhook dans Stripe incorrecte.
**Bonne URL :** `https://mathequete-api.coresrdi.workers.dev/stripe-webhook` (un seul tiret, pas `/api/stripe/webhook`)
**Fix :** Modifier la destination dans Stripe Dashboard → Webhooks.

### 7.2 Webhook retourne 400 "Signature invalide"
**Cause :** `STRIPE_WEBHOOK_SECRET` corrompu (souvent `\r\n` Windows ajouté par Notepad).
**Fix :** Re-push avec `printf '%s'` (voir §5.3). La taille du `whsec_xxx` doit être 38 caractères exacts (vérifier avec `wc -c`).

### 7.3 Webhook retourne 500 "error code 1101"
**Cause :** Exception non gérée dans le Worker. Causes possibles :
- Tables D1 manquantes (réinjecter `schema.sql` — §5.6)
- `STRIPE_SECRET_KEY` invalide
- `automatic_tax: enabled: true` sans adresse de siège déclarée sur Stripe ([dashboard.stripe.com/test/settings/tax](https://dashboard.stripe.com/test/settings/tax))

**Fix :** Lancer `wrangler tail` et renvoyer l'événement pour voir le message exact.

### 7.4 Webhook 200 OK mais aucun email reçu
**Cause :** L'envoi Resend a planté silencieusement, ou clé Resend invalide/corrompue.
**Diagnostic :**
```bash
wrangler d1 execute mathequete-db --remote --command="SELECT * FROM emails_envoyes ORDER BY envoye_le DESC LIMIT 1"
```
- Si vide → l'appel `fetch()` à Resend a throw avant l'INSERT
- Si `statut = 'failed'` → la colonne `erreur` indique pourquoi Resend a refusé

**Fix typique :** Re-push `RESEND_API_KEY` avec méthode `printf '%s'` (§5.3). Taille attendue ≈ 36 caractères.

### 7.5 Webhook "OK (déjà traité)" mais email manquant
**Cause :** Logique d'idempotence — la session a été tentée une fois, l'envoi email a échoué, mais l'entrée `achats` a été créée. Tout renvoi est court-circuité.
**Fix :** Supprimer l'entrée d'idempotence puis renvoyer :
```bash
wrangler d1 execute mathequete-db --remote --command="DELETE FROM achats WHERE stripe_session_id='cs_test_XXX'"
wrangler d1 execute mathequete-db --remote --command="DELETE FROM licences WHERE stripe_session='cs_test_XXX'"
# Puis "Renvoyer" dans le dashboard Stripe
```

### 7.6 Erreur Resend : "Invalid header value"
**Cause :** `RESEND_API_KEY` contient un `\r\n` à la fin (Notepad Windows).
**Fix :** Voir §5.3 — utiliser `printf '%s'` pas Notepad.

### 7.7 Wrangler : "CLOUDFLARE_API_TOKEN environment variable"
**Cause :** Session OAuth Wrangler expirée (timeout 6h).
**Fix :** `wrangler login`

### 7.8 `wrangler tail` timeout / ETIMEDOUT
**Cause :** Soit problème réseau temporaire Cloudflare, soit firewall local.
**Alternative :** Dashboard Cloudflare → Worker → "Observability" → Live Logs → Begin stream.

### 7.9 Page checkout Stripe : "Something went wrong" / "Page not found"
**Cause :** Souvent l'URL copiée a été corrompue (caractères `\\` ou retours à la ligne).
**Fix :** Générer une nouvelle session (§6.1) ou récupérer la dernière session via CLI :
```bash
/c/Users/renoc/stripe.exe checkout sessions list --limit 1
```
Puis copier la valeur du champ `url` dans le navigateur.

### 7.10 Resend refuse d'envoyer à un email autre que coresrdi@gmail.com
**Cause :** Sans domaine vérifié sur Resend, seul l'email du compte Resend peut recevoir des emails depuis `onboarding@resend.dev`. C'est une limitation officielle Resend.
**Fix :** Acheter et vérifier un domaine (mathequete.ca) sur Resend, puis configurer SPF + DKIM. Voir §8.

---

## 8. Roadmap restant (post-setup initial)

| # | Item | Effort | Priorité |
|---|---|---|---|
| 1 | Acheter domaine `mathequete.ca` (Cloudflare Registrar ~13$ CAD/an) | 10 min | Quand cash |
| 2 | Configurer DNS Cloudflare → pointe `api.mathequete.ca` vers Worker | 5 min | Après #1 |
| 3 | Ajouter + vérifier domaine sur Resend (SPF + DKIM) | 30 min | Après #1 |
| 4 | Changer `RESEND_FROM_EMAIL` → `contact@mathequete.ca` | 1 min | Après #3 |
| 5 | Changer `PUBLIC_SITE_URL` → `https://mathequete.ca` | 1 min | Après #2 |
| 6 | Construire site web public (`achat.html`, `merci.html`, etc.) | 1-2 jours | Après #1 |
| 7 | Activer compte Stripe (vérif identité + bancaire) → obtenir `sk_live_xxx` | 2-3 jours (validation Stripe) | Quand site prêt |
| 8 | Remplacer `STRIPE_SECRET_KEY` → `sk_live_xxx` (passage en LIVE) | 5 min | Après #7 + 1ère vente prête |
| 9 | Créer webhook LIVE (en plus du TEST) avec `whsec_live_xxx` | 10 min | Après #7 |
| 10 | Tester un VRAI paiement avec ta vraie carte (puis remboursement immédiat) | 15 min | Après #8 |

---

## 9. Contacts d'urgence services

| Service | Support | Dashboard |
|---|---|---|
| Cloudflare | [community.cloudflare.com](https://community.cloudflare.com) | [dash.cloudflare.com](https://dash.cloudflare.com) |
| Stripe | Chat in-app (rapide) | [dashboard.stripe.com](https://dashboard.stripe.com) |
| Resend | [resend.com/help](https://resend.com/help) | [resend.com](https://resend.com) |

---

## 10. Annexe — Anatomie d'un code de licence

```
MQ-CLAS-HKAQ-UB8X-RHDL-AVZC
│  │    └─────────────────┘
│  │           │
│  │           └─ 16 chars : payload (type + id + expire) signé HMAC-SHA256
│  │
│  └─ Type abrégé : CLAS (CLASSE) / ECOL (ECOLE) / CONT (CONTINENT) / LIFE (LIFETIME) / PROM (PROMO) / ESSA (ESSAI)
│
└─ Préfixe constant "MQ" (Mathéquête)
```

**Vérification offline** : la fonction `verifierCodeBrut(code, HMAC_SECRET_KEY)` recalcule le HMAC et compare. Pas besoin de réseau côté jeu Godot.

---

**Fin du runbook v1.0** — À mettre à jour à chaque changement majeur (nouveau secret, nouveau service, nouvelle table D1, etc.).
