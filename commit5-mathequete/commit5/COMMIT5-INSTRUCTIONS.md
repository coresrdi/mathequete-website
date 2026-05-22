# Commit 5 — Correctifs critiques + Vidéos YouTube
**Date :** 22 mai 2026
**Branche :** main (patch direct)

---

## Fichiers à placer dans le repo

| Fichier dans ce .zip | Destination dans le repo |
|---|---|
| `site/_redirects` | `site/_redirects` ← **NOUVEAU** |
| `site/index.html` | `site/index.html` ← remplace l'existant |
| `site/enseignants.html` | `site/enseignants.html` ← remplace l'existant |
| `site/js/videos-loader.js` | `site/js/videos-loader.js` ← **NOUVEAU** |

---

## Ce que ça corrige

### 🔴 HTTP 500 sur achat, enseignants, transferer-licence
`site/_redirects` — Cloudflare Pages faisait achat.html → /achat (308)
puis cherchait /achat qui n'existe pas → 500.
Maintenant : /achat → /achat.html (301), idem pour toutes les pages.

### 🟡 "Pas d'abonnement" obsolète
`site/index.html` ligne 258 — Remplacé par :
"Deux formules claires : annuelle à 1,99 $/an ou accès permanent à 9,99 $. Pas de microtransactions, pas de surprise."

`site/enseignants.html` ligne 188 — Retiré :
"Pas d'abonnement caché, pas de fonctionnalité « premium » bloquée."
Remplacé par : "Aucune fonctionnalité « premium » bloquée côté enseignant."

### 🎬 Vidéos YouTube (playlist PLO6RTx5X6m1UCxKk00kdZsJ_W07_8gaPW)
`site/js/videos-loader.js` — Nouveau module.
`site/index.html` — Nouvelle section "Voir Mathéquête en action" avec 2 vignettes.

**Comportement vidéo :**
- Survol → miniature mute (autoplay silencieux, délai 180ms)
- Clic → lecteur 640×360 fixe en position (ne suit pas le scroll)
- Son démarre au clic
- Clic fond sombre ou × → ferme
- Echap → ferme

**Vidéos assignées :**
- `bLijXDgYm2U` → Démo cinématique révisions (section hero)
- `v7oa01j_A80` → Pub cinématique 2 (section aventure)
- `sut0bZkPiIw` → Présentation générale (disponible via data-video-context="pro")

Pour ajouter une vidéo sur une autre page :
```html
<div data-video-context="pro"></div>
<script src="js/videos-loader.js"></script>
```

---

## Commandes git
```bash
git add site/_redirects site/index.html site/enseignants.html site/js/videos-loader.js
git commit -m "fix: HTTP 500 redirects + texte abonnement + vidéos YouTube [COMMIT 5]"
git push origin main
```

---

## Entrée REGISTRE à ajouter
`[DONE — COMMIT 5 — 2026-05-22]`
- `site/_redirects` : corrige HTTP 500 sur /achat, /enseignants, /transferer-licence, /applications
- `site/index.html` : retire "Pas d'abonnement", ajoute section vidéo
- `site/enseignants.html` : retire "Pas d'abonnement caché"
- `site/js/videos-loader.js` : système vidéo hover/clic YouTube
