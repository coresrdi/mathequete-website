/**
 * Envoi d'emails transactionnels via Resend (DEC-34).
 * https://resend.com/docs/api-reference/emails/send-email
 *
 * Templates :
 *   - licence_emise : envoyé après achat Stripe, contient code(s) + lien jeu
 *     Supporte les achats simples (1 code) et les Packs (N codes, Sprint S3.C)
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
  codes_affiches: string[];      // 1 code (individuelle/école) ou 5 codes (Pack 5)
  tier: string;                  // classe_petite, etc.
  nb_eleves_max: number;
  expire_le: number;             // timestamp Unix (0 = à vie)
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
    'continent_1':         'Continent 1 — Individuelle (1 appareil)',
    'pack_5_continent_1':  'Continent 1 — Pack 5 (5 codes, 5 appareils)',
    'classe_petite':       'Classe Petite (30 élèves)',
    'classe_moyenne':      'Classe Moyenne (100 élèves)',
    'petite_ecole':        'Petite École (300 élèves)',
    'ecole_standard':      'École Standard (500 élèves)',
    'grande_ecole':        'Grande École (1000 élèves)',
    'mega_ecole':          'Méga École (1300 élèves)'
  };
  return map[tier] ?? tier;
}

function estTierIndividuel(tier: string): boolean {
  // Individuelle ou Pack 5 — codes à vie, 1 appareil par code
  return tier.startsWith('continent') || tier.startsWith('pack_5_continent');
}

/* ===== Template HTML licence émise ===== */

