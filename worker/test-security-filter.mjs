/**
 * Smoke test pour security-filter (lance avec : node test-security-filter.mjs).
 * Pas de framework — assertions natives, sort 0 si tout passe.
 */
// Avant exécution locale, builder le module :
//   npx esbuild src/security-filter.ts --bundle --format=esm --platform=neutral --outfile=/tmp/sf.mjs
// puis : node test-security-filter.mjs
import { evaluateSecurityFilter, buildBlockedResponse } from '/tmp/sf.mjs';
// NB: si Node refuse le .ts en import direct, on testera via TypeScript
// pendant le CI Wrangler — ce smoke est surtout là pour validation manuelle.

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else      { console.error(`  ✗ ${name}`); fail++; }
}

function req(url, ip) {
  const headers = new Headers();
  if (ip) headers.set('CF-Connecting-IP', ip);
  return new Request(url, { headers });
}

console.log('security-filter smoke tests');

// IP exacte bloquée
check('185.177.72.51 → block (ip)',
  evaluateSecurityFilter(req('https://x/health', '185.177.72.51')).block === true);

// Plage /24 bloquée
check('185.177.72.200 → block (ip_prefix)',
  evaluateSecurityFilter(req('https://x/health', '185.177.72.200')).block === true);

// IP voisine hors plage → laissée passer
check('185.177.73.5 → allow',
  evaluateSecurityFilter(req('https://x/health', '185.177.73.5')).block === false);

// Chemin scan
check('/.env → block (scan_path)',
  evaluateSecurityFilter(req('https://x/.env', '8.8.8.8')).block === true);
check('/laravel/.env.local → block',
  evaluateSecurityFilter(req('https://x/laravel/.env.local', '8.8.8.8')).block === true);
check('/administrator/.env → block',
  evaluateSecurityFilter(req('https://x/administrator/.env', '8.8.8.8')).block === true);
check('/wp-login.php → block',
  evaluateSecurityFilter(req('https://x/wp-login.php', '8.8.8.8')).block === true);
check('/.git/config → block',
  evaluateSecurityFilter(req('https://x/.git/config', '8.8.8.8')).block === true);

// Endpoints légitimes Mathéquête → tous PASS
const legit = [
  '/health',
  '/create-checkout-session',
  '/stripe-webhook',
  '/api/commissions/autocomplete',
  '/api/pdf/123',
  '/admin/forfaits',
  '/api/admin/forfaits/en-attente',
  '/api/activation/redeem',
  '/api/stats/push',
  '/api/prof/signup',
  '/api/eleves/list',
  '/api/jeu/heartbeat'
];
for (const p of legit) {
  check(`legit ${p} → allow`,
    evaluateSecurityFilter(req('https://x' + p, '8.8.8.8')).block === false);
}

// buildBlockedResponse renvoie 403
const r = buildBlockedResponse();
check('buildBlockedResponse status 403', r.status === 403);

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
