/**
 * Mathéquête — Composant Alpine pour la page d'achat.
 * Gère :
 *  - le basculement entre l'onglet famille et l'onglet école;
 *  - l'appel à l'API Cloudflare Worker pour créer une session Stripe Checkout;
 *  - les états de chargement et les erreurs réseau.
 */
function checkoutApp() {
  return {
    tab: 'famille',           // 'famille' | 'ecole'
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
