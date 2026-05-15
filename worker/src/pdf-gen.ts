/* Sprint PB1 — Génération du PDF de licences QR (décision D5 + D8).
 *
 * Format :
 *   - A4 portrait (595 × 842 pt)
 *   - Page de garde : récap commande, code école, lien portail futur
 *   - Pages suivantes : grille 5×5 = 25 QR par page
 *   - Chaque cellule : QR code (≈ 90 pt côté) + clé courte XXXX-XXXX-XXXX
 *     + numéro de séquence (« 247/1000 »)
 *
 * Cf. D8 : appelé soit depuis le webhook via `ctx.waitUntil()` pour les
 * petits forfaits (≤ 100 QR), soit depuis un script Node local pour les
 * gros forfaits (manuel). Le helper reste isomorphe (Workers + Node 18+).
 *
 * Dépendances NPM :
 *   - pdf-lib : génération PDF (isomorphe, pas de canvas)
 *   - qrcode  : génération des matrices QR (mode 'binary' pour Workers)
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';
import { formaterCleQrAffichage } from './qr-gen';

/** Préfixe magique du payload QR Mathéquête. */
export const MAGIC_PREFIX_ACTIVATION = 'MQA:v1';

/** Construit le payload texte encodé dans le QR scanné.
 *  Format : `MQA:v1:{cle_qr_brute}:{code_classe?}`
 *  Le code classe peut être omis pour les licences individuelles.
 */
export function payloadQrActivation(cleQrBrute: string, codeClasse?: string): string {
  return codeClasse
    ? `${MAGIC_PREFIX_ACTIVATION}:${cleQrBrute}:${codeClasse}`
    : `${MAGIC_PREFIX_ACTIVATION}:${cleQrBrute}`;
}

/** Métadonnées d'un forfait pour le PDF. */
export interface InfosForfaitPdf {
  ecole_nom: string;
  code_court: string;        // ex: 'vjolie'
  tier_nom: string;          // ex: 'Grande École'
  produit_nom: string;       // ex: 'Continent 1'
  nb_licences: number;
  email_admin: string;
  date_achat: number;        // unix epoch
}

/** Génère le PDF complet pour un forfait école et retourne le buffer.
 *  À uploader ensuite vers R2 et lier dans `forfaits_ecole.pdf_r2_path`.
 */
export async function genererPdfForfait(
  infos: InfosForfaitPdf,
  clesQr: string[],         // 12 chars chacune (sans tirets), dans l'ordre 1..N
  options: { code_classe_suggere?: string } = {}
): Promise<Uint8Array> {
  if (clesQr.length !== infos.nb_licences) {
    throw new Error(`genererPdfForfait: ${clesQr.length} clés ≠ ${infos.nb_licences} licences`);
  }

  const pdf = await PDFDocument.create();
  pdf.setTitle(`Mathéquête — ${infos.tier_nom} — ${infos.ecole_nom}`);
  pdf.setAuthor('Mathéquête (CORES RDI)');
  pdf.setSubject(`Licences QR pour ${infos.ecole_nom} (code: ${infos.code_court})`);
  pdf.setCreator('mathequete-worker');
  pdf.setProducer('mathequete-worker + pdf-lib');
  pdf.setCreationDate(new Date());

  const fontReg = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const fontMono = await pdf.embedFont(StandardFonts.Courier);

  // === Page de garde ===
  await dessinerPageDeGarde(pdf, fontReg, fontBold, infos, options.code_classe_suggere);

  // === Pages de QR (grille 5×5) ===
  const QR_PAR_PAGE = 25;
  const nbPagesQr = Math.ceil(clesQr.length / QR_PAR_PAGE);
  for (let p = 0; p < nbPagesQr; p++) {
    const debut = p * QR_PAR_PAGE;
    const fin = Math.min(debut + QR_PAR_PAGE, clesQr.length);
    const tranche = clesQr.slice(debut, fin);
    await dessinerPageGrille(pdf, fontMono, fontReg, infos, tranche, debut, p + 1, nbPagesQr);
  }

  return await pdf.save();
}

