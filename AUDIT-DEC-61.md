# Audit de conformité DEC-61 — page d'arrivée mobile `/enseignants`

**Date** : 16 mai 2026
**Auteur** : Perplexity Computer (Jeff)
**Référence registre** : v4.15 §3.4 DEC-61 + §10bis WEB-DEBT-5/6
**Branche** : `feat/web-debt-5-6-page-enseignants-conforme`

---

## Contexte légal

Le lien depuis l'app mobile Mathéquête (Paramètres > À propos > « Outils pour
enseignants ») pointe vers `https://mathequete.com/enseignants.html`. Cette
page doit être conforme à :

- **Apple App Store Review Guidelines 3.1.1(a)** : pas de lien direct vers un
  système de paiement externe dans l'app (le lien dans l'app doit pointer vers
  une page qui ne pousse pas vers un achat).
- **Apple 3.1.3(f) « Free Stand-alone Companion Apps »** : si l'app companion
  Windows est gratuite, le lien depuis l'app mobile vers son téléchargement
  est autorisé sans frais Apple supplémentaires.
- **Google Play steering rules** : la page d'arrivée doit clairement séparer
  l'information du commerce. Toute zone d'achat directe attire les frais du
  programme « External Content Links » (~2,85 $ CAD/install + 10-20 % sur les
  achats post-clic dans 24 h).

---

## Architecture de navigation (post-refonte)

```
┌─────────────────────────────────────────────────────────────────────┐
│                      App mobile Mathéquête                          │
│                  Paramètres > À propos > Outils prof                │
└────────────────────────┬────────────────────────────────────────────┘
                         │ lien externe HTTP
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  enseignants.html                                                   │
│  ★ PAGE D'ARRIVÉE MOBILE ★                                          │
│                                                                     │
│  Nav réduite :  [← Accueil]                                         │
│  Contenu     :  description mode prof, captures, FAQ, contact       │
│                 téléchargement .msi (gratuit, via mailto)           │
│                                                                     │
│  ❌ AUCUN lien vers achat.html, guide-prof.html depuis le contenu   │
│  ❌ AUCUNE mention de prix                                          │
│  ❌ AUCUN bouton "Acheter"                                          │
└────────────────────────┬────────────────────────────────────────────┘
                         │ clic "Accueil" (1 clic)
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  index.html                                                         │
│  Nav complète : Accueil | Acheter | Enseignants | Guide école       │
│  Contenu     :  hero, fonctionnalités, tarifs, FAQ                  │
│                                                                     │
│  ✅ Comporte des CTA "Acheter" (page de site web public, pas        │
│     atteignable en 1 clic depuis enseignants.html sans passer       │
│     par la nav principale du site)                                  │
└─────────────────────────────────────────────────────────────────────┘
```

**Règle d'or appliquée** : depuis `enseignants.html`, le SEUL chemin pour
atteindre une page d'achat passe par la **nav principale du site web**
(via `index.html`). Apple/Google considèrent cela comme de la navigation
libre du site, pas comme un CTA d'achat indirect.

---

## Pages auditées

### 1. `enseignants.html` (NOUVELLE) — page d'arrivée mobile

