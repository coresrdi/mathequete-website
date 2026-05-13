/* Mathéquête — Calculateur de prix dynamique
 *
 * Source officielle (Plan v3.1 §3.2 + §3.3, DEC-26) :
 *
 *   coût_base = nb_élèves × 0,65 × 1,5108 × facteur_palier
 *
 * Le tableau de tranches commerciales §3.3 fixe des **prix de packs**
 * arrondis pour la lisibilité marketing :
 *
 *   30 élèves   → 35  $ (Classe Petite)
 *   100 élèves  → 98  $ (Classe Moyenne)
 *   200 élèves  → 187 $
 *   300 élèves  → 265 $ (Petite École)
 *   500 élèves  → 393 $ (École Standard)
 *   700 élèves  → 481 $
 *   1000 élèves → 650 $ (Grande École) ← calibration de référence
 *   1100 élèves → 682 $
 *   1300 élèves → 716 $ (Méga École)
 *
 * Stratégie d'affichage du calculateur :
 *   • Aux paliers exacts → on retourne LE PRIX OFFICIEL du tableau
 *   • Entre les paliers → interpolation linéaire (continue, monotone)
 *   • Hors plage (>1300) → sur devis (renvoie null)
 *
 * Référence concurrent : Prodigy ≈ 50 $ CAD/élève/an.
 */

const TPS = 0.05;
const TVQ = 0.09975;
const PRODIGY_PRIX = 50;

/* Table officielle Plan v3.1 §3.2-3.3.
 * Triée par nombre d'élèves croissant. */
const PRIX_PALIERS = [
  { n:   30, prix:  35, nom: 'Classe Petite' },
  { n:  100, prix:  98, nom: 'Classe Moyenne' },
  { n:  200, prix: 187 },
  { n:  300, prix: 265, nom: 'Petite École' },
  { n:  500, prix: 393, nom: 'École Standard' },
  { n:  700, prix: 481 },
  { n: 1000, prix: 650, nom: 'Grande École' },
  { n: 1100, prix: 682 },
  { n: 1300, prix: 716, nom: 'Méga École' }
];

const N_MIN = PRIX_PALIERS[0].n;
const N_MAX = PRIX_PALIERS[PRIX_PALIERS.length - 1].n;

/**
 * Retourne le prix HT (sans taxes) pour `n` élèves, interpolé entre les paliers.
 * Retourne null si n > N_MAX (sur devis).
 */
function prixHT(n) {
  if (n >= N_MIN && n <= N_MAX) {
    for (let i = 0; i < PRIX_PALIERS.length - 1; i++) {
      const a = PRIX_PALIERS[i];
      const b = PRIX_PALIERS[i + 1];
      if (n >= a.n && n <= b.n) {
        if (n === a.n) return a.prix;
        if (n === b.n) return b.prix;
        const t = (n - a.n) / (b.n - a.n);
        return Math.round(a.prix + t * (b.prix - a.prix));
      }
    }
  }
  // En-dessous du min : tarif unitaire du palier 30 (~1,17 $/élève)
  if (n < N_MIN) {
    return Math.round(n * (PRIX_PALIERS[0].prix / PRIX_PALIERS[0].n));
  }
  // Au-delà du max : sur devis
  return null;
}

function nomPalier(n) {
  if (n > N_MAX) return 'Sur-mesure (devis)';
  for (let i = 0; i < PRIX_PALIERS.length; i++) {
    const p = PRIX_PALIERS[i];
    if (p.nom && n <= p.n) return p.nom;
  }
  return 'Sur-mesure (devis)';
}

function calculerPrix(n) {
  const ht = prixHT(n);
  if (ht === null) {
    return {
      nbEleves: n,
      surDevis: true,
      coutProdigy: Math.round(n * PRODIGY_PRIX)
    };
  }
  const tps = ht * TPS;
  const tvq = ht * TVQ;
  const total = ht + tps + tvq;
  const prixParEleve = ht / n;
  const coutProdigy = n * PRODIGY_PRIX;
  const economie = coutProdigy - ht;
  const ratioMoinsCher = coutProdigy / ht;

  return {
    nbEleves: n,
    surDevis: false,
    prixHT: ht,
    tps: Math.round(tps),
    tvq: Math.round(tvq),
    total: Math.round(total),
    prixParEleve: Math.round(prixParEleve * 100) / 100,
    coutProdigy: Math.round(coutProdigy),
    economie: Math.round(economie),
    ratioMoinsCher: ratioMoinsCher.toFixed(1)
  };
}

function formaterCAD(montant) {
  return montant.toLocaleString('fr-CA', {
    style: 'currency', currency: 'CAD', maximumFractionDigits: 0
  });
}

function formaterCADcent(montant) {
  return montant.toLocaleString('fr-CA', {
    style: 'currency', currency: 'CAD',
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
}

/* ====================== Initialisation UI ====================== */
if (typeof document !== 'undefined') {
document.addEventListener('DOMContentLoaded', function () {
  const slider     = document.getElementById('nbEleves');
  const inputNum   = document.getElementById('nbElevesNum');
  const elNom      = document.getElementById('palierNom');
  const elPrix     = document.getElementById('prixTotal');
  const elPrixUnit = document.getElementById('prixUnit');
  const elTPS      = document.getElementById('tps');
  const elTVQ      = document.getElementById('tvq');
  const elTotal    = document.getElementById('totalTTC');
  const elEcon     = document.getElementById('economie');
  const elRatio    = document.getElementById('ratio');
  const elDevis    = document.getElementById('zoneDevis');
  const elZoneCalc = document.getElementById('zoneCalcul');

  if (!slider) return;

  function rafraichir() {
    const n = parseInt(slider.value, 10) || 30;
    inputNum.value = n;
    const r = calculerPrix(n);

    elNom.textContent = nomPalier(n);

    if (r.surDevis) {
      if (elDevis) elDevis.style.display = 'block';
      if (elZoneCalc) elZoneCalc.style.display = 'none';
      return;
    }

    if (elDevis) elDevis.style.display = 'none';
    if (elZoneCalc) elZoneCalc.style.display = 'block';

    elPrix.textContent      = formaterCAD(r.prixHT);
    elPrixUnit.textContent  = formaterCADcent(r.prixParEleve);
    if (elTPS)   elTPS.textContent   = formaterCAD(r.tps);
    if (elTVQ)   elTVQ.textContent   = formaterCAD(r.tvq);
    if (elTotal) elTotal.textContent = formaterCAD(r.total);
    if (elEcon)  elEcon.textContent  = formaterCAD(r.economie);
    if (elRatio) elRatio.textContent = r.ratioMoinsCher;
  }

  slider.addEventListener('input', rafraichir);
  inputNum.addEventListener('input', function () {
    let v = parseInt(inputNum.value, 10);
    if (isNaN(v)) return;
    v = Math.max(1, Math.min(2000, v));
    slider.value = v;
    rafraichir();
  });

  rafraichir();
});
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { calculerPrix, prixHT, nomPalier, PRIX_PALIERS };
}