/* ---------- Internes ---------- */

/** Dessine la page de garde (1 page). */
async function dessinerPageDeGarde(
  pdf: PDFDocument,
  fontReg: PDFFont,
  fontBold: PDFFont,
  infos: InfosForfaitPdf,
  codeClasseSuggere?: string
): Promise<void> {
  const page = pdf.addPage([595.28, 841.89]); // A4 portrait en points
  const { width, height } = page.getSize();
  const noir = rgb(0.1, 0.1, 0.15);
  const bleu = rgb(0.13, 0.30, 0.59);
  const gris = rgb(0.45, 0.45, 0.50);

  // Titre principal
  page.drawText('Mathéquête', {
    x: 50, y: height - 80,
    font: fontBold, size: 32, color: bleu
  });
  page.drawText('Vos licences QR sont prêtes', {
    x: 50, y: height - 115,
    font: fontReg, size: 16, color: noir
  });

  // Cartouche école
  const yCartouche = height - 200;
  page.drawRectangle({
    x: 50, y: yCartouche - 130, width: width - 100, height: 150,
    borderColor: bleu, borderWidth: 1.5, color: rgb(0.96, 0.97, 1.0)
  });
  page.drawText('École :', { x: 70, y: yCartouche - 10, font: fontBold, size: 11, color: gris });
  page.drawText(infos.ecole_nom, { x: 150, y: yCartouche - 10, font: fontReg, size: 13, color: noir });

  page.drawText('Code école :', { x: 70, y: yCartouche - 35, font: fontBold, size: 11, color: gris });
  page.drawText(infos.code_court, { x: 150, y: yCartouche - 35, font: fontBold, size: 16, color: bleu });

  page.drawText('Forfait :', { x: 70, y: yCartouche - 60, font: fontBold, size: 11, color: gris });
  page.drawText(`${infos.tier_nom} — ${infos.produit_nom}`,
    { x: 150, y: yCartouche - 60, font: fontReg, size: 12, color: noir });

  page.drawText('Licences :', { x: 70, y: yCartouche - 85, font: fontBold, size: 11, color: gris });
  page.drawText(`${infos.nb_licences} QR distincts`,
    { x: 150, y: yCartouche - 85, font: fontReg, size: 12, color: noir });

  page.drawText('Admin :', { x: 70, y: yCartouche - 110, font: fontBold, size: 11, color: gris });
  page.drawText(infos.email_admin, { x: 150, y: yCartouche - 110, font: fontReg, size: 11, color: noir });

  // Instructions
  const yInstr = yCartouche - 180;
  page.drawText('Comment utiliser ces licences', { x: 50, y: yInstr, font: fontBold, size: 14, color: noir });
  const lignes = [
    '1. Découpez les feuilles selon les pointillés pour obtenir des cartes individuelles.',
    `2. Donnez à chaque enseignant un lot de cartes selon le nombre d'élèves de sa classe.`,
    `3. Chaque enseignant crée sa classe dans l'app Prof Mathéquête (code école : ${infos.code_court}).`,
    `4. L'enseignant scanne ses cartes pour les rattacher à sa classe.`,
    '5. Chaque élève scanne sa carte avec le jeu Mathéquête sur sa tablette pour activer.',
    '',
    '⚠ Important : chaque carte QR est unique et liée à un appareil après activation.',
    'Conservez les cartes non distribuées en sécurité.'
  ];
  let y = yInstr - 25;
  for (const ligne of lignes) {
    page.drawText(ligne, { x: 50, y, font: fontReg, size: 11, color: noir });
    y -= 18;
  }

  if (codeClasseSuggere) {
    page.drawText('Exemple de code classe :', { x: 50, y: y - 20, font: fontBold, size: 11, color: gris });
    page.drawText(codeClasseSuggere, { x: 50, y: y - 38, font: fontBold, size: 14, color: bleu });
  }

  // Pied de page
  const dateStr = new Date(infos.date_achat * 1000).toLocaleDateString('fr-CA');
  page.drawText(`Émis le ${dateStr} — CORES RDI — mathequete.ca`, {
    x: 50, y: 40, font: fontReg, size: 9, color: gris
  });
}