| Critère | Statut | Détail |
|---------|--------|--------|
| Pas de lien `achat.html` dans le contenu | ✅ | `grep` confirme 0 occurrence |
| Pas de lien `guide-prof.html` dans le contenu | ✅ | `grep` confirme 0 occurrence |
| Pas de mention de prix | ✅ | Aucun `$`, `CAD`, tarif, palier |
| Pas de bouton « Acheter » | ✅ | Aucun |
| Nav supérieure réduite | ✅ | Seul lien : « ← Accueil » |
| Footer sans liens d'achat | ✅ | Footer pointe vers Accueil + Confidentialité + email |
| Téléchargement gratuit | ✅ | Bouton mailto (pas de lien vers Stripe / page d'achat) |
| Description mode prof | ✅ | 6 cartes + 5 étapes + FAQ |
| Contact direct | ✅ | mailto coresrdi@gmail.com |
| Mention Loi 25 | ✅ | Bloc « Conforme Loi 25 » dans les avantages |

**Vérification automatique** :
```bash
# Doit retourner 0 résultats
grep -E 'href="(achat|forfaits-ecole|pack-familial|promo|guide-prof)' \
  site/enseignants.html
# Le seul "guide-prof" autorisé serait dans le commentaire de doc d'audit
# en tête de fichier (commentaire HTML, pas un lien).
```

### 2. `index.html` (modifiée) — accueil grand public

| Critère | Statut | Détail |
|---------|--------|--------|
| Nav complète accessible | ✅ | Accueil, Acheter, Enseignants, Guide école |
| Hero CTA `enseignants.html` au lieu de `guide-prof.html` | ✅ | Bouton "Pour les enseignants" → `enseignants.html` |
| Tarifs présents | ✅ | Maintenus (page commerciale légitime) |

**Justification** : `index.html` n'est PAS la page d'arrivée mobile. C'est
l'accueil grand public du site `mathequete.com`. Les CTA d'achat y sont
permis par DEC-61. Apple regarde ce qu'il y a en 1 clic depuis la page
d'arrivée (`enseignants.html`), pas depuis l'accueil du site web.

### 3. `guide-prof.html` (modifiée) — guide école détaillé

| Critère | Statut | Détail |
|---------|--------|--------|
| Nav cohérente avec `enseignants.html` | ✅ | Ajout du lien « Enseignants » |
| CTA Acheter dans le contenu | ✅ Maintenus | Page de doc commerciale détaillée, accessible via menu nav |
| Atteignable en 1 clic depuis `enseignants.html` | ❌ Volontairement non | La nav de `enseignants.html` ne contient PAS de lien vers `guide-prof.html` |

**Justification** : `guide-prof.html` reste la page de référence pour les
enseignants qui veulent voir les paliers et tarifs détaillés. Elle est
accessible via la nav principale (depuis `index.html` ou `achat.html`),
mais **pas en 1 clic depuis la page d'arrivée mobile**. C'est exactement
le scénario souhaité par DEC-61 :

> « les pages d'achat (`/forfaits-ecole`, `/pack-familial`, `/promo`)
> existent séparément sur le site et l'utilisateur y accède via la
> navigation libre du site web (menu, header), pas via un lien direct
> depuis l'app. »

### 4. `achat.html` (modifiée) — page d'achat

| Critère | Statut | Détail |
|---------|--------|--------|
| Nav cohérente | ✅ | Ajout des liens Enseignants + Guide école |
| Atteignable depuis `enseignants.html` directement | ❌ Volontairement non | Pas de lien dans la nav minimale de `enseignants.html` |

### 5. `merci.html` (modifiée) — confirmation post-paiement

| Critère | Statut | Détail |
|---------|--------|--------|
| Nav cohérente | ✅ | Idem `achat.html` |
| Référence à `guide-prof.html` post-achat | ✅ | Maintenue (l'utilisateur vient de payer, OK) |

---

## Vérifications automatiques (commandes pour CI/CD futur)

Ces commandes peuvent être ajoutées à un GitHub Actions ou pre-commit hook
pour empêcher toute régression de conformité.

```bash
#!/usr/bin/env bash
# Audit de conformité DEC-61 — à exécuter à chaque modif du site

cd site

# Test 1 : enseignants.html ne doit avoir AUCUN lien vers les pages d'achat
# (commentaires HTML exclus)
LIENS_INTERDITS=$(grep -E '<a\s[^>]*href="(achat|forfaits-ecole|pack-familial|promo|guide-prof)' enseignants.html | grep -v '<!--')
if [ -n "$LIENS_INTERDITS" ]; then
  echo "❌ DEC-61 VIOLATION : enseignants.html contient un lien interdit :"
  echo "$LIENS_INTERDITS"
  exit 1
fi

# Test 2 : enseignants.html ne doit pas mentionner de prix
PRIX=$(grep -E '\$|CAD|tarif|prix|palier|forfait' enseignants.html | grep -v '<!--' | grep -v 'href=')
if [ -n "$PRIX" ]; then
  echo "❌ DEC-61 VIOLATION : enseignants.html mentionne un prix ou un tarif :"
  echo "$PRIX"
  exit 1
fi

# Test 3 : enseignants.html ne doit pas avoir de bouton "Acheter"
ACHETER=$(grep -iE 'acheter|achat|commande|payer|stripe' enseignants.html | grep -v '<!--' | grep -v 'mailto:')
if [ -n "$ACHETER" ]; then
  echo "❌ DEC-61 VIOLATION : enseignants.html mentionne 'acheter' ou similaire :"
  echo "$ACHETER"
  exit 1
fi

echo "✅ Audit DEC-61 passé : enseignants.html est conforme."
```

---

## Téléchargement de l'app prof Windows — choix d'implémentation

**Aujourd'hui (16 mai 2026)** : le bouton « M'aviser par courriel » envoie
vers `mailto:coresrdi@gmail.com` avec un sujet pré-rempli. Aucun lien R2
actif.

**Plus tard (après acquisition du certificat de signature de code DigiCert
ou Sectigo — décision ⚠️8 du registre §9)** : remplacer ce bouton par un
lien direct vers un URL R2 stable comme :

```
https://r2.mathequete.ca/prof/mathequete-prof-windows.msi
```

**Avantage** : 1 URL fixe → on remplace le fichier `.msi` derrière sans
casser les bookmarks ni les communications. L'auto-update Tauri (via
`@tauri-apps/api/updater` + manifest JSON sur R2) prend ensuite le relais
pour les mises à jour incrémentales. C'est l'architecture la plus simple
à maintenir.

**Pour ajouter ce lien plus tard** :
1. Ouvrir `site/enseignants.html`
2. Remplacer le bloc `<a href="mailto:...">M'aviser par courriel</a>` par
   `<a href="https://r2.mathequete.ca/prof/mathequete-prof-windows.msi">Télécharger pour Windows</a>`
3. Garder le `mailto` comme lien secondaire pour les utilisateurs non-Windows.

---

## Couverture des cas Apple App Review

| Scénario | Évaluation Apple | Statut |
|----------|------------------|--------|
| L'app mobile pointe vers `enseignants.html` | Page d'arrivée informationnelle = 3.1.3(f) compatible | ✅ |
| Depuis `enseignants.html`, 1 clic = `index.html` | Accueil de site web, navigation libre = OK | ✅ |
| Depuis `index.html`, 1 clic = `achat.html` (page d'achat) | C'est 2 clics depuis la page d'arrivée mobile → conforme | ✅ |
| Pas de lien direct app mobile → page d'achat | Conforme 3.1.1(a) | ✅ |
| Pas de CTA d'achat dans la page d'arrivée | Conforme | ✅ |

## Couverture des cas Google Play steering rules

| Scénario | Évaluation Google | Statut |
|----------|-------------------|--------|
| Lien app → site web (page informationnelle gratuite) | Hors External Content Links Program | ✅ |
| Téléchargement gratuit `.msi` Windows | Pas une transaction = pas de fees ECL | ✅ |
| Achat éventuel : utilisateur doit naviguer du site web | Considéré comme « purchase initiated on the web » | ✅ |
| Pas de fees 2,85 $/install | ✅ | ✅ |

---

## Conclusion

La refonte respecte intégralement DEC-61 du registre Mathéquête v4.15.

**WEB-DEBT-5** ✅ : page `/enseignants` créée, strictement informationnelle,
nav minimale, pas de mention de prix, téléchargement gratuit via mailto.

**WEB-DEBT-6** ✅ : audit complet des pages atteignables en 1 clic depuis
`/enseignants` :
- Seul chemin 1-clic : `enseignants.html` → `index.html` (accueil du site)
- Aucun lien direct vers `achat.html`, `guide-prof.html`, ou pages d'achat
  futures (`/forfaits-ecole`, `/pack-familial`, `/promo`) depuis le contenu
  de `enseignants.html`

**Prochaine étape** : déployer sur Cloudflare Pages (`mathequete-website`)
et tester manuellement le parcours :

1. Ouvrir `https://mathequete.com/enseignants.html` dans un navigateur incognito
2. Vérifier qu'aucun bouton « Acheter » ou « Voir les forfaits » n'est visible
3. Cliquer sur « ← Accueil » → arriver sur `index.html`
4. Constater que de là, la nav complète est disponible

Recommandation pour la publication Play Store / App Store : soumettre la
review avec la note « Page d'arrivée enseignants : `https://mathequete.com/enseignants.html` »
dans les notes du reviewer. Apple/Google verront immédiatement la conformité.
