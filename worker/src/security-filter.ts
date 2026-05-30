/**
 * security-filter.ts — Filtrage applicatif anti-scanner (PR du 2026-05-17)
 *
 * Contexte
 * --------
 * Le 16 mai 2026, le dashboard Cloudflare a montré un pic isolé de ~1.19k
 * requêtes en provenance de 185.177.72.51 (AS211590 Bucklog SARL / FBW Networks,
 * Paris). User-Agent : curl/8.7.1. Paths typiques : /.env, /.git/*, /wp-login.php,
 * /xmlrpc.php, /administrator/.env, /vendor/.env, /laravel/.env.local, etc.
 *
 * → Scanner automatisé hostile cherchant des fichiers de config exposés.
 *
 * Pourquoi côté Worker (et non WAF Cloudflare)
 * --------------------------------------------
 *   - Historique : l'API tournait sur *.workers.dev (pas de zone DNS a nous).
 *   - Depuis le 30 mai 2026, l'API est sur api.mathequete.com (zone Cloudflare
 *     proprietaire mathequete.com). Bot Fight Mode / IP Access Rules / Custom WAF
 *     deviennent donc disponibles cote Cloudflare.
 *   - TODO : activer Bot Fight Mode + regles WAF sur la zone mathequete.com ;
 *     cette fonction de filtrage applicatif pourra alors etre allegee/desactivee.
 *
 * Stratégie
 * ---------
 *   1. Bloquer la plage CIDR 185.177.72.0/24 (scanner identifié).
 *   2. Bloquer les chemins de scan évidents qui n'existent pas chez nous
 *      (.env, .git, wp-login, xmlrpc, /administrator, /vendor/, /laravel/).
 *   3. Retourner 403 sans body verbeux pour ne pas aider l'attaquant.
 *
 * Ce filtre s'exécute AVANT le routing métier et AVANT le rate-limit, donc
 * coût quasi nul (string match + Set lookup). Aucune dépendance D1/R2.
 *
 * Tests : voir worker/src/security-filter.test.ts (à ajouter si suite de tests).
 */

/** IPs unitaires explicitement bloquées (snapshot 2026-05-17). */
const BLOCKED_IPS: ReadonlySet<string> = new Set<string>([
  // Scanner observé le 16/05/2026 (1.19k req)
  '185.177.72.51'
]);

/**
 * Préfixes CIDR /24 bloqués (test rapide via startsWith).
 * Format : "X.Y.Z." (trailing dot obligatoire pour éviter les faux positifs).
 */
const BLOCKED_IP_PREFIXES: readonly string[] = [
  // AS211590 Bucklog / FBW Networks (Paris) — plage entière marquée
  // malveillante par AbuseIPDB + StopForumSpam.
  '185.177.72.'
];

/**
 * Regex de chemins de scan classiques. On reste large mais ciblé :
 * aucun endpoint légitime de l'API Mathéquête ne contient ces tokens.
 *
 * Endpoints légitimes audités au 2026-05-17 :
 *   /health, /create-checkout-session, /stripe-webhook,
 *   /api/commissions/*, /api/pdf/{id}, /admin/forfaits, /admin/qr-manuel,
 *   /api/admin/*, /api/activation/*, /api/release-device, /api/stats/*,
 *   /api/prof/*, /api/eleves/*, /api/jeu/*, /api/webhook/school
 *
 * Aucun ne contient .env / .git / wp-login / xmlrpc / /administrator
 * / /vendor/ / /laravel — donc bloquer ces tokens est safe.
 */
const SCAN_PATH_REGEX =
  /(\.env|\.git(\/|$)|wp-login|xmlrpc|\/administrator(\/|$)|\/vendor\/|\/laravel(\/|$)|\.aws\/|\/phpmyadmin|\/wp-admin|\/wp-content)/i;

export interface SecurityFilterResult {
  /** true si la requête doit être bloquée. */
  block: boolean;
  /** Raison machine (pour logs). */
  reason?: 'ip' | 'ip_prefix' | 'scan_path';
}

/**
 * Évalue une requête entrante. Lecture seule, pas d'effet de bord.
 *
 * @param request Requête Worker (Cloudflare).
 * @returns Décision de filtrage.
 */
export function evaluateSecurityFilter(request: Request): SecurityFilterResult {
  // CF-Connecting-IP est l'IP client réelle vue par Cloudflare.
  // (toujours présent sur un Worker derrière CF, vide en local/test).
  const ip = request.headers.get('CF-Connecting-IP') || '';

  if (ip && BLOCKED_IPS.has(ip)) {
    return { block: true, reason: 'ip' };
  }

  if (ip) {
    for (const prefix of BLOCKED_IP_PREFIXES) {
      if (ip.startsWith(prefix)) {
        return { block: true, reason: 'ip_prefix' };
      }
    }
  }

  let pathname = '';
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    // URL invalide → on laisse passer pour ne pas masquer un bug applicatif.
    return { block: false };
  }

  if (SCAN_PATH_REGEX.test(pathname)) {
    return { block: true, reason: 'scan_path' };
  }

  return { block: false };
}

/**
 * Réponse 403 standardisée pour les requêtes bloquées.
 * Corps minimal — on ne donne aucun indice à l'attaquant.
 */
export function buildBlockedResponse(): Response {
  return new Response('Forbidden', {
    status: 403,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      // Pas de CORS ici : si c'est un scan, on n'a pas à coopérer.
      'Cache-Control': 'no-store'
    }
  });
}
