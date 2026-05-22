/**
 * Mathéquête — Système de prévisualisation vidéo YouTube
 * Commit 5 — Mai 2026
 *
 * Comportement :
 *  - Survol d'une .video-thumb → miniature YouTube mute (autoplay muted)
 *  - Clic → lecteur agrandi (480×270) avec son, fixe en position (ne suit pas le scroll)
 *  - Clic sur X ou fond sombre → ferme le lecteur
 *
 * Vidéos (playlist PLO6RTx5X6m1UCxKk00kdZsJ_W07_8gaPW) :
 *  bLijXDgYm2U — Démo cinématique révisions (hero / accueil)
 *  v7oa01j_A80 — Pub cinématique 2 (achat / enseignants)
 *  sut0bZkPiIw — Description générale (support / applications)
 */

(function () {
  'use strict';

  // ── Config vidéos par contexte ──────────────────────────────────────────
  const VIDEOS = {
    hero:          { id: 'bLijXDgYm2U', titre: 'Démo — Mode révisions' },
    aventure:      { id: 'v7oa01j_A80', titre: 'Mathéquête en action' },
    pro:           { id: 'sut0bZkPiIw', titre: 'Présentation complète' },
  };

  // ── Styles injectés une seule fois ──────────────────────────────────────
  function injecterStyles() {
    if (document.getElementById('mq-video-styles')) return;
    const s = document.createElement('style');
    s.id = 'mq-video-styles';
    s.textContent = `
      /* Conteneur thumb */
      .video-thumb {
        position: relative;
        display: inline-block;
        cursor: pointer;
        border-radius: 10px;
        overflow: hidden;
        box-shadow: 0 4px 16px rgba(0,0,0,0.18);
        transition: box-shadow 0.22s ease, transform 0.22s ease;
        width: 100%;
        max-width: 380px;
        aspect-ratio: 16/9;
        background: #0f0f0f;
      }
      .video-thumb:hover {
        box-shadow: 0 8px 32px rgba(0,0,0,0.30);
        transform: translateY(-2px);
      }

      /* Vignette statique (image de couverture) */
      .video-thumb-img {
        width: 100%; height: 100%;
        object-fit: cover;
        display: block;
        transition: opacity 0.3s ease;
      }

      /* Icône play */
      .video-thumb-play {
        position: absolute; inset: 0;
        display: flex; align-items: center; justify-content: center;
        pointer-events: none;
        transition: opacity 0.2s ease;
      }
      .video-thumb-play svg {
        width: 56px; height: 56px;
        filter: drop-shadow(0 2px 8px rgba(0,0,0,0.6));
        opacity: 0.90;
        transition: opacity 0.2s ease, transform 0.2s ease;
      }
      .video-thumb:hover .video-thumb-play svg {
        opacity: 1;
        transform: scale(1.10);
      }

      /* iframe miniature au survol */
      .video-thumb-preview {
        position: absolute; inset: 0;
        width: 100%; height: 100%;
        border: none;
        opacity: 0;
        transition: opacity 0.35s ease;
        pointer-events: none;
      }
      .video-thumb.hovered .video-thumb-img   { opacity: 0; }
      .video-thumb.hovered .video-thumb-play  { opacity: 0; }
      .video-thumb.hovered .video-thumb-preview { opacity: 1; pointer-events: auto; }

      /* Label titre */
      .video-thumb-label {
        position: absolute; bottom: 0; left: 0; right: 0;
        background: linear-gradient(transparent, rgba(0,0,0,0.72));
        color: #fff;
        font-family: inherit;
        font-size: 0.78rem;
        font-weight: 600;
        padding: 1.2rem 0.8rem 0.55rem;
        pointer-events: none;
        transition: opacity 0.2s ease;
      }
      .video-thumb.hovered .video-thumb-label { opacity: 0; }

      /* ── Lecteur agrandi ── */
      #mq-video-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.62);
        z-index: 9000;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding-top: 120px;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.22s ease;
      }
      #mq-video-overlay.visible {
        opacity: 1;
        pointer-events: auto;
      }
      #mq-video-box {
        position: relative;
        width: min(640px, 92vw);
        aspect-ratio: 16/9;
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 24px 64px rgba(0,0,0,0.55);
        background: #000;
        transform: scale(0.94);
        transition: transform 0.22s ease;
      }
      #mq-video-overlay.visible #mq-video-box {
        transform: scale(1);
      }
      #mq-video-box iframe {
        width: 100%; height: 100%; border: none; display: block;
      }
      #mq-video-fermer {
        position: absolute;
        top: -38px; right: 0;
        background: rgba(255,255,255,0.15);
        border: none;
        color: #fff;
        font-size: 1.4rem;
        line-height: 1;
        border-radius: 50%;
        width: 34px; height: 34px;
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: background 0.18s ease;
      }
      #mq-video-fermer:hover { background: rgba(255,255,255,0.30); }

      /* Wrapper layout vidéo dans les sections */
      .video-section-wrapper {
        display: flex;
        align-items: center;
        gap: 2.5rem;
        flex-wrap: wrap;
        max-width: 900px;
        margin: 0 auto;
      }
      .video-section-wrapper .video-thumb { flex: 0 0 340px; }
      .video-section-texte { flex: 1 1 260px; }
    `;
    document.head.appendChild(s);
  }

  // ── Construire un bloc thumb ─────────────────────────────────────────────
  function creerThumb(videoId, titre) {
    const thumbUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    const previewSrc = `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&loop=1&playlist=${videoId}&controls=0&modestbranding=1&rel=0&enablejsapi=0`;

    const wrap = document.createElement('div');
    wrap.className = 'video-thumb';
    wrap.setAttribute('role', 'button');
    wrap.setAttribute('tabindex', '0');
    wrap.setAttribute('aria-label', `Visionner : ${titre}`);
    wrap.dataset.videoId = videoId;
    wrap.dataset.titre = titre;

    wrap.innerHTML = `
      <img class="video-thumb-img" src="${thumbUrl}" alt="${titre}" width="380" height="214" loading="lazy">
      <div class="video-thumb-play" aria-hidden="true">
        <svg viewBox="0 0 68 68" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="34" cy="34" r="34" fill="rgba(0,0,0,0.55)"/>
          <polygon points="26,20 54,34 26,48" fill="white"/>
        </svg>
      </div>
      <iframe class="video-thumb-preview" src="" frameborder="0"
        allow="autoplay; encrypted-media" allowfullscreen
        title="${titre} — aperçu" tabindex="-1"></iframe>
      <div class="video-thumb-label">${titre}</div>
    `;

    let hoverTimer = null;

    // Survol → miniature mute
    wrap.addEventListener('mouseenter', () => {
      hoverTimer = setTimeout(() => {
        const iframe = wrap.querySelector('.video-thumb-preview');
        if (!iframe.src || iframe.src === window.location.href) {
          iframe.src = previewSrc;
        }
        wrap.classList.add('hovered');
      }, 180);
    });

    wrap.addEventListener('mouseleave', () => {
      clearTimeout(hoverTimer);
      wrap.classList.remove('hovered');
    });

    // Clic / Entrée → lecteur grand format avec son
    function ouvrir() { ouvrirLecteur(videoId, titre); }
    wrap.addEventListener('click', ouvrir);
    wrap.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ouvrir(); } });

    return wrap;
  }

  // ── Overlay lecteur agrandi ──────────────────────────────────────────────
  let overlayEl = null;
  let boxEl = null;

  function creerOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = 'mq-video-overlay';
    overlayEl.setAttribute('role', 'dialog');
    overlayEl.setAttribute('aria-modal', 'true');
    overlayEl.setAttribute('aria-label', 'Lecteur vidéo');

    boxEl = document.createElement('div');
    boxEl.id = 'mq-video-box';

    const fermer = document.createElement('button');
    fermer.id = 'mq-video-fermer';
    fermer.innerHTML = '&times;';
    fermer.setAttribute('aria-label', 'Fermer la vidéo');
    fermer.addEventListener('click', fermerLecteur);

    boxEl.appendChild(fermer);
    overlayEl.appendChild(boxEl);
    document.body.appendChild(overlayEl);

    // Clic fond = fermer
    overlayEl.addEventListener('click', e => {
      if (e.target === overlayEl) fermerLecteur();
    });

    // Echap = fermer
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') fermerLecteur();
    });
  }

  function ouvrirLecteur(videoId, titre) {
    creerOverlay();
    // Retirer iframe précédente
    const ancien = boxEl.querySelector('iframe');
    if (ancien) ancien.remove();

    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1`;
    iframe.setAttribute('allow', 'autoplay; fullscreen; encrypted-media');
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('title', titre);

    boxEl.appendChild(iframe);
    overlayEl.classList.add('visible');
    document.body.style.overflow = 'hidden';
    fermerBtn(boxEl);
  }

  function fermerBtn(box) {
    // S'assure que le bouton × est au-dessus de l'iframe
    const btn = box.querySelector('#mq-video-fermer');
    if (btn) box.appendChild(btn);
  }

  function fermerLecteur() {
    if (!overlayEl) return;
    overlayEl.classList.remove('visible');
    document.body.style.overflow = '';
    setTimeout(() => {
      const iframe = boxEl.querySelector('iframe');
      if (iframe) iframe.remove();
    }, 250);
  }

  // ── Initialisation — cherche les .video-placeholder dans la page ─────────
  function init() {
    injecterStyles();

    // Cherche tous les éléments [data-video-context]
    document.querySelectorAll('[data-video-context]').forEach(el => {
      const ctx = el.dataset.videoContext;
      const video = VIDEOS[ctx];
      if (!video) return;
      const thumb = creerThumb(video.id, video.titre);
      el.replaceWith(thumb);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
