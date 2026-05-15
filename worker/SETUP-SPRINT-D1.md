# Sprint D1 — Setup app prof (auth + chiffrement)

> **Date** : 14 mai 2026
> **Statut** : Backend prêt. Tests crypto OK (91/91 incluant vecteurs RFC 6238).
> **Prochain** : Sprint D2 (app Tauri shell + UI).

---

## Ce qui a été ajouté

### Nouveaux fichiers
- `worker/migrations/0005_prof_auth_eleves_chiffres.sql` — 6 nouvelles tables.
- `worker/src/crypto-prof.ts` — primitives Web Crypto (zéro dépendance npm).
- `worker/src/auth-prof.ts` — helpers métier DB + validation.
- `worker/src/prof-routes.ts` — 10 endpoints HTTP `/api/prof/*`.
- `worker/test-crypto.mjs` — suite de tests auto-validants (Node 20+).
- `worker/tsconfig.test.json` — config TS pour tests.

### Fichiers modifiés
- `worker/src/types.ts` — ajout `MASTER_ENCRYPTION_KEY` à `Env`.
- `worker/src/email.ts` — ajout `envoyerEmail()` générique.
- `worker/src/index.ts` — branchement des 10 nouvelles routes.
- `.gitignore` — exclut `worker/dist-test/`.

---

## Architecture cryptographique

```
┌─────────────────────────────────────────────────────────┐
│  MASTER_ENCRYPTION_KEY  (Cloudflare secret, 32 octets) │
│  = KEK (Key Encryption Key) globale                     │
└────────────────┬────────────────────────────────────────┘
                 │ AES-256-GCM chiffre
                 ▼
        ┌──────────────────────────────────────┐
        │  DEK par prof (32 octets)            │
        │  Stockée dans profs.dek_chiffree     │
        │  Générée au signup, jamais en clair  │
        └────────┬─────────────────────────────┘
                 │ AES-256-GCM chiffre
                 ▼
   ┌────────────────────────────────────────┐
   │  PII enfant (prénom, nom, stats JSON)  │
   │  Stockée dans eleves_chiffres.*_chiffre│
   └────────────────────────────────────────┘
```

**Suppression compte prof** = effacement de `dek_chiffree` →
les données élèves deviennent **cryptographiquement irrécupérables**
(effacement cryptographique, équivalent légal de la destruction).

**Algorithmes :**
- Password : PBKDF2-SHA512, 600 000 itérations (OWASP 2023)
- Chiffrement : AES-256-GCM, IV 96 bits aléatoires par opération
- JWT : HS256 (HMAC-SHA256), réutilise `HMAC_SECRET_KEY` existant
- TOTP : RFC 6238, SHA-1, 6 chiffres, 30s, tolérance ±1 fenêtre
- Tokens : SHA-256 hash en DB (refresh tokens, magic links, codes 2FA)

---

## Étapes de déploiement (à faire côté Windows)

### 1. Générer la `MASTER_ENCRYPTION_KEY`

```powershell
# Génère 32 octets hex aléatoires
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Note la clé dans un endroit sûr (1Password, Bitwarden, KeePass).
**⚠️ Si tu la perds, toutes les données chiffrées (élèves, secrets TOTP)
deviennent irrécupérables.** Fais une copie sur papier ou USB chiffré.

### 2. Pousser la clé comme secret Cloudflare

```powershell
cd worker
npx wrangler secret put MASTER_ENCRYPTION_KEY
# Colle la clé hex de 64 caractères, puis Entrée
```

Vérifie : `npx wrangler secret list` → doit lister
`MASTER_ENCRYPTION_KEY` parmi les secrets.

### 3. Exécuter la migration sur D1

```powershell
cd worker
# Production
npx wrangler d1 execute mathequete-db --remote --file=migrations/0005_prof_auth_eleves_chiffres.sql

# Vérifie les tables créées
npx wrangler d1 execute mathequete-db --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'prof%' OR name = 'eleves_chiffres'"
```

Tables attendues : `profs`, `prof_sessions`, `prof_magic_links`,
`prof_2fa_tokens`, `eleves_chiffres`, `prof_audit_log`.

### 4. Déployer le worker

```powershell
cd worker
npx wrangler deploy
```

### 5. Smoke test (manuel ou via curl)

```bash
# Test santé
curl https://mathequete-api.coresrdi.workers.dev/health

