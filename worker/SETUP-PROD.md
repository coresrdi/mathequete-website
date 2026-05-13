# Setup production Worker Mathéquête — Checklist

> Procédure complète à suivre une seule fois pour passer le Worker de zéro à prod.
> Tous les blocs `bash` sont copiables tels quels (remplace les valeurs marquées `<...>`).

## 0. Prérequis

```bash
node --version          # ≥ 18
npm install -g wrangler
cd /tmp/mathequete-website/worker
npm install
```

## 1. Clé HMAC maître

```bash
openssl rand -hex 32 > ~/prod_hmac.key
chmod 600 ~/prod_hmac.key
cat ~/prod_hmac.key     # → note-la dans 1Password / coffre
```

> **Cette même valeur** doit être déposée plus tard dans Godot via `user://hmac_license.key`. Voir `/tmp/mathequete/docs/SETUP-HMAC.md`.

## 2. Login Cloudflare

```bash
wrangler login
# → ouvre un navigateur, autorise l'accès
wrangler whoami
```

## 3. Base D1

```bash
# Prod
wrangler d1 create mathequete-db
# → copie le database_id affiché → colle-le dans wrangler.toml ligne database_id

# Initialise le schéma
wrangler d1 execute mathequete-db --file=schema.sql --remote

# (Optionnel) Vérification
wrangler d1 execute mathequete-db --remote --command "SELECT name FROM sqlite_master WHERE type='table';"
```

## 4. Secrets

```bash
# Clé HMAC (lit depuis le fichier)
wrangler secret put HMAC_SECRET_KEY < ~/prod_hmac.key

# Stripe — depuis dashboard.stripe.com → Developers → API keys
wrangler secret put STRIPE_SECRET_KEY
# → colle la sk_live_xxx puis Entrée

# Resend — depuis resend.com → API Keys → Create
wrangler secret put RESEND_API_KEY
# → colle la re_xxx puis Entrée

# Vérification
wrangler secret list
```

> Le `STRIPE_WEBHOOK_SECRET` se met à l'étape 6, une fois le webhook créé.

## 5. Premier déploiement

```bash
wrangler deploy
# → affiche l'URL : https://mathequete-api.<account>.workers.dev
```

Teste tout de suite :
```bash
curl https://mathequete-api.<account>.workers.dev/api/health
# → {"status":"ok","env":"production","ts":1736...}
```

## 6. Webhook Stripe

Dashboard Stripe → **Developers → Webhooks → Add endpoint** :

| Champ | Valeur |
|---|---|
| URL | `https://mathequete-api.<account>.workers.dev/api/stripe/webhook`<br/>(ou `https://mathequete.ca/api/stripe/webhook` une fois DNS prêt) |
| Événements | `checkout.session.completed`<br/>`payment_intent.succeeded` |

Une fois créé → clique sur l'endpoint → **Signing secret → Reveal** → copie `whsec_xxx`.

```bash
wrangler secret put STRIPE_WEBHOOK_SECRET
# → colle whsec_xxx puis Entrée
wrangler deploy
```

Dans Stripe → bouton **Send test event** → choisis `checkout.session.completed` → doit retourner **200 OK**.

## 7. Domaine mathequete.ca → Cloudflare

1. Cloudflare Dashboard → **Add a site** → `mathequete.ca` → plan Free
2. Cloudflare te donne 2 nameservers → va sur ton registrar (ex: GoDaddy, OVH) → change les NS
3. Attends la propagation (`dig mathequete.ca NS` doit retourner `*.ns.cloudflare.com`)
4. Une fois actif, dans Cloudflare → Worker → **Settings → Triggers → Add Custom Domain** : `mathequete.ca`
   OU décommente le bloc `routes` dans `wrangler.toml` et fais `wrangler deploy`

## 8. Resend — vérification domaine

1. resend.com → **Domains → Add Domain** → `mathequete.ca`
2. Resend te donne 3 enregistrements DNS (SPF TXT + DKIM CNAME + DMARC TXT)
3. Cloudflare → mathequete.ca → **DNS → Records → Add record** pour chacun
4. Retour Resend → bouton **Verify** → doit passer au vert

Une fois vert, teste un envoi :
```bash
curl -X POST https://mathequete-api.<account>.workers.dev/api/test-email \
  -H "Content-Type: application/json" \
  -d '{"to":"jegra45@hotmail.com"}'
```

## 9. Test E2E paiement réel (mode TEST)

Avant de passer en `sk_live`, fais un essai avec `sk_test_xxx` :

1. Remplace temporairement `STRIPE_SECRET_KEY` par la clé `sk_test_xxx`
2. Crée une session :
   ```bash
   curl -X POST https://mathequete-api.<account>.workers.dev/api/stripe/create-session \
     -H "Content-Type: application/json" \
     -d '{"tier":"classe_petite","email":"jegra45@hotmail.com"}'
   ```
3. Ouvre l'URL retournée → paie avec `4242 4242 4242 4242` / CVC `123` / date future
4. Vérifie :
   - Stripe Dashboard mode test → Payments → succeeded
   - Boîte mail jegra45@hotmail.com → email Resend avec code MQLIC
   - Le code s'active dans Godot

Si OK → remets `sk_live_xxx` et **re-déploie**.

## 10. Checklist finale avant Play Store

- [ ] `wrangler secret list` montre 4 secrets : HMAC_SECRET_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY
- [ ] `curl https://mathequete.ca/api/health` → 200
- [ ] Stripe webhook envoie test event → 200
- [ ] Email Resend vérifié vert
- [ ] Test paiement E2E (mode test) → code MQLIC reçu par email → activé dans Godot
- [ ] `~/prod_hmac.key` sauvegardé dans coffre (1Password) ET déposé dans Godot user data

---

## Commandes utiles au quotidien

```bash
# Voir les logs en temps réel
wrangler tail

# Reset complet de la base (DANGER)
wrangler d1 execute mathequete-db --remote --command "DROP TABLE licences; DROP TABLE achats;"
wrangler d1 execute mathequete-db --file=schema.sql --remote

# Re-déploiement
wrangler deploy

# Lister tous les déploiements
wrangler deployments list

# Rollback rapide
wrangler rollback
```

## Coût mensuel attendu (premiers 1000 utilisateurs)

| Service | Quota gratuit | Coût après |
|---|---|---|
| Cloudflare Worker | 100k req/jour | 0 $ |
| Cloudflare D1 | 5M lectures/jour, 100k écritures/jour | 0 $ |
| Stripe | 0 $/mois | 2.9 % + 30 ¢ par transaction |
| Resend | 100 emails/jour, 3000/mois | 0 $ jusqu'à 3000 |
| Cloudflare DNS | Illimité | 0 $ |
| Domaine mathequete.ca | — | ~15 $/an (OVH/GoDaddy) |

**Total fixe : ~1.25 $ CAD/mois (domaine seul)** jusqu'à dépassement des quotas.