export function renderEmailLicenceEmise(d: DonneesLicenceEmise): string {
  const dateExpire = formaterDate(d.expire_le);
  const montant = formaterCAD(d.montant_paye_cad);
  const nomTier = nomTierLisible(d.tier);
  const bonjour = d.nom ? `Bonjour ${d.nom},` : 'Bonjour,';
  const estPack = d.codes_affiches.length > 1;
  const titreCode = estPack
    ? `Voici vos ${d.codes_affiches.length} codes de licence pour <strong>${nomTier}</strong> :`
    : `Voici votre code de licence pour <strong>${nomTier}</strong> :`;

  const cadresCodes = d.codes_affiches.map((code, idx) => `
      <div style="background:#f1f5f9; border:2px dashed #2563eb; border-radius:8px; padding:18px; text-align:center; margin:14px 0;">
        ${estPack ? `<div style="font-size:13px; color:#64748b; margin-bottom:6px;">Code ${idx + 1} / ${d.codes_affiches.length}</div>` : ''}
        <code style="font-size:22px; font-weight:700; letter-spacing:2px; color:#1e40af;">${code}</code>
      </div>`).join('');

  return `<!DOCTYPE html>
<html lang="fr-CA">
<head><meta charset="UTF-8"><title>Votre licence Mathéquête</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#f8fafc; padding:20px; margin:0; color:#0f172a;">

  <div style="max-width:600px; margin:0 auto; background:white; border-radius:12px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,0.05);">

    <div style="background:linear-gradient(135deg,#2563eb,#1e40af); color:white; padding:32px; text-align:center;">
      <h1 style="margin:0; font-size:28px;">★ Bienvenue sur Mathéquête</h1>
      <p style="margin:8px 0 0; opacity:0.9;">${estPack ? 'Vos licences sont prêtes' : 'Votre licence est prête'}</p>
    </div>

    <div style="padding:32px;">

      <p>${bonjour}</p>

      <p>Merci pour votre achat. ${titreCode}</p>

      ${cadresCodes}

      <h3 style="color:#1e40af;">Comment activer ${estPack ? 'un code' : 'la licence'}</h3>
      <ol style="line-height:1.8;">
        <li>Téléchargez Mathéquête sur Google Play (Android) ou PC si pas déjà fait.</li>
        <li>Dans le jeu, ouvrez le menu <strong>Réglages</strong>.</li>
        <li>Touchez <strong>Activer une licence</strong>.</li>
        <li>Tapez ${estPack ? "l'un des codes" : 'le code'} ci-dessus (vous pouvez aussi le copier-coller).</li>
        ${estTierIndividuel(d.tier)
          ? `<li>La licence active immédiatement le Continent 1 sur cet appareil${estPack ? ', et chaque code est indépendant (1 appareil chacun)' : ''}.</li>`
          : `<li>La licence active immédiatement les 8 continents et le mode prof
            pour <strong>${d.nb_eleves_max} élèves</strong>.</li>`
        }
      </ol>

      <p style="background:#fef3c7; border-left:4px solid #f59e0b; padding:10px 14px; margin:14px 0; font-size:14px;">
        ${estTierIndividuel(d.tier)
          ? (estPack
            ? `<strong>Bon à savoir :</strong> chaque code est à vie et activable sur 1 seul appareil à la fois
               (Windows, Android, ou bientôt Apple). Vous pouvez transférer un code vers un autre appareil
               depuis le jeu en quelques secondes.`
            : `<strong>Bon à savoir :</strong> cette licence est à vie et valable sur 1 appareil à la fois
               (Windows, Android, ou bientôt Apple). Transférable depuis le jeu en quelques secondes.
               Pour équiper une classe ou une école, découvrez nos packs sur
               <a href="https://mathequete.pages.dev/achat.html">mathequete.pages.dev</a>.`)
          : `<strong>Bon à savoir :</strong> une licence débloque l'appareil au complet.
             Tous les profils enfants créés sur la même tablette / téléphone profitent
             automatiquement des contenus prémium. Pour équiper plusieurs appareils
             (1 par élève), commandez un pack « Classe » ou « École ».`
        }
      </p>

      <h3 style="color:#1e40af;">Détails de l'achat</h3>
      <table style="width:100%; border-collapse:collapse;">
        <tr><td style="padding:8px 0; border-bottom:1px solid #e2e8f0;"><strong>Type</strong></td>
            <td style="padding:8px 0; border-bottom:1px solid #e2e8f0; text-align:right;">${nomTier}</td></tr>
        ${estPack
          ? `<tr><td style="padding:8px 0; border-bottom:1px solid #e2e8f0;"><strong>Nombre de codes</strong></td>
                 <td style="padding:8px 0; border-bottom:1px solid #e2e8f0; text-align:right;">${d.codes_affiches.length}</td></tr>`
          : `<tr><td style="padding:8px 0; border-bottom:1px solid #e2e8f0;"><strong>Élèves max</strong></td>
                 <td style="padding:8px 0; border-bottom:1px solid #e2e8f0; text-align:right;">${d.nb_eleves_max}</td></tr>`
        }
        <tr><td style="padding:8px 0; border-bottom:1px solid #e2e8f0;"><strong>${estTierIndividuel(d.tier) ? 'Validité' : "Valide jusqu'au"}</strong></td>
            <td style="padding:8px 0; border-bottom:1px solid #e2e8f0; text-align:right;">${estTierIndividuel(d.tier) ? 'À vie' : dateExpire}</td></tr>
        <tr><td style="padding:8px 0;"><strong>Montant payé</strong></td>
            <td style="padding:8px 0; text-align:right;">${montant} CAD</td></tr>
      </table>

      <div style="background:#fef3c7; border-left:4px solid #f59e0b; padding:16px; margin:24px 0; border-radius:4px;">
        <strong>★ Astuce</strong> : ${estPack ? 'Tous les codes sont aussi listés dans le CSV joint' : 'Le code et la liste détaillée sont aussi dans le CSV joint'} pour faciliter la distribution.
      </div>

      <p style="margin-top:32px;">
        Une question ? Répondez directement à ce courriel ou écrivez à
        <a href="mailto:coresrdi@gmail.com">coresrdi@gmail.com</a>.
      </p>

      <p>
        Bonne aventure mathématique,<br>
        <strong>L'équipe Mathéquête</strong>
      </p>

    </div>

    <div style="background:#0f172a; color:#94a3b8; padding:20px; text-align:center; font-size:13px;">
      Mathéquête — Fait avec ★ au Québec<br>
      <a href="https://mathequete.pages.dev" style="color:#f59e0b; text-decoration:none;">mathequete.pages.dev</a> ·
      <a href="mailto:coresrdi@gmail.com" style="color:#f59e0b; text-decoration:none;">coresrdi@gmail.com</a>
    </div>

  </div>

</body>
</html>`;
}

/* ===== Génération CSV simple ===== */

export function genererCSV(d: DonneesLicenceEmise): string {
  const dateExpire = estTierIndividuel(d.tier) ? 'À vie' : formaterDate(d.expire_le);
  const lignes = [
    'Champ,Valeur',
    `Type,${nomTierLisible(d.tier)}`,
    `Nombre de codes,${d.codes_affiches.length}`,
    ...d.codes_affiches.map((c, i) => `Code ${i + 1},${c}`),
    `Élèves max par code,${d.nb_eleves_max}`,
    `Validité,${dateExpire}`,
    `Email acheteur,${d.email}`,
    `Date émission,${new Date().toISOString()}`
  ];
  return lignes.join('\n');
}

