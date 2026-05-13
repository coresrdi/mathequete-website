#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Mathéquête Worker — Setup automatisé pour démarrage rapide
# Sprint S5 — Mai 2026
#
# Ce script enchaîne les étapes 0 à 5 du SETUP-PROD.md :
#   0. Vérification prérequis
#   1. Génération clé HMAC
#   2. Login Cloudflare
#   3. Création D1 + injection schéma + auto-patch wrangler.toml
#   4. Push des 3 secrets (HMAC, Stripe, Resend)
#   5. Premier déploiement + test /health
#
# Les étapes 6-9 (webhook Stripe, DNS Cloudflare, vérification Resend)
# restent manuelles parce qu'elles nécessitent des dashboards web.
#
# Usage : depuis /tmp/mathequete-website/worker/
#   chmod +x setup.sh
#   ./setup.sh
#
# Pour reprendre une étape précise :
#   ./setup.sh hmac
#   ./setup.sh d1
#   ./setup.sh secrets
#   ./setup.sh deploy
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Couleurs ────────────────────────────────────────────────────────────────
ROUGE='\033[0;31m'
VERT='\033[0;32m'
JAUNE='\033[1;33m'
BLEU='\033[0;34m'
RESET='\033[0m'

info()    { echo -e "${BLEU}[INFO]${RESET} $*"; }
ok()      { echo -e "${VERT}[OK]${RESET} $*"; }
warn()    { echo -e "${JAUNE}[WARN]${RESET} $*"; }
erreur()  { echo -e "${ROUGE}[ERREUR]${RESET} $*" >&2; }
demande() { echo -e "${JAUNE}[?]${RESET} $*"; }

# ─── Configuration locale (modifie si besoin) ────────────────────────────────
HMAC_KEY_PATH="${HOME}/prod_hmac.key"
DB_NAME="mathequete-db"
WORKER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRANGLER_TOML="${WORKER_DIR}/wrangler.toml"
EMAIL_BUSINESS="coresrdi@gmail.com"

cd "$WORKER_DIR"

# ─── Étape 0 : Vérification prérequis ────────────────────────────────────────
verifier_prerequis() {
	info "=== Étape 0 : Vérification prérequis ==="

	# Node
	if ! command -v node &> /dev/null; then
		erreur "node n'est pas installé. Installe Node.js ≥ 18 : https://nodejs.org"
		exit 1
	fi
	local node_ver
	node_ver=$(node --version | sed 's/v//' | cut -d. -f1)
	if [ "$node_ver" -lt 18 ]; then
		erreur "Node.js ≥ 18 requis (tu as v${node_ver})"
		exit 1
	fi
	ok "Node.js $(node --version)"

	# Wrangler
	if ! command -v wrangler &> /dev/null; then
		warn "wrangler manquant — installation..."
		npm install -g wrangler
	fi
	ok "Wrangler $(wrangler --version | head -1)"

	# OpenSSL
	if ! command -v openssl &> /dev/null; then
		erreur "openssl requis pour générer la clé HMAC"
		exit 1
	fi
	ok "OpenSSL présent"

	# jq (optionnel mais utile pour parser JSON)
	if ! command -v jq &> /dev/null; then
		warn "jq absent — installation recommandée (sudo apt install jq)"
	fi

	# Dépendances npm
	if [ ! -d "node_modules" ]; then
		info "Installation des dépendances npm..."
		npm install
	fi
	ok "Dépendances npm OK"

	# Fichiers attendus
	for f in wrangler.toml schema.sql src/index.ts; do
		if [ ! -f "$f" ]; then
			erreur "Fichier manquant : $f"
			exit 1
		fi
	done
	ok "Fichiers projet présents"
}

