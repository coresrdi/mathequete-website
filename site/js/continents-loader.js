/**
 * continents-loader.js — Mathéquête v4.40
 * SOURCE DE DONNÉES : /data/continents.json
 *
 * Usage sur n'importe quelle page :
 *   <div data-continents-target></div>
 *   <script src="/js/continents-loader.js"></script>
 *
 * Modes disponibles via data-mode :
 *   full              — tous les continents (défaut)
 *   disponible-only   — seulement statut "disponible"
 *   placeholder-only  — seulement statut "en_creation" et "a_venir"
 */

(function () {
  "use strict";

  const DATA_URL = "/data/continents.json";

  async function fetchContinents() {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error("Impossible de charger continents.json");
    return res.json();
  }

  function renderBadge(statut, statuts_visuels) {
    const cfg = statuts_visuels[statut] || {};
    return `<span class="continent-badge ${cfg.css_class || ""}">${cfg.label || statut}</span>`;
  }

  function renderCard(continent, statuts_visuels) {
    const sv = statuts_visuels[continent.statut] || {};
    const opacite = sv.opacite_carte !== undefined ? sv.opacite_carte : 1;

    const ctaPrimaire = continent.cta_primaire && continent.cta_primaire.url
      ? `<a href="${continent.cta_primaire.url}" class="continent-cta continent-cta--primaire" target="_blank" rel="noopener noreferrer">${continent.cta_primaire.label}</a>`
      : continent.cta_primaire
        ? `<span class="continent-cta continent-cta--primaire continent-cta--disabled">${continent.cta_primaire.label}</span>`
        : "";

    const ctaSecondaire = continent.cta_secondaire
      ? `<a href="${continent.cta_secondaire.url || "#liste-attente"}" class="continent-cta continent-cta--secondaire">${continent.cta_secondaire.label}</a>`
      : "";

    const kickstarterBanner = continent.kickstarter_cta
      ? `<div class="continent-kickstarter">🚀 Financez ce continent sur Kickstarter</div>`
      : "";

    return `
      <article
        class="continent-card continent-card--${continent.statut}"
        data-continent-id="${continent.id}"
        style="--continent-accent:${continent.couleur_accent};opacity:${opacite};"
        aria-label="Continent : ${continent.nom}"
      >
        <div class="continent-card__header">
          <span class="continent-icone" aria-hidden="true">${continent.icone}</span>
          ${renderBadge(continent.statut, statuts_visuels)}
        </div>
        <div class="continent-card__body">
          <h3 class="continent-nom">${continent.nom}</h3>
          <p class="continent-sous-titre">${continent.sous_titre}</p>
          <p class="continent-description">${continent.description}</p>
        </div>
        ${kickstarterBanner}
        <div class="continent-card__footer">
          ${ctaPrimaire}
          ${ctaSecondaire}
        </div>
      </article>`;
  }

  function filterContinents(continents, mode) {
    if (mode === "disponible-only")  return continents.filter(c => c.statut === "disponible");
    if (mode === "placeholder-only") return continents.filter(c => c.statut !== "disponible");
    return continents;
  }

  function injectStyles() {
    if (document.getElementById("continents-loader-css")) return;
    const s = document.createElement("style");
    s.id = "continents-loader-css";
    s.textContent = `
      .continents-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(280px,100%),1fr));gap:1.5rem}
      .continent-card{background:var(--color-surface,#f9f8f5);border:1px solid oklch(from var(--color-text,#28251d) l c h/0.10);border-top:3px solid var(--continent-accent,#01696f);border-radius:var(--radius-lg,.75rem);padding:1.5rem;display:flex;flex-direction:column;gap:1rem;transition:box-shadow 180ms cubic-bezier(.16,1,.3,1),transform 180ms cubic-bezier(.16,1,.3,1)}
      .continent-card--disponible:hover{box-shadow:0 4px 16px oklch(.2 .01 80/.10);transform:translateY(-2px)}
      .continent-card__header{display:flex;align-items:center;justify-content:space-between}
      .continent-icone{font-size:2rem;line-height:1}
      .continent-badge{font-size:.75rem;font-weight:600;padding:.25rem .625rem;border-radius:9999px;text-transform:uppercase;letter-spacing:.04em}
      .badge-success{background:var(--color-success-highlight,#d4dfcc);color:var(--color-success,#437a22)}
      .badge-warning{background:var(--color-warning-highlight,#ddcfc6);color:var(--color-warning,#964219)}
      .badge-muted{background:var(--color-surface-offset,#f3f0ec);color:var(--color-text-muted,#7a7974)}
      .continent-nom{font-size:var(--text-lg,1.25rem);font-weight:700;color:var(--color-text,#28251d);margin:0}
      .continent-sous-titre{font-size:var(--text-sm,.875rem);color:var(--color-text-muted,#7a7974);margin:.25rem 0 0}
      .continent-description{font-size:var(--text-base,1rem);line-height:1.6;margin:0}
      .continent-kickstarter{background:var(--color-warning-highlight,#ddcfc6);color:var(--color-warning,#964219);border-radius:var(--radius-md,.5rem);padding:.5rem .75rem;font-size:var(--text-sm,.875rem);font-weight:600}
      .continent-card__footer{display:flex;flex-direction:column;gap:.5rem;margin-top:auto}
      .continent-cta{display:inline-block;text-align:center;padding:.625rem 1rem;border-radius:var(--radius-md,.5rem);font-size:var(--text-sm,.875rem);font-weight:600;text-decoration:none;transition:opacity 180ms}
      .continent-cta--primaire{background:var(--continent-accent,#01696f);color:#fff}
      .continent-cta--primaire:hover{opacity:.88}
      .continent-cta--primaire.continent-cta--disabled{opacity:.5;cursor:not-allowed;pointer-events:none}
      .continent-cta--secondaire{background:transparent;color:var(--continent-accent,#01696f);border:1px solid var(--continent-accent,#01696f)}
      .continent-cta--secondaire:hover{background:var(--color-primary-highlight,#cedcd8)}
      .continents-error{color:var(--color-error,#a12c7b);font-style:italic;padding:1rem}
    `;
    document.head.appendChild(s);
  }

  async function init() {
    const targets = document.querySelectorAll("[data-continents-target]");
    if (!targets.length) return;
    injectStyles();
    let data;
    try {
      data = await fetchContinents();
    } catch (err) {
      targets.forEach(t => {
        t.innerHTML = `<p class="continents-error">Impossible de charger les continents. Veuillez rafraîchir la page.</p>`;
      });
      console.error("[continents-loader]", err);
      return;
    }
    targets.forEach(target => {
      const mode = target.dataset.mode || "full";
      const filtered = filterContinents(data.continents, mode);
      const grid = document.createElement("div");
      grid.className = "continents-grid";
      grid.innerHTML = filtered.map(c => renderCard(c, data.statuts_visuels)).join("");
      target.appendChild(grid);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
