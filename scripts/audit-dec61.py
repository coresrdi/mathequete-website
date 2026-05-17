#!/usr/bin/env python3
"""
Audit automatique de conformité DEC-61 (registre Mathéquête v4.15).

Vérifie que `site/enseignants.html` reste strictement informationnelle :
    1. Aucun lien vers achat.html, guide-prof.html, ou pages d'achat futures
    2. Aucune mention de prix / tarif / palier / forfait dans le contenu
    3. Aucun bouton « Acheter » / « Commander » / « Payer » dans le contenu
    4. La nav supérieure ne contient qu'UN seul lien (vers index.html)

Les commentaires HTML <!-- ... --> (doc d'audit en tête de fichier) sont
ignorés. Seul le contenu rendu à l'utilisateur compte.

Usage :
    python3 scripts/audit-dec61.py
    # exit 0 si conforme, exit 1 sinon

À intégrer en pre-commit hook ou GitHub Actions au moment voulu.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENSEIGNANTS = ROOT / 'site' / 'enseignants.html'

def main() -> int:
    if not ENSEIGNANTS.is_file():
        print(f'❌ Fichier introuvable : {ENSEIGNANTS}')
        return 1

    html = ENSEIGNANTS.read_text(encoding='utf-8')

    # Strip HTML comments (multi-line aware)
    rendered = re.sub(r'<!--.*?-->', '', html, flags=re.DOTALL)

    fails = []

    # Test 1 : liens interdits dans le contenu
    liens_interdits_re = re.compile(
        r'<a\s[^>]*href="(achat|forfaits-ecole|pack-familial|promo|guide-prof)',
        re.IGNORECASE
    )
    hits_liens = liens_interdits_re.findall(rendered)
    if hits_liens:
        fails.append(f'Liens interdits trouvés : {hits_liens}')
    else:
        print('✅ Test 1 : aucun lien interdit dans le contenu')

    # Test 2 : mention de prix
    prix_re = re.compile(r'\$|CAD|tarif|palier|forfait', re.IGNORECASE)
    hits_prix = [
        line.strip() for line in rendered.split('\n')
        if prix_re.search(line)
    ]
    if hits_prix:
        fails.append(f'Mentions de prix : {hits_prix[:3]}')
    else:
        print('✅ Test 2 : aucune mention de prix dans le contenu')

    # Test 3 : boutons "Acheter"
    ach_re = re.compile(r'acheter|achat|commande|payer|stripe', re.IGNORECASE)
    hits_ach = [
        line.strip() for line in rendered.split('\n')
        if ach_re.search(line) and 'mailto:' not in line
    ]
    if hits_ach:
        fails.append(f'CTA d\'achat dans le contenu : {hits_ach[:3]}')
    else:
        print('✅ Test 3 : aucun CTA d\'achat dans le contenu')

    # Test 4 : la nav doit pointer UNIQUEMENT vers index.html
    # (logo + bouton textuel = 2 liens, mais tous deux vers la même destination)
    nav_match = re.search(
        r'<nav class="site-nav">(.*?)</nav>',
        rendered, re.DOTALL
    )
    if not nav_match:
        fails.append('Bloc <nav> introuvable')
    else:
        nav_inner = nav_match.group(1)
        liens_nav = re.findall(r'<a\s[^>]*href="([^"]+)"', nav_inner)
        liens_externes = [l for l in liens_nav if not l.startswith('index.html') and not l.startswith('#')]
        if liens_externes:
            fails.append(
                f'Nav contient des liens vers des destinations autres qu\'index.html : {liens_externes}'
            )
        elif not liens_nav:
            fails.append('Nav vide (aucun lien)')
        else:
            print(f'✅ Test 4 : nav contient {len(liens_nav)} lien(s), tous vers index.html')

    print()
    if fails:
        print('❌ AUDIT DEC-61 ÉCHEC :')
        for f in fails:
            print(f'  - {f}')
        return 1

    print('✅ AUDIT DEC-61 PASSÉ — enseignants.html est conforme.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