# ─── Étape 1 : Génération clé HMAC ──────────────────────────────────────────
generer_hmac() {
	info "=== Étape 1 : Clé HMAC maître ==="

	if [ -f "$HMAC_KEY_PATH" ]; then
		local taille
		taille=$(wc -c < "$HMAC_KEY_PATH" | tr -d ' ')
		# 64 chars + \n = 65, accepte aussi 64 (sans \n)
		if [ "$taille" -ge 64 ] && [ "$taille" -le 65 ]; then
			ok "Clé HMAC déjà présente : $HMAC_KEY_PATH"
			demande "Veux-tu en générer une NOUVELLE ? (oui pour overwrite, sinon garde l'ancienne) [oui/N]"
			read -r reponse
			if [ "$reponse" != "oui" ]; then
				ok "Clé existante conservée"
				return
			fi
		else
			warn "Fichier $HMAC_KEY_PATH existe mais taille invalide ($taille octets)"
		fi
	fi

	openssl rand -hex 32 > "$HMAC_KEY_PATH"
	chmod 600 "$HMAC_KEY_PATH"
	ok "Clé HMAC générée : $HMAC_KEY_PATH"
	warn "Note-la dans 1Password / coffre AVANT de continuer :"
	echo
	cat "$HMAC_KEY_PATH"
	echo
	demande "As-tu sauvegardé cette clé dans un coffre ? [oui/N]"
	read -r reponse
	if [ "$reponse" != "oui" ]; then
		erreur "Sauvegarde la clé d'abord, puis relance ./setup.sh"
		exit 1
	fi
}

# ─── Étape 2 : Login Cloudflare ──────────────────────────────────────────────
cloudflare_login() {
	info "=== Étape 2 : Login Cloudflare ==="

	if wrangler whoami 2>&1 | grep -q "logged in"; then
		ok "Déjà connecté à Cloudflare"
		wrangler whoami | head -5
	else
		info "Lancement de wrangler login (ouvre un navigateur)..."
		warn "Si tu n'as pas de compte Cloudflare, crées-en un d'abord à https://dash.cloudflare.com/sign-up"
		warn "Utilise ton email business : $EMAIL_BUSINESS"
		demande "Prêt à lancer le login ? [oui/N]"
		read -r reponse
		if [ "$reponse" != "oui" ]; then
			erreur "Setup annulé"
			exit 1
		fi
		wrangler login
		ok "Login OK"
	fi
}

# ─── Étape 3 : Création D1 + schéma + patch wrangler.toml ───────────────────
setup_d1() {
	info "=== Étape 3 : Base D1 ==="

	# Vérifier si la DB existe déjà
	local db_id
	db_id=$(wrangler d1 list 2>/dev/null | grep "$DB_NAME" | awk '{print $1}' | head -1 || true)

	if [ -n "$db_id" ]; then
		ok "Base D1 '$DB_NAME' existe déjà (id=$db_id)"
	else
		info "Création de la base D1 '$DB_NAME'..."
		local output
		output=$(wrangler d1 create "$DB_NAME" 2>&1)
		echo "$output"
		# Extraction du database_id (apparaît sur la ligne "database_id = "xxx"")
		db_id=$(echo "$output" | grep -oE 'database_id = "[^"]+"' | sed 's/database_id = "//;s/"//' | head -1)
		if [ -z "$db_id" ]; then
			erreur "Impossible d'extraire le database_id. Copie-le manuellement dans wrangler.toml."
			exit 1
		fi
		ok "Base D1 créée : id=$db_id"
	fi

	# Patch wrangler.toml — remplacer le placeholder par le vrai id
	if grep -q "À_REMPLIR_APRÈS_wrangler_d1_create\"" "$WRANGLER_TOML"; then
		# Remplace seulement la ligne PROD (la première occurrence)
		# Détection cross-platform sed -i
		if sed --version &>/dev/null; then
			# GNU sed
			sed -i "0,/À_REMPLIR_APRÈS_wrangler_d1_create\"/s|À_REMPLIR_APRÈS_wrangler_d1_create\"|${db_id}\"|" "$WRANGLER_TOML"
		else
			# BSD sed (macOS)
			sed -i '' "1,/À_REMPLIR_APRÈS_wrangler_d1_create\"/s|À_REMPLIR_APRÈS_wrangler_d1_create\"|${db_id}\"|" "$WRANGLER_TOML"
		fi
		ok "wrangler.toml patché avec database_id=$db_id"
	else
		ok "wrangler.toml déjà patché (database_id présent)"
	fi

	# Vérifier si les tables existent déjà
	local tables
	tables=$(wrangler d1 execute "$DB_NAME" --remote --command "SELECT name FROM sqlite_master WHERE type='table';" 2>/dev/null || echo "")
	if echo "$tables" | grep -q "licences"; then
		ok "Schéma déjà appliqué (table 'licences' présente)"
	else
		info "Injection du schéma..."
		wrangler d1 execute "$DB_NAME" --file=schema.sql --remote
		ok "Schéma injecté"
	fi

	# Affichage tables finales
	info "Tables D1 actuelles :"
	wrangler d1 execute "$DB_NAME" --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" 2>/dev/null | tail -20
}

