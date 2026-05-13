# Mathéquête — Site web vitrine + API Licences

Site marketing et système de licences pour **Mathéquête**, jeu mathématique éducatif Godot 4 (Phase 3 – Mode Prof).

## Architecture

```
mathequete-website/
├── index.html                    # Page d'accueil (hero, value props)
├── calculateur.html              # Calculateur de prix dynamique
├── comparaison-prodigy.html      # Page SEO comparative
├── achat.html                    # Boutique Stripe Checkout (5 paliers)
├── merci.html                    # Confirmation post-paiement
├── assets/
│   ├── css/styles.css            # Styles custom (par-dessus Pico.css CDN)
│   ├── js/calculateur.js         # Calcul live (formule DEC-26)
│   └── img/                      # Logos, screenshots, OG images
├── worker/                       # Cloudflare Worker (API)
│   ├── wrangler.toml             # Config Cloudflare
│   ├── package.json
│   ├── tsconfig.json
│   ├── schema.sql                # D1 (SQLite) schema
│   └── src/
│       ├── index.ts              # Router principal
│       ├── stripe-webhook.ts     # Réception checkout.session.completed
│       ├── generate-codes.ts     # HMAC SHA-256 → MQ-CLAS-XXXX
│       └── email.ts              # Envoi Resend (HTML + PDF + CSV)
├── tools/
│   └── generate_license.py       # CLI Python pour codes promo offline
└── docs/
    ├── STRIPE-SETUP.md           # Étapes manuelles compte Stripe
    ├── CLOUDFLARE-SETUP.md       # Étapes manuelles Cloudflare
    └── RESEND-SETUP.md           # Étapes manuelles Resend
```

## Stack technique (DEC-28)

- **Frontend statique** : HTML + Alpine.js (CDN) + Pico.css (CDN)
- **Hosting** : GitHub Pages (gratuit, custom domain `mathequete.com`)
- **API** : Cloudflare Worker (gratuit jusqu'à 100k req/jour)
- **Base de données** : Cloudflare D1 (SQLite serverless, 5 GB gratuits)
- **Paiement** : Stripe Checkout (2.9% + 0,30 $/transaction — DEC-29)
- **Email transactionnel** : Resend (3000 emails/mois gratuits)
- **Génération de codes** : HMAC SHA-256 tronqué 12 hex (DEC-31) — vérifiables offline

## Paliers tarifaires (DEC-26 / §3.3 Plan v3.1)

Formule : `coût = nb_élèves × 0,65 × 1,5108 × facteur_palier`

| Pack | Élèves | Prix CAD/an |
|------|--------|-------------|
| Classe Petite | 30 | 35 $ |
| Classe Moyenne | 100 | 98 $ |
| Petite École | 300 | 265 $ |
| École Standard | 500 | 393 $ |
| Grande École | 1000 | 650 $ |
| Méga École | 1300 | 716 $ |
| Sur-mesure | >1300 | Sur devis |

**Référence concurrent** : Prodigy ≈ 50 $ CAD/élève/an. Mathéquête 1000 élèves = 0,65 $/élève/an = **77× moins cher**.

## Développement local

```bash
# Frontend : serveur HTTP simple
cd /tmp/mathequete-website
python3 -m http.server 8000
# → http://localhost:8000

# Worker : wrangler dev
cd worker
npm install
npx wrangler dev
# → http://localhost:8787
```

## Déploiement

- **Site web** : push sur `main` → GitHub Pages auto-deploy
- **Worker** : `cd worker && npx wrangler deploy`

## Variables d'environnement (Cloudflare secrets)

```bash
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put HMAC_SECRET_KEY    # 32 bytes hex (généré une fois)
```

## Format des codes de licence (DEC-31)

```
Format brut    : MQLIC:v1:TYPE:CONTENT:EXPIRY:SIGNATURE
Format affiché : MQ-CLAS-X7K9-RP2M-8VHD-3NQF
                 ─┬ ─┬── ─────────┬────────── ──┬─
                  │  │            │              └ HMAC 12 hex
                  │  │            └ Payload Base32 (no 0/O/1/I)
                  │  └ Type (CLAS / ECOL / CONT / LIFE / PROM / ESSA)
                  └ Préfixe constant
```

- HMAC SHA-256 tronqué à 12 caractères hex (96 bits — collision résistante)
- Vérification **offline** (jeu Godot embarque la clé publique de vérification)
- Expiration intégrée dans le payload (365 jours pour CLASSE/ECOLE)

## Licence

© 2026 CORES RDI — Tous droits réservés.