/* ===== Sprint S2 : Email notification admin pour demande d'activation manuelle ===== */

export interface DonneesNotificationAdmin {
  requestId: string;
  magicToken: string;
  code: string;
  codeLabel: string;
  utilisationsRestantes: number;
  email: string;
  nom: string;
  message: string;
  ipPays: string;
}

export async function envoyerEmailNotificationAdmin(
  env: Env,
  d: DonneesNotificationAdmin
): Promise<ResendResponse> {
  const baseUrl = env.ENVIRONMENT === 'production'
    ? 'https://mathequete-api.coresrdi.workers.dev'
    : 'http://localhost:8787';
  const lienDecision = `${baseUrl}/admin/decide?token=${encodeURIComponent(d.magicToken)}`;

  const html = `<!DOCTYPE html>
<html lang="fr-CA">
<head><meta charset="UTF-8"><title>Demande activation Mathequete</title></head>
<body style="font-family: -apple-system, sans-serif; background:#f8fafc; padding:20px; margin:0; color:#0f172a;">
  <div style="max-width:600px; margin:0 auto; background:white; border-radius:12px; overflow:hidden;">
    <div style="background:#1e40af; color:white; padding:20px; text-align:center;">
      <h2 style="margin:0;">Nouvelle demande d'activation</h2>
    </div>
    <div style="padding:24px;">
      <p><strong>Code utilise :</strong> <code>${escapeHtml(d.code)}</code> (${escapeHtml(d.codeLabel)})</p>
      <p><strong>Activations restantes apres celle-ci :</strong> ${d.utilisationsRestantes}</p>
      <hr>
      <p><strong>Joueur :</strong> ${escapeHtml(d.nom)}</p>
      <p><strong>Email :</strong> <a href="mailto:${escapeHtml(d.email)}">${escapeHtml(d.email)}</a></p>
      <p><strong>Pays :</strong> ${escapeHtml(d.ipPays)}</p>
      <p><strong>Message :</strong></p>
      <blockquote style="background:#f1f5f9; padding:12px; border-left:4px solid #2563eb; margin:8px 0;">
        ${escapeHtml(d.message || '(aucun message)')}
      </blockquote>
      <hr>
      <p style="text-align:center; margin:24px 0;">
        <a href="${lienDecision}"
           style="display:inline-block; background:#2563eb; color:white; padding:14px 28px; border-radius:8px; text-decoration:none; font-weight:600; font-size:16px;">
          Decider (approuver / refuser)
        </a>
      </p>
      <p style="font-size:12px; color:#64748b; text-align:center;">
        Lien valide 24h. Request ID : <code>${escapeHtml(d.requestId)}</code>
      </p>
    </div>
  </div>
</body></html>`;

  const body = {
    from: `${env.RESEND_FROM_NAME} <${env.RESEND_FROM_EMAIL}>`,
    to: ['coresrdi@gmail.com'],
    subject: `[Mathequete] Demande activation - ${d.nom} (${d.code})`,
    html: html
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
    console.error('[Resend admin] echec envoi :', data);
  }
  return data;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]!);
}

/* ===== Email licence emise ===== */

export async function envoyerLicenceEmise(
  env: Env,
  d: DonneesLicenceEmise
): Promise<ResendResponse> {
  const html = renderEmailLicenceEmise(d);
  const csv = genererCSV(d);
  const csvB64 = btoa(unescape(encodeURIComponent(csv)));

  const estPack = d.codes_affiches.length > 1;
  const sujet = estPack
    ? `★ Vos ${d.codes_affiches.length} licences Mathéquête (Pack 5)`
    : `★ Votre licence Mathéquête : ${d.codes_affiches[0]}`;
  const filename = estPack
    ? `mathequete-licences-pack5.csv`
    : `mathequete-licence-${d.codes_affiches[0]}.csv`;

  const body = {
    from: `${env.RESEND_FROM_NAME} <${env.RESEND_FROM_EMAIL}>`,
    to: [d.email],
    subject: sujet,
    html: html,
    attachments: [
      {
        filename: filename,
        content: csvB64
      }
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
