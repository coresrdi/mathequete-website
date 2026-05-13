/**
 * Envoi d'emails transactionnels via Resend (DEC-34).
 * https://resend.com/docs/api-reference/emails/send-email
 *
 * Templates :
 *   - licence_emise : envoyé après achat Stripe, contient code + lien jeu
 *   - rappel_expiration : J-30 avant expiration (cron Worker — Phase ultérieure)
 */

import type { Env } from './types';

export interface ResendResponse {
  id?: string;
  error?: { message: string; name: string };
}

export interface DonneesLicenceEmise {
  email: string;
  nom?: string;
  code_affiche: string;          // MQ-CLAS-XXXX-XXXX-XXXX-XXXX
  tier: string;                  // classe_petite, etc.
  nb_eleves_max: number;
  expire_le: number;             // timestamp Unix
  montant_paye_cad: number;      // total TTC en CAD
}

/* ===== Helpers ===== */

function formaterDate(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('fr-CA', {
    year: 'numeric', month: 'long', day: 'numeric'
  });
}

function formaterCAD(montant: number): string {
  return montant.toLocaleString('fr-CA', {
    style: 'currency', currency: 'CAD', minimumFractionDigits: 2
  });
}

function nomTierLisible(tier: string): string {
  const map: Record<string, string> = {
    'classe_petite':   'Classe Petite (30 élèves)',
    'classe_moyenne':  'Classe Moyenne (100 élèves)',
    'petite_ecole':    'Petite École (300 élèves)',
    'ecole_standard':  'École Standard (500 élèves)',
    'grande_ecole':    'Grande École (1000 élèves)',
    'mega_ecole':      'Méga École (1300 élèves)'
  };
  return map[tier] ?? tier;
}

/* ===== Template HTML licence émise ===== */

