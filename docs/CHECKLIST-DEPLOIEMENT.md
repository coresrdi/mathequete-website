# Checklist de déploiement Mathéquête — Sprint S2-S3

À cocher dans l'ordre. Cases ☐ deviennent ☑ une fois faites.

## Phase 1 — Comptes externes (manuel, ~30 min)

- ☐ Créer compte Stripe (mode test) — [STRIPE-SETUP.md](STRIPE-SETUP.md) §1
- ☐ Créer compte Cloudflare — [CLOUDFLARE-SETUP.md](CLOUDFLARE-SETUP.md) §1
- ☐ Créer compte Resend — [RESEND-SETUP.md](RESEND-SETUP.md) §1
- ☐ Acheter domaine `mathequete.com` chez Cloudflare Registrar — [DOMAIN-SETUP.md](DOMAIN-SETUP.md) §1
- ☐ Créer repo `coresrdi/mathequete-website` sur GitHub
- ☐ Push initial du code (depuis `/tmp/mathequete-website`) vers le repo

## Phase 2 — Worker Cloudflare (~30 min)

- ☐ `cd worker && npm install`
- ☐ `npx wrangler login`
- ☐ `npx wrangler d1 create mathequete-db` → copier `database_id` dans `wrangler.toml`
- ☐ `npx wrangler d1 execute mathequete-db --file=schema.sql --remote`
- ☐ Générer clé HMAC : `openssl rand -hex 32` → conserver dans gestionnaire mdp
- ☐ `npx wrangler secret put HMAC_SECRET_KEY`
- ☐ `npx wrangler secret put STRIPE_SECRET_KEY` (clé test `sk_test_...`)
- ☐ `npx wrangler secret put RESEND_API_KEY`
- ☐ `npx wrangler deploy`
- ☐ Vérifier `/health` → retourne `{"status":"ok"}`

## Phase 3 — Stripe (~20 min)

- ☐ Récupérer `pk_test_...` → mettre dans `achat.html` ligne 198
- ☐ Configurer webhook : `https://mathequete-api.XXX.workers.dev/stripe-webhook`
  - Événement : `checkout.session.completed` uniquement
- ☐ Récupérer `whsec_...` → `npx wrangler secret put STRIPE_WEBHOOK_SECRET`
- ☐ Activer Stripe Tax → ajouter juridiction Québec (TPS 5 %, TVQ 9,975 %)

## Phase 4 — Domaine + emails (~1h, dont ~30 min d'attente DNS)

- ☐ DNS Cloudflare : ajouter CNAME `@` et `www` vers `coresrdi.github.io`
- ☐ GitHub Pages : Settings → Pages → Custom domain `mathequete.com`
- ☐ Créer fichier `CNAME` à la racine du repo
- ☐ Activer **Enforce HTTPS** sur GitHub Pages
- ☐ Resend : ajouter `mathequete.com` → vérifier (SPF/DKIM/DMARC)
- ☐ Cloudflare Email Routing : route `contact@mathequete.com → jegra45@hotmail.com`
- ☐ Test envoi Resend depuis curl
- ☐ Test réception sur `contact@mathequete.com`

## Phase 5 — Worker domaine custom (~10 min)

- ☐ Dashboard Cloudflare → Workers → `mathequete-api` → Triggers → Add custom domain `api.mathequete.com`
- ☐ Décommenter `routes = [...]` dans `wrangler.toml` puis redéployer
- ☐ Dans `achat.html` : `API_URL = 'https://api.mathequete.com'`
- ☐ Test `curl https://api.mathequete.com/health`

## Phase 6 — Test end-to-end Sandbox (~15 min)

- ☐ Ouvrir https://mathequete.com/achat.html
- ☐ Cliquer "Acheter — 35 $" (Classe Petite)
- ☐ Carte test : `4242 4242 4242 4242` / `12/30` / `123` / `G1H 1A1`
- ☐ Vérifier redirection sur `/merci.html`
- ☐ Vérifier réception email avec code `MQ-CLAS-XXXX-XXXX-XXXX-XXXX`
- ☐ Tester le CSV en pièce jointe
- ☐ Vérifier en D1 :
  ```bash
  npx wrangler d1 execute mathequete-db --remote --command "SELECT * FROM licences"
  ```
- ☐ Tester l'activation dans Godot (Phase 3 Sprint S4+)

## Phase 7 — Codes promo offline (~5 min)

- ☐ Exporter localement la même clé HMAC :
  ```bash
  export MATHEQUETE_HMAC_KEY="<la clé hex 64 chars>"
  ```
- ☐ Tester génération CLI :
  ```bash
  python3 tools/generate_license.py essai --email "test@gmail.com" --nom "Démo"
  ```
- ☐ Copier le `code_brut` → vérifier dans le Worker :
  ```bash
  curl -X POST https://api.mathequete.com/verify-license \
    -H 'Content-Type: application/json' \
    -d '{"code_brut":"MQLIC:v1:ESSAI:..."}'
  # → {"valide":true,"data":{...}}
  ```

## Phase 8 — Passage en production (après validation complète test)

- ☐ Compléter le profil Stripe (compte bancaire, ID, etc.)
- ☐ Activer le mode **Live** Stripe
- ☐ Récupérer `pk_live_...` et `sk_live_...`
- ☐ Reconfigurer le webhook en mode Live
- ☐ Mettre à jour `achat.html` et secrets Cloudflare
- ☐ Premier achat réel test (1 $ remboursable) avec votre propre carte
- ☐ Annoncer (réseaux sociaux, prospects, etc.)

---

## Résumé des coûts (1ʳᵉ année)

| Poste | Coût annuel |
|-------|-------------|
| Domaine `mathequete.com` | ~13 $ CAD |
| GitHub Pages | 0 $ |
| Cloudflare Workers + D1 | 0 $ (sous 100k requêtes/jour) |
| Resend (3000 emails/mois) | 0 $ |
| Stripe | 0 $ fixe (2,9 % + 0,30 $/transaction) |
| **Total fixe** | **~13 $ CAD/an** |

À chaque vente Classe Petite (35 $) : ~33,68 $ net après frais Stripe.
À chaque vente Grande École (650 $) : ~630,85 $ net après frais Stripe.
