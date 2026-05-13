# Configuration Cloudflare — Mathéquête (Sprint S3)

Étapes manuelles pour déployer le Worker API et la base D1.

## 1. Créer un compte Cloudflare

https://dash.cloudflare.com/sign-up (compte gratuit)

## 2. Installer Wrangler CLI

```bash
cd /tmp/mathequete-website/worker
npm install
npx wrangler login
# (ouvre le navigateur pour authentification)
```

## 3. Créer la base D1

```bash
npx wrangler d1 create mathequete-db
```

Sortie attendue :
```
✅ Successfully created DB 'mathequete-db' in region ENAM
Created your database using D1's new storage backend.
[[d1_databases]]
binding = "DB"
database_name = "mathequete-db"
database_id = "abc123-XXXX-XXXX-XXXX"
```

**Reporter le `database_id` dans `worker/wrangler.toml`** (remplacer `REMPLACER_APRES_CREATION_D1`).

## 4. Initialiser le schéma

```bash
# Production (D1 hébergée)
npx wrangler d1 execute mathequete-db --file=schema.sql --remote

# Dev local (SQLite local)
npx wrangler d1 execute mathequete-db --file=schema.sql --local
```

Vérifier :
```bash
npx wrangler d1 execute mathequete-db --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```
Devrait lister : `licences`, `achats`, `codes_actives`, `emails_envoyes`.

## 5. Générer et pousser la clé HMAC

```bash
# Génération unique — à GARDER précieusement (à mettre aussi dans le jeu Godot)
openssl rand -hex 32
# → ex: 3f9b2e1c4d5a3f9b2e1c4d5a3f9b2e1c4d5a3f9b2e1c4d5a3f9b2e1c4d5a3f9b

npx wrangler secret put HMAC_SECRET_KEY
# (coller la valeur)
```

**⚠ IMPORTANT** : Si vous perdez cette clé, TOUS les codes émis deviennent invalides.
Conservez-la dans un gestionnaire de mots de passe (Bitwarden, 1Password) + backup chiffré.

## 6. Pousser les autres secrets

```bash
npx wrangler secret put STRIPE_SECRET_KEY        # sk_test_... ou sk_live_...
npx wrangler secret put STRIPE_WEBHOOK_SECRET    # whsec_...
npx wrangler secret put RESEND_API_KEY            # re_...
```

## 7. Premier déploiement

```bash
npx wrangler deploy
```

Sortie attendue :
```
Published mathequete-api (X.XX sec)
  https://mathequete-api.VOTRE-COMPTE.workers.dev
```

Vérifier que c'est en ligne :
```bash
curl https://mathequete-api.VOTRE-COMPTE.workers.dev/health
# → {"status":"ok","env":"production","ts":...}
```

## 8. Brancher le domaine custom `api.mathequete.com`

Une fois `mathequete.com` acheté chez Cloudflare Registrar (voir DOMAIN-SETUP.md) :

1. Dashboard Cloudflare → **Workers & Pages** → cliquer sur `mathequete-api`
2. **Settings → Triggers → Custom Domains → Add Custom Domain**
3. Saisir `api.mathequete.com` → Cloudflare crée le DNS automatiquement
4. Décommenter dans `wrangler.toml` :
   ```toml
   routes = [
     { pattern = "api.mathequete.com/*", custom_domain = true }
   ]
   ```
5. Redéployer : `npx wrangler deploy`

## 9. Brancher la page achat.html à l'API

Dans `achat.html` :
```js
const API_URL = 'https://api.mathequete.com';
// (ou en dev : 'https://mathequete-api.VOTRE-COMPTE.workers.dev')
```

## 10. Quotas gratuits Cloudflare

| Ressource | Gratuit | Mathéquête typique |
|-----------|---------|---------------------|
| Worker requests | 100 000/jour | Achat + activation ≪ 100/jour la 1ʳᵉ année |
| D1 reads | 5 millions/jour | Idem |
| D1 writes | 100 000/jour | Idem |
| Storage D1 | 5 GB | Schéma fait << 100 MB |

Conclusion : **0 $/mois sur Cloudflare** tant qu'on est sous 100 ventes/jour.

## 11. Commandes utiles

```bash
# Voir les logs en direct
npx wrangler tail

# Lister les secrets configurés
npx wrangler secret list

# Tester localement
npx wrangler dev

# Voir le contenu de la D1
npx wrangler d1 execute mathequete-db --remote --command "SELECT * FROM licences LIMIT 10"

# Rollback à un déploiement précédent
npx wrangler rollback
```
