/**
 * videos-loader.js — Mathéquête
 * Gère l'ouverture/fermeture du modal lightbox YouTube.
 * Chaque vignette .video-thumb[data-yt-id] ouvre la vidéo en plein modal.
 * Fermeture : bouton ✕, clic sur le fond, ou touche Escape.
 */
(function () {
  'use strict';

  const modal   = document.getElementById('video-modal');
  const iframe  = document.getElementById('modal-iframe');
  const closeBtn = document.getElementById('modal-close-btn');

  if (!modal || !iframe) return;

  function openVideo(ytId) {
    iframe.src = 'https://www.youtube-nocookie.com/embed/' + ytId +
                 '?autoplay=1&rel=0&modestbranding=1';
    modal.classList.add('actif');
    modal.focus();
    document.body.style.overflow = 'hidden';
  }

  function closeVideo() {
    modal.classList.remove('actif');
    iframe.src = '';
    document.body.style.overflow = '';
  }

  // Clic sur vignette
  document.querySelectorAll('.video-thumb[data-yt-id]').forEach(function (thumb) {
    thumb.addEventListener('click', function () {
      openVideo(this.dataset.ytId);
    });
    // Accessibilité clavier
    thumb.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openVideo(this.dataset.ytId);
      }
    });
  });

  // Fermeture bouton ✕
  closeBtn.addEventListener('click', closeVideo);

  // Fermeture clic fond modal (hors iframe)
  modal.addEventListener('click', function (e) {
    if (e.target === modal) closeVideo();
  });

  // Fermeture touche Escape
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modal.classList.contains('actif')) closeVideo();
  });
})();