/** Dessine une page de grille 5×5 (jusqu'à 25 QR). */
async function dessinerPageGrille(
  pdf: PDFDocument,
  fontMono: PDFFont,
  fontReg: PDFFont,
  infos: InfosForfaitPdf,
  cles: string[],
  decalageSeq: number,       // index de la 1ère clé de la page (0-based)
  numPage: number,
  totalPages: number
): Promise<void> {
  const page = pdf.addPage([595.28, 841.89]);
  const { width, height } = page.getSize();
  const noir = rgb(0.1, 0.1, 0.15);
  const gris = rgb(0.55, 0.55, 0.60);

  // En-tête léger
  page.drawText(`Mathéquête — ${infos.ecole_nom} (${infos.code_court})`, {
    x: 30, y: height - 25, font: fontReg, size: 9, color: gris
  });
  page.drawText(`Page ${numPage}/${totalPages}`, {
    x: width - 80, y: height - 25, font: fontReg, size: 9, color: gris
  });

  // Grille 5×5 : marges 20pt, espace utile = 555 × 802, cellule ≈ 111 × 160
  const margeG = 20;
  const margeH = 35;
  const cellW = (width - 2 * margeG) / 5;     // ≈ 111
  const cellH = (height - 2 * margeH - 20) / 5; // ≈ 154
  const qrSize = 90;                            // taille du QR en points

  for (let i = 0; i < cles.length; i++) {
    const row = Math.floor(i / 5);
    const col = i % 5;
    const cellX = margeG + col * cellW;
    const cellY = height - margeH - (row + 1) * cellH;

    // Pointillés de découpe (bordure)
    page.drawRectangle({
      x: cellX, y: cellY, width: cellW, height: cellH,
      borderColor: rgb(0.75, 0.75, 0.78), borderWidth: 0.3,
      borderDashArray: [2, 2]
    });

    // Génération QR matrice (PNG embed)
    const payload = payloadQrActivation(cles[i]!);
    const qrPngBytes = await genererQrPng(payload, Math.round(qrSize));
    const qrImage = await pdf.embedPng(qrPngBytes);

    const qrX = cellX + (cellW - qrSize) / 2;
    const qrY = cellY + cellH - qrSize - 12;
    page.drawImage(qrImage, { x: qrX, y: qrY, width: qrSize, height: qrSize });

    // Clé courte lisible
    const cleAffichage = formaterCleQrAffichage(cles[i]!);
    page.drawText(cleAffichage, {
      x: cellX + (cellW - fontMono.widthOfTextAtSize(cleAffichage, 9)) / 2,
      y: cellY + 22, font: fontMono, size: 9, color: noir
    });

    // Numéro de séquence
    const seqStr = `${decalageSeq + i + 1}/${infos.nb_licences}`;
    page.drawText(seqStr, {
      x: cellX + (cellW - fontReg.widthOfTextAtSize(seqStr, 8)) / 2,
      y: cellY + 8, font: fontReg, size: 8, color: gris
    });
  }
}

/** Génère un PNG QR depuis une string. Utilise la lib qrcode en mode 'png'. */
async function genererQrPng(payload: string, taillePx: number): Promise<Uint8Array> {
  // toBuffer renvoie un Node Buffer côté Node ; côté Workers, on utilise
  // toDataURL puis on extrait les bytes du base64. Mais qrcode v1.5+ supporte
  // également `toBuffer` côté Workers via le polyfill nodejs_compat (activé
  // dans wrangler.toml). On reste prudent avec toDataURL pour portabilité.
  const dataUrl = await QRCode.toDataURL(payload, {
    type: 'image/png',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: taillePx,
    color: { dark: '#000000', light: '#FFFFFF' }
  });
  const base64 = dataUrl.split(',')[1] ?? '';
  return base64DecodeToBytes(base64);
}

/** Décode un base64 vers Uint8Array (isomorphe Workers + Node 18+). */
function base64DecodeToBytes(b64: string): Uint8Array {
  // atob est dispo nativement dans Workers et Node 18+.
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
