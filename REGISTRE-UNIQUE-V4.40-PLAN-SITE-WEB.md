# REGISTRE UNIQUE v4.40 — DEC-68 Plan Sprint Site Web

> **RÈGLE IMPÉRATIVE** : À chaque commit, inscrire l'entrée dans le **Journal des commits** avant de clore le PR.

---

## Journal des commits

### [DONE — COMMIT 1 — 2026-05-22]
**P0 — Backbone JSON + Loader (aucune page HTML modifiée)**
- ✅ `site/data/prices.json` — Source unique vérité prix v4.40
- ✅ `site/data/site_config.json` — FAQ, politiques, URLs, Kickstarter, règles permanentes
- ✅ `site/data/continents.json` — 5 continents, statuts, badges, couleurs, CTAs
- ✅ `site/data/support_tree.json` — Arbre support (stub minimal, à compléter P3)
- ✅ `site/js/continents-loader.js` — Chargeur réutilisable multi-mode, styles auto-injectés

### [DONE — COMMIT 2 — 2026-05-22]
**P1 — Corrections visibles + retrait dates plateformes**
- ✅ `site/support.html` — Hors-ligne corrigé : 30j → **40 jours** ; transfert clarifié : **1 seul / 12 mois**
- ✅ `site/applications.html` — iOS et Windows : "Sortie prévue 2026" → **"Sortie à confirmer — aucune date annoncée"** ; FAQ hors-ligne 40j + FAQ transfert 12 mois ajoutés

### [DONE — SPRINT S3 — 2026-05-22]
**Bascule Stripe prod + déploiement Cloudflare Pages**
- ✅ Mode live Stripe activé (barre noire dashboard)
- ✅ 10 produits créés en mode live (6 paliers école + 4 licences famille v4.40)
- ✅ Webhook live configuré → `https://mathequete-api.coresrdi.workers.dev/stripe-webhook` ; événement : `checkout.session.completed`
- ✅ Clés live poussées au Worker via `wrangler secret put`
- ✅ 6 secrets Worker confirmés : `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `HMAC_SECRET_KEY`, `ADMIN_API_TOKEN`, `MASTER_ENCRYPTION_KEY`
- ✅ Worker `/health` → 200 OK en production
- ✅ Cloudflare Pages branché sur `coresrdi/mathequete-website` (auto-deploy actif)
- ⚠️ `RESEND_FROM_EMAIL = onboarding@resend.dev` — à remplacer par `licences@mathequete.ca` après vérification domaine Resend
- ⏳ Stripe Tax (TPS 5% + TVQ 9,975% Québec) — à activer dashboard Stripe → Tax
- ⏳ Test achat réel 4,99 CAD + validation email `MQ-CONT-...` — à exécuter

### [DONE — COMMIT 3 — 2026-05-22]
**P1 — achat.html : corrections prix, SKU, bandeau continents, wording**
- ✅ `site/achat.html` — Bandeau continents Kickstarter
- ✅ `site/achat.html` — `defer` ajouté sur `checkout.js` (fix Alpine race condition)
- ✅ `site/achat.html` — SKU école alignés : `petite_ecole` (canonique Stripe)
- ✅ `site/achat.html` — Noms paliers alignés sur `prices.json`
- ✅ `site/data/prices.json` — `ecole_petite` → `petite_ecole`
- ✅ `site/data/prices.json` — IDs individuels alignés sur SKU Stripe

### [DONE — COMMIT 4 — 2026-05-22]
**P1 — applications.html : Windows disponible, politique licences, transfert corrigé**
- ✅ `site/applications.html` — Windows : `badge-bientot` → `badge-disponible`
- ✅ `site/applications.html` — Bouton Windows : placeholder `#` + `<!-- TODO : remplacer -->`
- ✅ `site/applications.html` — Bloc "Deux façons d'activer votre licence" (Google Play vs Stripe)
- ✅ `site/applications.html` — Popup notif Windows supprimée
- ✅ `site/applications.html` — FAQ #2 transfert : annuelles non transférables, permanentes 1×/12 mois
- ✅ `site/applications.html` — Mention iOS "aucun frais supplémentaire" retirée