# ─── Étape 4 : Push des secrets ─────────────────────────────────────────────
push_secret_si_absent() {
	local nom="$1"
	local valeur_fichier="${2:-}"   # optionnel : fichier source
	local description="$3"

	# Liste les secrets actuels
	local existants
	existants=$(wrangler secret list 2>/dev/null | grep -oE '"name": "[^"]+"' | sed 's/"name": "//;s/"//' || echo "")

	if echo "$existants" | grep -q "^${nom}$"; then
		ok "Secret $nom déjà présent"
		demande "Le mettre à jour ? [oui/N]"
		read -r reponse
		if [ "$reponse" != "oui" ]; then
			return
		fi
	fi

	if [ -n "$valeur_fichier" ] && [ -f "$valeur_fichier" ]; then
		info "Push de $nom depuis $valeur_fichier..."
		wrangler secret put "$nom" < "$valeur_fichier"
	else
		warn "$description"
		info "Push de $nom (colle la valeur puis Entrée + Ctrl+D)..."
		wrangler secret put "$nom"
	fi
	ok "Secret $nom enregistré"
}

push_secrets() {
	info "=== Étape 4 : Secrets ==="

	# 1. HMAC depuis fichier
	push_secret_si_absent "HMAC_SECRET_KEY" "$HMAC_KEY_PATH" \
		"Clé HMAC depuis $HMAC_KEY_PATH"

	# 2. Stripe
	echo
	warn "Pour STRIPE_SECRET_KEY :"
	warn "  1. Va sur https://dashboard.stripe.com/apikeys"
	warn "  2. Crée ton compte avec $EMAIL_BUSINESS si pas fait"
	warn "  3. Section 'Standard keys' → 'Secret key' → Reveal"
	warn "  4. Mode TEST d'abord (sk_test_xxx) — passe en live plus tard"
	demande "Prêt à coller la clé Stripe ? [oui/N]"
	read -r reponse
	if [ "$reponse" = "oui" ]; then
		push_secret_si_absent "STRIPE_SECRET_KEY" "" \
			"Clé secrète Stripe (sk_test_xxx ou sk_live_xxx)"
	else
		warn "Skip Stripe — relance avec ./setup.sh secrets plus tard"
	fi

	# 3. Resend
	echo
	warn "Pour RESEND_API_KEY :"
	warn "  1. Va sur https://resend.com/signup avec $EMAIL_BUSINESS"
	warn "  2. Une fois connecté : API Keys → Create API Key"
	warn "  3. Nom: 'mathequete-prod', Permission: 'Sending access'"
	warn "  4. Copie la re_xxx (visible UNE SEULE FOIS)"
	demande "Prêt à coller la clé Resend ? [oui/N]"
	read -r reponse
	if [ "$reponse" = "oui" ]; then
		push_secret_si_absent "RESEND_API_KEY" "" \
			"Clé API Resend (re_xxx)"
	else
		warn "Skip Resend — relance avec ./setup.sh secrets plus tard"
	fi

	# 4. Webhook Stripe — message d'info uniquement (à faire après deploy)
	echo
	warn "STRIPE_WEBHOOK_SECRET se configure APRÈS le premier déploiement."
	warn "Étape 6 manuelle du SETUP-PROD.md — on y arrive bientôt."

	info "Secrets actuellement configurés :"
	wrangler secret list 2>/dev/null || true
}