export function renderEmailLicenceEmise(d: DonneesLicenceEmise): string {
  const dateExpire = formaterDate(d.expire_le);
  const montant = formaterCAD(d.montant_paye_cad);
  const nomTier = nomTierLisible(d.tier);
  const bonjour = d.nom ? `Bonjour ${d.nom},` : 'Bonjour,';

  return `<!DOCTYPE html>
<html lang="fr-CA">
<head><meta charset="UTF-8"><title>Votre licence Mathéquête</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#f8fafc; padding:20px; margin:0; color:#0f172a;">

  <div style="max-width:600px; margin:0 auto; background:white; border-radius:12px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,0.05);">

    <div style="background:linear-gradient(135deg,#2563eb,#1e40af); color:white; padding:32px; text-align:center;">
      <h1 style="margin:0; font-size:28px;">★ Bienvenue sur Mathéquête</h1>
      <p style="margin:8px 0 0; opacity:0.9;">Votre licence est prête</p>
    </div>

    <div style="padding:32px;">

      <p>${bonjour}</p>

      <p>
        Merci pour votre achat. Voici votre code de licence pour
        <strong>${nomTier}</strong> :
      </p>

      <div style="background:#f1f5f9; border:2px dashed #2563eb; border-radius:8px; padding:24px; text-align:center; margin:24px 0;">
        <code style="font-size:22px; font-weight:700; letter-spacing:2px; color:#1e40af;">
          ${d.code_affiche}
        </code>
      </div>

      <h3 style="color:#1e40af;">Comment activer la licence</h3>
      <ol style="line-height:1.8;">
        <li>Téléchargez Mathéquête sur Google Play (Android) si pas déjà fait.</li>
        <li>Dans le jeu, ouvrez le menu <strong>Réglages</strong>.</li>
        <li>Touchez <strong>Activer une licence</strong>.</li>
        <li>Tapez le code ci-dessus (vous pouvez aussi le copier-coller).</li>
        <li>La licence active immédiatement les 8 continents et le mode prof
            pour <strong>${d.nb_eleves_max} élèves</strong>.</li>
      </ol>

      <h3 style="color:#1e40af;">Détails de la licence</h3>
      <table style="width:100%; border-collapse:collapse;">
        <tr><td style="padding:8px 0; border-bottom:1px solid #e2e8f0;"><strong>Type</strong></td>
            <td style="padding:8px 0; border-bottom:1px solid #e2e8f0; text-align:right;">${nomTier}</td></tr>
        <tr><td style="padding:8px 0; border-bottom:1px solid #e2e8f0;"><strong>Élèves max</strong></td>
            <td style="padding:8px 0; border-bottom:1px solid #e2e8f0; text-align:right;">${d.nb_eleves_max}</td></tr>
        <tr><td style="padding:8px 0; border-bottom:1px solid #e2e8f0;"><strong>Valide jusqu'au</strong></td>
            <td style="padding:8px 0; border-bottom:1px solid #e2e8f0; text-align:right;">${dateExpire}</td></tr>
        <tr><td style="padding:8px 0;"><strong>Montant payé</strong></td>
            <td style="padding:8px 0; text-align:right;">${montant} CAD</td></tr>
      </table>

      <div style="background:#fef3c7; border-left:4px solid #f59e0b; padding:16px; margin:24px 0; border-radius:4px;">
        <strong>★ Astuce</strong> : Le code et la liste détaillée sont aussi en
        pièces jointes (PDF + CSV) pour faciliter la distribution en classe.
      </div>

      <p style="margin-top:32px;">
        Une question ? Répondez directement à ce courriel ou écrivez à
        <a href="mailto:contact@mathequete.com">contact@mathequete.com</a>.
      </p>

      <p>
        Bonne aventure mathématique,<br>
        <strong>L'équipe Mathéquête</strong>
      </p>

    </div>

    <div style="background:#0f172a; color:#94a3b8; padding:20px; text-align:center; font-size:13px;">
      Mathéquête — Fait avec ★ au Québec<br>
      <a href="https://mathequete.com" style="color:#f59e0b; text-decoration:none;">mathequete.com</a> ·
      <a href="mailto:contact@mathequete.com" style="color:#f59e0b; text-decoration:none;">contact@mathequete.com</a>
    </div>

  </div>

</body>
</html>`;
}

/* ===== Génération CSV simple ===== */

export function genererCSV(d: DonneesLicenceEmise): string {
  const dateExpire = formaterDate(d.expire_le);
  const lignes = [
    'Champ,Valeur',
    `Code de licence,${d.code_affiche}`,
    `Type,${nomTierLisible(d.tier)}`,
    `Élèves max,${d.nb_eleves_max}`,
    `Valide jusqu'au,${dateExpire}`,
    `Email acheteur,${d.email}`,
    `Date émission,${new Date().toISOString()}`
  ];
  return lignes.join('\n');
}

/* ===== Appel Resend ===== */

export async function envoyerLicenceEmise(
  env: Env,
  d: DonneesLicenceEmise
): Promise<ResendResponse> {
  const html = renderEmailLicenceEmise(d);
  const csv = genererCSV(d);
  const csvB64 = btoa(unescape(encodeURIComponent(csv)));

  const body = {
    from: `${env.RESEND_FROM_NAME} <${env.RESEND_FROM_EMAIL}>`,
    to: [d.email],
    subject: `★ Votre licence Mathéquête : ${d.code_affiche}`,
    html: html,
    attachments: [
      {
        filename: `mathequete-licence-${d.code_affiche}.csv`,
        content: csvB64
      }
      // Le PDF est optionnel à cette étape : Resend ne génère pas de PDF.
      // Pour ajouter un PDF, soit on l'inclut depuis un Worker secondaire,
      // soit on le stocke dans R2 et on met un lien dans l'email.
    ]
  };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await res.json() as ResendResponse;
  if (!res.ok) {
    console.error('[Resend] échec envoi :', data);
  }
  return data;
}
