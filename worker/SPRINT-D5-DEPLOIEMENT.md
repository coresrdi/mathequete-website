# Sprint D5 — Déploiement production

## Vue d'ensemble

Sprint D5 ajoute 3 protections à la production :

1. **Chiffrement at-rest des stats élèves** (`payload_json` → `payload_chiffre` AES-GCM)
2. **Rate limiting** sur endpoints sensibles (login, 2FA, signup, dek/upgrade, stats/push, activation)
3. **Validation de la clé HMAC prod** (vérifier qu'elle est forte et non publique)

---

## Étape 1 — Appliquer les migrations

**Migration 0008** : ajoute colonnes `payload_chiffre`, `payload_iv`, `payload_kdf` à `stats_eleves`.

**Migration 0009** : crée la table `rate_limit_buckets` (clé, compteur, fenêtre).

```powershell
# Depuis C:\mathequete\mathequete-website\worker
cd C:\mathequete\mathequete-website\worker

git pull origin main

# Appliquer migration 0008
npx wrangler d1 execute mathequete-db --remote --file=migrations/0008_stats_payload_chiffre.sql

# Appliquer migration 0009
npx wrangler d1 execute mathequete-db --remote --file=migrations/0009_rate_limit.sql

# Vérifier
npx wrangler d1 execute mathequete-db --remote --command="PRAGMA table_info(stats_eleves);"
npx wrangler d1 execute mathequete-db --remote --command="PRAGMA table_info(rate_limit_buckets);"
```

Tu dois voir :
- `stats_eleves` avec `payload_chiffre`, `payload_iv`, `payload_kdf`
- `rate_limit_buckets` avec `key`, `count`, `window_start`, `updated_at`

---

## Étape 2 — Vérifier / renforcer HMAC_SECRET_KEY

`HMAC_SECRET_KEY` signe les codes de licence. Si la clé prod est faible ou publique,
tout l'écosystème licences est compromis.

### Vérifier la valeur actuelle

Cloudflare **ne permet pas** de lire les secrets une fois posés, mais tu peux vérifier
qu'ils existent :

```powershell
npx wrangler secret list
```

Tu dois voir au minimum :
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `HMAC_SECRET_KEY`
- `MASTER_ENCRYPTION_KEY`

### Si la clé HMAC actuelle est faible ou tu n'es pas sûr

**Important** : changer `HMAC_SECRET_KEY` **invalide tous les codes existants**.
Pour rotation propre, tu dois :
1. Générer une nouvelle clé
2. Re-signer tous les codes existants (script à écrire si nécessaire)
3. Pousser la nouvelle clé

**Pour générer une clé forte (PowerShell)** :

```powershell
# Méthode 1 : OpenSSL (si installé)
openssl rand -hex 64

# Méthode 2 : .NET natif
$bytes = New-Object byte[] 64
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
-join ($bytes | ForEach-Object { '{0:x2}' -f $_ })
```

Tu obtiens 128 caractères hex (64 octets = 512 bits) — surdimensionné mais robuste.

### Poser une nouvelle clé HMAC (si rotation décidée)

```powershell
# ATTENTION : invalide tous les codes existants
npx wrangler secret put HMAC_SECRET_KEY
# Coller la nouvelle clé quand demandé
```

**Recommandation pour D5** : ne rotation pas si tu as déjà une clé forte aléatoire posée.
Vérifie seulement qu'elle existe via `wrangler secret list`. Si tu as un doute sur sa
provenance (ex: générée à la main au lancement), planifie une rotation pour un sprint
ultérieur avec script de re-signature.

---

## Étape 3 — Vérifier MASTER_ENCRYPTION_KEY

Cette clé est utilisée pour chiffrer les DEK des profs (D1) ET les payloads stats (D5).

```powershell
npx wrangler secret list | findstr MASTER_ENCRYPTION_KEY
```

**Format attendu** : 64 caractères hex (32 octets). Si tu as un doute, ne change pas :
changer MASTER_ENCRYPTION_KEY rend illisibles toutes les DEK déjà chiffrées et tous
les payloads stats déjà chiffrés.

Si elle n'est pas posée du tout :

```powershell
# Générer 32 octets aléatoires en hex
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$key = -join ($bytes | ForEach-Object { '{0:x2}' -f $_ })
Write-Host "MASTER_ENCRYPTION_KEY = $key"

# La poser
npx wrangler secret put MASTER_ENCRYPTION_KEY
# Coller la valeur quand demandé
```

⚠️ **NE JAMAIS PERDRE CETTE CLÉ** : sa perte = perte définitive des données chiffrées.
Sauvegarde-la dans un gestionnaire de mots de passe **chiffré** (Bitwarden, 1Password, KeePass).

---

## Étape 4 — Déployer le worker

```powershell
cd C:\mathequete\mathequete-website\worker

git pull origin main

npx wrangler deploy
```

Tu dois voir :
- `Successfully deployed` avec l'URL `https://mathequete-api.coresrdi.workers.dev`
- Les nouvelles migrations apparaissent dans les logs si automatiques (sinon appliquées manuellement à l'étape 1)

---

## Étape 5 — Tests de fumée

### Test rate limit sur login

```powershell
# 11 tentatives en moins de 60 sec → la 11e doit renvoyer 429
for ($i=1; $i -le 11; $i++) {
  curl -X POST https://mathequete-api.coresrdi.workers.dev/api/prof/login `
    -H "Content-Type: application/json" `
    -d '{"email":"test@invalid.local","password":"wrong"}'
  Write-Host ""
}
```

La 11e requête doit retourner :
```json
{"error":"Trop de tentatives, veuillez réessayer plus tard","retry_after_sec":...}
```
avec header `Retry-After: ...`.

### Test chiffrement stats

Si tu as un compte de test avec une licence active et un device_hash autorisé :

```powershell
# Push 1 élève avec payload
curl -X POST https://mathequete-api.coresrdi.workers.dev/api/stats/push `
  -H "Content-Type: application/json" `
  -d '{
    "code_brut": "TON-CODE-BRUT",
    "device_hash": "TON-DEVICE-HASH",
    "eleves": [{
      "eleve_id": "test-d5-1",
      "prenom": "Test",
      "total_examens": 1,
      "total_reussites": 1,
      "total_echecs": 0,
      "iles_completees": 0,
      "payload": {"detail": "test D5 chiffrement at-rest"}
    }]
  }'
```

Puis vérifier en DB que `payload_chiffre` est non-NULL et `payload_json` est NULL :

```powershell
npx wrangler d1 execute mathequete-db --remote --command="SELECT eleve_id, payload_json, length(payload_chiffre) as pc_len, payload_kdf FROM stats_eleves WHERE eleve_id='test-d5-1';"
```

Tu dois voir : `payload_json=NULL`, `pc_len > 0`, `payload_kdf='hkdf_sha256_master_v1'`.

Puis GET pour confirmer déchiffrement :

```powershell
curl "https://mathequete-api.coresrdi.workers.dev/api/stats/classe/TON-LICENCE-ID?code_brut=TON-CODE-BRUT&device_hash=TON-DEVICE-HASH"
```

Le `payload_json` retourné doit contenir `{"detail": "test D5 chiffrement at-rest"}` (déchiffré).

---

## Étape 6 — Cleanup optionnel

### Purger les anciens buckets rate limit (job manuel)

Pas de TTL automatique en D1. Tu peux purger les buckets non utilisés depuis 1 jour :

```powershell
$cutoff = [DateTimeOffset]::UtcNow.AddDays(-1).ToUnixTimeSeconds()
npx wrangler d1 execute mathequete-db --remote --command="DELETE FROM rate_limit_buckets WHERE updated_at < $cutoff;"
```

À faire occasionnellement (1×/semaine si trafic important, ou jamais si volume faible).

---

## Récapitulatif sécurité D5

| Protection | Niveau | Note |
|------------|--------|------|
| Stats payload at-rest | AES-256-GCM, K dérivée HKDF par licence | Protège contre dump DB |
| Rate limit auth | Sliding window D1, 10/min/IP | Protège contre brute force login/2FA |
| Rate limit signup | 5/heure/IP | Anti-spam création compte |
| Rate limit activation | 5/10min/IP | Anti-brute force codes licence |
| Rate limit stats | 60/min/IP | Anti-flood push stats |
| HMAC codes | Validation existence secret | Rotation au prochain sprint si besoin |

**Limitations connues (à traiter en sprints ultérieurs)** :
- Pas encore de chiffrement E2E (élève → prof) — viendra avec PB1 via clé QR
- Rate limit basé sur IP : un attaquant derrière NAT peut être bloqué injustement (rare)
- MASTER_ENCRYPTION_KEY non-rotatable trivialement (besoin script de re-chiffrement)
