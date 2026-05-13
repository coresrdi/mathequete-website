# Configuration Resend — Email transactionnel (DEC-34)

## 1. Créer le compte

https://resend.com/signup (gratuit jusqu'à 3000 emails/mois)

## 2. Vérifier le domaine `mathequete.com`

Resend exige un domaine vérifié pour envoyer depuis `contact@mathequete.com`.

Dashboard → **Domains** → **Add Domain** :
1. Saisir `mathequete.com`
2. Resend affiche 3-4 records DNS à créer (SPF, DKIM, DMARC)
3. Dashboard Cloudflare → DNS → Ajouter les records
4. Retourner sur Resend → **Verify Domain** (peut prendre 5-30 min)

## 3. Créer la clé API

Dashboard → **API Keys** → **Create API Key** :
- Nom : `mathequete-worker-prod`
- Permissions : **Sending access** (suffit pour envoi transactionnel)
- Copier la clé `re_XXXX` (visible une seule fois)

## 4. Pousser dans Cloudflare

```bash
cd worker
npx wrangler secret put RESEND_API_KEY
# (coller la clé re_XXXX)
```

## 5. Test d'envoi

```bash
curl -X POST 'https://api.resend.com/emails' \
  -H 'Authorization: Bearer re_XXXX' \
  -H 'Content-Type: application/json' \
  -d '{
    "from": "Mathéquête <contact@mathequete.com>",
    "to": ["VOTRE_EMAIL@gmail.com"],
    "subject": "Test Mathéquête",
    "html": "<p>Si vous lisez ceci, Resend fonctionne.</p>"
  }'
```

## 6. Quotas et tarifs

| Plan | Prix | Emails/mois |
|------|------|-------------|
| Free | 0 $ | 3 000 |
| Pro  | 20 $/mois | 50 000 |

Pour Mathéquête (estimation 1ʳᵉ année) :
- Ventes : ~10-50/mois × 1 email = 10-50/mois
- Essais + promos : ~50/mois
- Total : << 200/mois → **gratuit**

## 7. Audit envois

Tous les envois sont loggés dans `emails_envoyes` (D1) avec le `resend_id`.
Pour debug : `npx wrangler d1 execute mathequete-db --remote --command "SELECT * FROM emails_envoyes ORDER BY envoye_le DESC LIMIT 10"`