# Test signup (remplace par un vrai courriel jetable)
curl -X POST https://mathequete-api.coresrdi.workers.dev/api/prof/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email":"test@example.com",
    "password":"MonMotDePasseSolide2026!",
    "nom_affiche":"Test Prof",
    "nom_ecole":"École Test",
    "ville":"Québec",
    "consentement_parental_atteste":true,
    "cgu_acceptees":true
  }'
```

Réponse attendue : `{"ok":true,"message":"...","code_classe":"QC-2026-XXXX"}`
puis un courriel de confirmation Resend.

---

## Endpoints disponibles

| Méthode | Route | Auth | Description |
|---|---|---|---|
| POST | `/api/prof/signup` | Aucune | Création compte → courriel confirmation |
| POST | `/api/prof/signup/confirm` | Aucune | Confirmation via magic link |
| POST | `/api/prof/login` | Aucune | Email+pwd → JWT pre-2FA |
| POST | `/api/prof/2fa/setup` | JWT pre-2FA | Init TOTP (retourne QR otpauth://) |
| POST | `/api/prof/2fa/setup/confirm` | JWT pre-2FA | Valide TOTP → JWT complet |
| POST | `/api/prof/2fa/email/request` | JWT pre-2FA | Envoie code 6 chiffres par courriel |
| POST | `/api/prof/2fa/verify` | JWT pre-2FA | Vérifie code → JWT complet |
| POST | `/api/prof/token/refresh` | Refresh token | Renouvelle JWT |
| POST | `/api/prof/logout` | (optionnel) | Révoque refresh token |
| GET | `/api/prof/me` | JWT complet | Infos prof connecté |

---

## Tests crypto

```bash
cd worker
node test-crypto.mjs
```

Résultat attendu : **91 OK, 0 KO**, incluant les 5 vecteurs RFC 6238
officiels pour TOTP (t=59, 1111111109, 1111111111, 1234567890, 2000000000).

---

## Loi 25 — Conformité Québec

| Exigence | Implémentation |
|---|---|
| Consentement parental | Case obligatoire au signup (`consentement_parental_atteste`) |
| Acceptation politique | Version trackée (`politique_version`) |
| Audit log immuable | Table `prof_audit_log` INSERT-only |
| Chiffrement PII enfant | AES-256-GCM avec DEK par prof |
| Minimisation données | Prénom + nom optionnels, pas de courriel enfant |
| Droit à l'effacement | Effacement cryptographique de la DEK |
| Anti-brute force | Verrouillage 15 min après 5 échecs login |
| 2FA obligatoire | TOTP ou courriel (forcé au premier login) |
| Mots de passe forts | Min 10 chars, anti-blacklist commune |
| Sessions limitées | JWT 8h, refresh 30j, révocables |

---

## Sprint D2 (suivant) — App Tauri

Backend prêt à recevoir les requêtes. Sprint D2 construira :
- Scaffold Tauri + Vite + vanilla TS (pas de framework lourd)
- Écran inscription au 1er lancement (option A choisie)
- Écran "J'ai déjà un compte" → login
- Mode déconnecté pour consultation cache local
- Stockage refresh token dans keychain OS (`tauri-plugin-stronghold`)
- Setup 2FA avec QR code TOTP
- Cache SQLite local chiffré (à confirmer pour D3)

---

## Notes de sécurité

- **Pas d'Argon2 ?** Web Crypto ne le supporte pas nativement. Les libs WASM
  pèsent ~200 KB ce qui explose le bundle worker. PBKDF2-SHA512 600k est
  OWASP-approuvé 2023, équivalent en sécurité pour notre usage.
- **TOTP SHA-1 ?** Standard RFC 6238. Google Authenticator, Authy, Aegis,
  1Password — tous l'utilisent. SHA-256/512 existent mais peu d'apps les
  supportent. SHA-1 dans TOTP est sûr (HMAC, pas signatures).
- **Anti-énumération** : `/signup` et `/login` retournent des erreurs
  génériques pour empêcher de découvrir quels emails sont enregistrés.
- **Rate limiting** : à configurer dans le **dashboard Cloudflare**
  (Rules → Rate Limiting Rules) sur `/api/prof/*` :
  - login/signup : 5 req / min / IP
  - magic link : 3 req / min / IP
- **Rotation MASTER_KEY** : prévue via `dek_version`. Procédure dans un
  futur runbook si besoin (pas urgent en Sprint D1).
