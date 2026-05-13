# Configuration Stripe — Mathéquête (Sprint S2)

Étapes manuelles à effectuer une seule fois pour activer les paiements Stripe Checkout.

## 1. Créer le compte Stripe

1. Aller sur https://dashboard.stripe.com/register
2. Pays : **Canada**
3. Devise par défaut : **CAD**
4. Activer le mode **test** (toggle en haut à gauche du dashboard)

## 2. Récupérer les clés API (mode test)

Dashboard → **Développeurs** → **Clés API** :

| Clé | Où | Utilisation |
|-----|-----|-------------|
| Clé publiable `pk_test_...` | `achat.html` ligne 198 | Frontend Stripe.js |
| Clé secrète `sk_test_...`   | Worker secret           | Création de sessions |

Mettre à jour `achat.html` :
```js
const STRIPE_PUBLIC_KEY = 'pk_test_VOTRE_CLÉ_ICI';
```

Pousser la clé secrète dans Cloudflare Worker :
```bash
cd worker
npx wrangler secret put STRIPE_SECRET_KEY
# (coller la valeur sk_test_...)
```

## 3. Configurer le webhook

Dashboard → **Développeurs** → **Webhooks** → **Ajouter un point de terminaison** :

- URL : `https://api.mathequete.com/stripe-webhook`
  (en dev local : utiliser [Stripe CLI](https://stripe.com/docs/stripe-cli) avec `stripe listen --forward-to localhost:8787/stripe-webhook`)
- Événements à écouter : **`checkout.session.completed`** uniquement
- Récupérer le **Signing secret** `whsec_...`

Pousser dans Cloudflare :
```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET
# (coller la valeur whsec_...)
```

## 4. Activer la taxe automatique (Stripe Tax)

Dashboard → **Paramètres** → **Stripe Tax** :

1. Activer Stripe Tax (gratuit en mode test, payant en prod après seuils)
2. Ajouter une juridiction : **Canada → Québec**
3. Renseigner numéros TPS (5 %) et TVQ (9,975 %) une fois la compagnie enregistrée
4. Dans le code Worker (`stripe-webhook.ts` ligne ~178) : `automatic_tax: { enabled: true }` est déjà activé

**Note** : Tant que la compagnie n'est pas enregistrée à Revenu Québec et à l'ARC, les taxes seront calculées par Stripe mais c'est CORES RDI qui doit les remettre. À discuter avec un comptable avant le passage en prod.

## 5. Tester en mode test

Carte de test Stripe (toujours acceptée en sandbox) :
```
Numéro     : 4242 4242 4242 4242
Expiration : n'importe quelle date future (ex: 12/30)
CVC        : n'importe quel 3 chiffres (ex: 123)
ZIP        : n'importe quoi (ex: G1H 1A1)
```

Flow de test complet :
1. Ouvrir `https://mathequete.com/achat.html` (ou `localhost:8000`)
2. Cliquer "Acheter — 35 $" (Classe Petite)
3. Saisir la carte test
4. Stripe redirige vers `/merci.html`
5. Cloudflare Worker reçoit le webhook `checkout.session.completed`
6. Génère le code HMAC, insère en D1, envoie email Resend
7. Vérifier la réception du courriel à l'adresse saisie

## 6. Passage en production

Une fois validé en mode test :

1. Compléter le profil de paiement Stripe (vérification d'identité, compte bancaire CAD)
2. Activer le mode **Live** dans le dashboard
3. Récupérer les clés Live `pk_live_...` et `sk_live_...`
4. Mettre à jour `achat.html` et les secrets Cloudflare (avec les clés Live)
5. Reconfigurer le webhook en mode Live (URL et secret différents)
6. Premier achat test avec votre propre carte (1 $ remboursable) pour valider

## Tarifs Stripe (DEC-29)

- Frais carte : **2,9 % + 0,30 $ CAD** par transaction réussie
- Pour Classe Petite à 35 $ : frais ≈ 1,32 $ → revenu net ≈ 33,68 $
- Pour Grande École à 650 $ : frais ≈ 19,15 $ → revenu net ≈ 630,85 $

Aucun frais mensuel, aucun frais fixe. Vous ne payez que sur les ventes réelles.
