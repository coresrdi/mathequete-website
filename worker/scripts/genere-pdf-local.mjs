// ─────────────────────────────────────────────────────────────────────────────
// genere-pdf-local.mjs
//
// Genere localement (Node 18+) le PDF d'un forfait ecole > 100 QR (D8).
// Reutilise le helper isomorphe `pdf-gen.ts` du worker.
//
// Workflow type :
//   1. Recuperer les cles QR du forfait :
//        cd worker
//        npx wrangler d1 execute mathequete-db --remote ^
//          --command "SELECT cle_qr FROM licences_qr WHERE forfait_ecole_id = 12 ORDER BY numero_sequence" ^
//          --json > cles_forfait_12.json
//
//   2. Recuperer les infos du forfait :
//        curl https://mathequete-api.coresrdi.workers.dev/api/admin/forfaits/12 ^
//          -H "X-Admin-Token: %MATHEQUETE_ADMIN_TOKEN%" > info_forfait_12.json
//
//   3. Generer le PDF (npx tsx pour resoudre l'import .ts) :
//        npx tsx scripts/genere-pdf-local.mjs --forfait 12 ^
//             --cles cles_forfait_12.json ^
//             --info info_forfait_12.json ^
//             --out  codes-qr-forfait-12.pdf
//
//      tsx est deja installe via wrangler ; sinon : npm i -D tsx
//
//   4. Uploader vers R2 via le Worker :
//        powershell .\scripts\upload-pdf-forfait.ps1 -ForfaitId 12 ^
//                   -PdfPath .\codes-qr-forfait-12.pdf
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { genererPdfForfait } from '../src/pdf-gen.ts';

const { values } = parseArgs({
  options: {
    forfait: { type: 'string' },
    cles:    { type: 'string' },
    info:    { type: 'string' },
    out:     { type: 'string' }
  }
});

if (!values.forfait || !values.cles || !values.info || !values.out) {
  console.error('Usage: node genere-pdf-local.mjs --forfait N --cles cles.json --info info.json --out fichier.pdf');
  process.exit(1);
}

// 1. Lecture cles QR (sortie wrangler d1 execute --json)
const clesRaw = JSON.parse(await readFile(values.cles, 'utf-8'));
// wrangler retourne soit [{results:[...]}], soit {results:[...]}, selon version
const lignes = Array.isArray(clesRaw)
  ? (clesRaw[0]?.results ?? clesRaw)
  : (clesRaw.results ?? []);
const cles = lignes.map(r => r.cle_qr);
if (cles.length === 0) {
  console.error('Aucune cle QR trouvee dans', values.cles);
  process.exit(2);
}

// 2. Lecture infos forfait (sortie GET /api/admin/forfaits/{id})
const infoRaw = JSON.parse(await readFile(values.info, 'utf-8'));
const f = infoRaw.forfait;
if (!f || f.id !== Number(values.forfait)) {
  console.error('Mismatch forfait_id dans info.json');
  process.exit(3);
}
if (f.nb_licences_total !== cles.length) {
  console.error(`Mismatch nombre cles : ${cles.length} vs ${f.nb_licences_total} attendues`);
  process.exit(4);
}

const infos = {
  ecole_nom:  f.ecole_nom,
  code_court: f.code_court,
  tier_nom:   f.tier_nom,
  produit_nom:'Continent 1',
  nb_licences:f.nb_licences_total,
  email_admin:f.email_admin,
  date_achat: f.date_achat
};

console.log(`[genere-pdf-local] forfait #${f.id} : ${cles.length} cles QR -> ${values.out}`);
const t0 = Date.now();
const bytes = await genererPdfForfait(infos, cles);
const elapsed = Date.now() - t0;
await writeFile(values.out, bytes);
console.log(`[genere-pdf-local] OK : ${bytes.length} octets en ${elapsed} ms.`);
console.log(`Suite : .\\scripts\\upload-pdf-forfait.ps1 -ForfaitId ${f.id} -PdfPath ${values.out}`);