### [DONE — COMMIT 5 — 2026-05-22]
**P1 — enseignants.html : politique licences R-LICENCES + Mac/Linux sans calendrier**
- ✅ `site/enseignants.html` — FAQ #2 alignée sur R-LICENCES :
  - Licences Stripe = activables sur tout appareil compatible, transférables 1×/12 mois
  - Licences Google Play = liées au compte Google, Android seulement
- ✅ `site/enseignants.html` — Mac/Linux : "sont à l'étude" → **"Aucun calendrier n'est annoncé pour ces plateformes"**
- 🔒 **Non touché (intentionnel)** : section app prof Windows (en finalisation), étape Préparation, FAQ #5 — à débloquer quand l'app prof sera livrée

### [TODO — à faire — applications.html]
- ⏳ **Remplacer le lien `#` Windows** par l'URL définitive MS Store ou téléchargement direct.
  Fichier : `site/applications.html` — chercher `<!-- TODO : remplacer # par le lien MS Store -->`

### [TODO — à faire — enseignants.html]
- ⏳ **App prof Windows livrée** → mettre à jour 3 endroits :
  1. Section *"Téléchargement de l'application Windows"* : remplacer bouton *"M'aviser par courriel"* par lien de téléchargement réel
  2. Étape *"Préparation"* dans *"Comment ça se passe en classe"* : ajouter lien de téléchargement
  3. FAQ #5 : ajouter lien de téléchargement Windows

---

## Objet

Le sprint site web couvre la correction des informations publiques sur `mathequete.pages.dev` et la préparation d'une architecture durable pour les autres continents, les pages produit, la FAQ centralisée et les futurs flux Kickstarter.

## Corrections de vérité appliquées

| Ancienne information | Nouvelle vérité v4.40 |
|---|---|
| Licence individuelle à vie 4,99 $ | Solo annuel : 1,99 $/an — Solo permanent : 9,99 $ à vie |
| Pack 5 permanent à 18,00 $ | Pack 5 annuel : 7,99 $ — Pack 5 permanent : 39,99 $ |
| Tarification école par élève | Paliers fixes : 35 $, 98 $, 265 $, 393 $, 650 $, 716 $ |
| Fenêtre de transfert 6 mois | Une seule fenêtre de 12 mois, un seul transfert maximum |
| Steam non envisagé | Steam et Epic : futur sprint, mécanismes natifs |
| Microsoft Store canal payant | MS Store = distribution gratuite seulement, redirection web |
| Licences Google Play = multiplateformes | Google Play = lié au compte Google (Android seulement) ; Stripe = code QR multiplateforme |
| Mac/Linux "sont à l'étude" | Aucun calendrier annoncé pour ces plateformes |

## Fichiers à créer

| Fichier | But | Statut |
|---|---|---|
| `site/data/prices.json` | Source unique vérité prix | ✅ COMMIT 1 |
| `site/data/site_config.json` | FAQ, politiques, URLs | ✅ COMMIT 1 |
| `site/data/continents.json` | Continents, statuts, badges | ✅ COMMIT 1 |
| `site/data/support_tree.json` | Arbre support (stub) | ✅ COMMIT 1 |
| `site/js/continents-loader.js` | Chargeur cartes continent | ✅ COMMIT 1 |
| `site/transferer-licence.html` | Page informative transfert | ⏳ COMMIT 6 |
| `site/acheter/[slug].html` | Pages produit par palier | ⏳ COMMIT 7 |

## Fichiers à modifier

