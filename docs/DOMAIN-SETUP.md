# Achat et configuration du domaine `mathequete.com`

## 1. Acheter le domaine

**Option recommandée** : Cloudflare Registrar (DEC-32)
- Pas de markup sur le prix de gros (~12-15 $ CAD/an)
- DNS Cloudflare inclus automatiquement
- WHOIS privacy gratuit
- Pas de tentatives d'upsell

Étapes :
1. https://dash.cloudflare.com → **Domain Registration → Register Domains**
2. Chercher `mathequete.com`
3. Si dispo : ajouter au panier (~13 $ CAD/an) + paiement
4. Si pris : essayer `mathequete.ca`, `mathequete.app`, `jeumath.com`, etc.

**Alternatives valables** : Namecheap, Porkbun. Éviter GoDaddy (upsell agressif, renouvellement 2× plus cher).

## 2. Configuration DNS

Une fois le domaine acheté chez Cloudflare, la zone DNS est automatique. Ajouter :

| Type | Nom | Valeur | Proxy |
|------|-----|--------|-------|
| CNAME | `@` (apex) | `coresrdi.github.io` | Activé (orange cloud) |
| CNAME | `www` | `coresrdi.github.io` | Activé |
| CNAME | `api` | (créé auto par Worker custom domain) | Activé |
| MX | `@` | `feedback-smtp.us-east-1.amazonses.com` (Resend) | Désactivé |
| TXT | `@` | `v=spf1 include:_spf.resend.com ~all` | — |
| TXT | `resend._domainkey` | (fourni par Resend) | — |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:contact@mathequete.com` | — |

## 3. Activer GitHub Pages avec domaine custom

Repo `coresrdi/mathequete-website` :

1. **Settings → Pages** :
   - Source : `Deploy from branch`
   - Branch : `main` / root
   - Save
2. **Custom domain** : saisir `mathequete.com` → Save
3. Cocher **Enforce HTTPS** (après ~10 min de provisionnement Let's Encrypt)

Créer le fichier `CNAME` à la racine du repo :
```
mathequete.com
```

## 4. Email transactionnel

Pour recevoir `contact@mathequete.com` :
- Resend gère l'**envoi** uniquement
- Pour la **réception** : utiliser **Cloudflare Email Routing** (gratuit)
  - Dashboard Cloudflare → Email → Email Routing
  - Créer route : `contact@mathequete.com → jegra45@hotmail.com`
  - Cloudflare ajoute les MX automatiquement (override SES si conflit, prendre Cloudflare en priorité pour MX, Resend pour SPF/DKIM)

## 5. Tester

```bash
# DNS résolu ?
dig mathequete.com +short
# → IP GitHub Pages

# HTTPS actif ?
curl -I https://mathequete.com

# Envoi mail Resend OK ?
curl -X POST 'https://api.resend.com/emails' -H 'Authorization: Bearer re_XXX' \
  -H 'Content-Type: application/json' \
  -d '{"from":"Mathéquête <contact@mathequete.com>","to":["test@gmail.com"],"subject":"Test","html":"<p>OK</p>"}'

# Réception ?
# Envoyer un email à contact@mathequete.com depuis un autre compte
# → doit arriver dans jegra45@hotmail.com
```

## Coûts annuels totaux

| Service | Coût |
|---------|------|
| Domaine `mathequete.com` (Cloudflare Registrar) | ~13 $ CAD |
| GitHub Pages | 0 $ |
| Cloudflare Workers + D1 | 0 $ (sous quotas) |
| Resend | 0 $ (sous 3000 emails/mois) |
| Stripe | 0 $ fixe (2,9 % + 0,30 $ par vente) |
| **Total fixe** | **~13 $ CAD/an** |
