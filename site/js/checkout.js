/**
 * Mathéquête — Composant Alpine pour la page d'achat.
 * Gère :
 *  - le basculement entre les onglets individuelle, pack 5 et école;
 *  - l'appel à l'API Cloudflare Worker pour créer une session Stripe Checkout;
 *  - les états de chargement et les erreurs réseau.
 *
 * SKU valides (doit correspondre à PRIX_TIERS_CENTS dans worker/src/types.ts) :
 *   continent_1          — 1,99 $/an  (annuel solo)
 *   pack_5_continent_1   — 7,99 $/an  (annuel pack 5)
 *   solo_permanent       — 9,99 $     (perpétuel solo)
 *   pack_5_permanent     — 39,99 $    (perpétuel pack 5)
 *   classe_petite / classe_moyenne / petite_ecole
 *   ecole_standard / grande_ecole / mega_ecole
 */
function checkoutApp() {
  return {
    tab: 'individuelle',      // 'individuelle' | 'pack5' | 'ecole'
    loading: false,
    loadingTier: '',          // pour ne montrer le spinner que sur la carte cliquée
    error: '',

    async acheter(tier) {
      this.loading = true;
      this.loadingTier = tier;
      this.error = '';
      try {
        const resp = await fetch(
          'https://mathequete-api.coresrdi.workers.dev/create-checkout-session',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tier })
          }
        );
        const data = await resp.json();
        if (data && data.url) {
          window.location.href = data.url;
          return; // on garde l'état loading pendant la redirection
        }
        this.error = (data && data.error) || 'Erreur inattendue. Réessaye dans un instant.';
      } catch (e) {
        this.error = 'Connexion impossible. Vérifie ta connexion internet et réessaye.';
      } finally {
        this.loading = false;
        this.loadingTier = '';
      }
    }
  };
}