| Fichier / zone | Modification | Statut |
|---|---|---|
| `site/support.html` | Hors-ligne 40j, transfert 1×/12 mois | ✅ COMMIT 2 |
| `site/applications.html` | Retrait date iOS, Windows disponible, FAQ transfert, politique licences | ✅ COMMIT 4 |
| `site/achat.html` | Bandeau continents, SKU alignés, defer, wording pack 5 | ✅ COMMIT 3 |
| `site/enseignants.html` | Politique licences R-LICENCES, Mac/Linux sans calendrier | ✅ COMMIT 5 |
| `site/support.html` | Arbres décision branchés JSON | ⏳ COMMIT 6 |
| Accueil | Refonte multi-continents, loader branché | ⏳ COMMIT 7 |
| Outils enseignants / Guide École | Fusion Espace Enseignant | ⏳ COMMIT 7 |

## Priorités d'exécution

### P0 — architecture ✅ COMMIT 1 COMPLÉTÉ
1. ✅ Créer `prices.json`
2. ✅ Créer `site_config.json`
3. ✅ Créer `continents.json`
4. ✅ Créer `continents-loader.js`
5. ✅ Rebrancher les pages HTML vers les JSON

### P1 — corrections visibles ✅ COMMITS 2–5 COMPLÉTÉS
1. ✅ Corriger FAQ hors-ligne à 40 jours
2. ✅ Corriger politique de transfert (1 seul, 12 mois)
3. ✅ Retirer toute date iOS/Windows
4. ✅ Corriger tous les prix publics, séparer Annuel/Permanent
5. ✅ Windows disponible + politique licences Google Play vs Stripe
6. ✅ enseignants.html : R-LICENCES + Mac/Linux sans calendrier
7. ⏳ Créer `/transferer-licence` — COMMIT 6

### P1-BIS — infrastructure prod ✅ SPRINT S3 COMPLÉTÉ
1. ✅ Stripe Live — secrets + webhook + produits
2. ✅ Cloudflare Pages — auto-deploy branché
3. ✅ Worker prod — health OK
4. ⏳ Stripe Tax Québec — à activer dashboard
5. ⏳ Test achat réel + email licence

### P2 — refonte fonctionnelle ⏳ COMMITS 6–7
1. Accueil multi-continents avec continents-loader.js
2. Fusion Espace Enseignant
3. Pages produit par palier
4. Page `/transferer-licence`

### P3 — extensions marketing ⏳ COMMIT 8
1. Arbre support interactif via support_tree.json
2. CTA Kickstarter sur placeholders continents

## Règles permanentes

- **R-SOURCE-VÉRITÉ** : Aucune page HTML ne hardcode des prix, durées ou politiques. Toujours lire depuis `prices.json` et `site_config.json`.
- **R-STORE-NATIF** : Plateforme avec store natif → flux natif. MS Store = exception (gratuit + redirection web).
- **R-REGISTRE** : À chaque commit, inscrire `[DONE — COMMIT N — DATE]` dans ce fichier avant de clore le PR.
- **R-LICENCES** : Licences Google Play = liées au compte Google, Android seulement. Licences Stripe = code QR, activables sur tout appareil compatible, transférables 1×/12 mois. Ne jamais promettre la compatibilité multiplateforme Google Play.
- **R-DATES** : Aucune date de sortie (iOS, macOS, app prof, Linux) ne doit être annoncée sur le site sans confirmation explicite. Toujours utiliser "aucune date annoncée" ou "aucun calendrier annoncé".

## Mini plan de test

1. Aucune page n'affiche encore 4,99 $, 18,00 $ ou les anciens paliers école
2. FAQ, Acheter et Accueil affichent les mêmes durées et politiques via les JSON centraux
3. `/transferer-licence` explique le transfert unique sur 12 mois sans contredire le registre
4. Paywall MS Store ouvre bien le site web, sans achat in-app local
5. Continents placeholder ont un visuel distinct et un message Kickstarter cohérent
6. Test achat réel 4,99 CAD → email `MQ-CONT-...` reçu en < 2 min → code actif dans l'app Android
7. `applications.html` — lien Windows remplacé avant go-live
8. `enseignants.html` — 3 occurrences app prof Windows mises à jour quand livrée