# ─── Étape 5 : Premier déploiement ──────────────────────────────────────────
deploy_et_test() {
	info "=== Étape 5 : Déploiement ==="

	if grep -q "À_REMPLIR" "$WRANGLER_TOML"; then
		erreur "wrangler.toml contient encore des placeholders À_REMPLIR — corrige avant deploy"
		grep "À_REMPLIR" "$WRANGLER_TOML"
		exit 1
	fi

	info "Lancement de wrangler deploy..."
	local output
	output=$(wrangler deploy 2>&1)
	echo "$output"

	# Extraction de l'URL du worker
	local worker_url
	worker_url=$(echo "$output" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
	if [ -z "$worker_url" ]; then
		warn "URL du worker introuvable dans la sortie. Cherche-la manuellement."
	else
		ok "Worker déployé : $worker_url"
		echo "$worker_url" > "${WORKER_DIR}/.worker_url"

		# Test /health
		info "Test de /health..."
		sleep 2
		local health
		health=$(curl -sS "${worker_url}/health" || echo "ERREUR")
		echo "Réponse: $health"
		if echo "$health" | grep -q "ok"; then
			ok "Worker répond correctement"
		else
			warn "Worker répond mais /health pas OK — vérifie les logs avec : wrangler tail"
		fi
	fi

	# Récap final
	echo
	info "═══════════════════════════════════════════════════════════════"
	info "  Setup automatisé TERMINÉ"
	info "═══════════════════════════════════════════════════════════════"
	echo
	info "URL du Worker : ${worker_url:-(à récupérer manuellement)}"
	echo
	info "Prochaines étapes MANUELLES (voir SETUP-PROD.md) :"
	echo "  6. Webhook Stripe à créer (dashboard.stripe.com → Developers → Webhooks)"
	echo "     URL endpoint : ${worker_url}/api/stripe/webhook"
	echo "     Événements : checkout.session.completed, payment_intent.succeeded"
	echo "     Puis : wrangler secret put STRIPE_WEBHOOK_SECRET && wrangler deploy"
	echo
	echo "  7. Domaine (OPTIONNEL pour l'instant — workers.dev marche)"
	echo "     Cloudflare Registrar (~13 \$/an) ou Namecheap .xyz (~1 \$/an)"
	echo
	echo "  8. Resend domain vérification (BLOQUÉ tant que pas de domaine)"
	echo "     En attendant : mode test, envoi vers $EMAIL_BUSINESS uniquement"
	echo
	info "Commandes utiles :"
	echo "  wrangler tail              # logs en temps réel"
	echo "  wrangler secret list       # voir secrets configurés"
	echo "  wrangler deployments list  # historique deploys"
	echo "  ./setup.sh deploy          # redéployer après modif"
}

# ─── Dispatcher ──────────────────────────────────────────────────────────────
main() {
	local cmd="${1:-tout}"

	case "$cmd" in
		tout)
			verifier_prerequis
			generer_hmac
			cloudflare_login
			setup_d1
			push_secrets
			deploy_et_test
			;;
		prerequis|check)
			verifier_prerequis
			;;
		hmac)
			generer_hmac
			;;
		login)
			cloudflare_login
			;;
		d1)
			verifier_prerequis
			setup_d1
			;;
		secrets)
			verifier_prerequis
			push_secrets
			;;
		deploy)
			verifier_prerequis
			deploy_et_test
			;;
		help|-h|--help)
			cat <<EOF
Mathéquête Worker Setup — Commandes :

  ./setup.sh              # Exécute toutes les étapes 0-5 dans l'ordre
  ./setup.sh prerequis    # Étape 0 — vérifie Node, wrangler, npm
  ./setup.sh hmac         # Étape 1 — génère clé HMAC dans ~/prod_hmac.key
  ./setup.sh login        # Étape 2 — wrangler login
  ./setup.sh d1           # Étape 3 — crée DB + patch wrangler.toml
  ./setup.sh secrets      # Étape 4 — push HMAC, Stripe, Resend
  ./setup.sh deploy       # Étape 5 — wrangler deploy + test /health
  ./setup.sh help         # Cette aide
EOF
			;;
		*)
			erreur "Commande inconnue : $cmd"
			echo "Tape : ./setup.sh help"
			exit 1
			;;
	esac
}

main "$@"
