#!/usr/bin/env python3
"""
Mathéquête — CLI de génération de codes de licence (Plan v3.1 §8).

Usage :
    # Code essai 30 jours, 30 élèves :
    python3 generate_license.py essai --email prof@ecole.qc.ca --nom "Mme Tremblay"

    # Code promo permanent (1 élève, famille/influenceur) :
    python3 generate_license.py promo --email famille@exemple.ca

    # Code classe (vente directe sans Stripe) :
    python3 generate_license.py classe --email ecole@cssq.ca --tier classe_petite

    # Code école 1000 élèves, pilote partenariat :
    python3 generate_license.py ecole --tier grande_ecole --email partenaire@css.qc.ca

    # Génération en lot (50 codes essai pour démarchage) :
    python3 generate_license.py essai --batch 50 --csv codes_essai.csv

Variables d'environnement :
    MATHEQUETE_HMAC_KEY : 64 caractères hex (32 bytes). Identique à la clé Cloudflare.

Cohérence : utilise EXACTEMENT le même algorithme que worker/src/generate-codes.ts.
Cela permet de vérifier les codes générés ici depuis le Worker, et vice-versa.
"""

import argparse
import csv
import hashlib
import hmac
import json
import os
import secrets
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ===== Constantes (DOIVENT correspondre au Worker) =====

PREFIXES_AFFICHE = {
    'CLASSE':    'CLAS',
    'ECOLE':     'ECOL',
    'CONTINENT': 'CONT',
    'LIFETIME':  'LIFE',
    'PROMO':     'PROM',
    'ESSAI':     'ESSA',
}
BASE32_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

TIERS = {
    'classe_petite':   {'nb': 30,   'nom': 'Classe Petite'},
    'classe_moyenne':  {'nb': 100,  'nom': 'Classe Moyenne'},
    'petite_ecole':    {'nb': 300,  'nom': 'Petite École'},
    'ecole_standard':  {'nb': 500,  'nom': 'École Standard'},
    'grande_ecole':    {'nb': 1000, 'nom': 'Grande École'},
    'mega_ecole':      {'nb': 1300, 'nom': 'Méga École'},
}


# ===== Algorithme (miroir du Worker) =====

def generer_id(prefix: str = 'c') -> str:
    """ID 12-13 chars : préfixe + timestamp hex + 3 bytes random."""
    ts = format(int(time.time()), 'x')
    rand = secrets.token_hex(3)
    return (prefix + ts + rand)[:13]


def hex_to_base32_chars(hex_str: str, longueur_chars: int) -> str:
    """Convertit `hex_str` en `longueur_chars` caractères Base32 (sans 0/O/1/I)."""
    nb_bytes = (longueur_chars * 5 + 7) // 8
    padded = hex_str.ljust(nb_bytes * 2, '0')[:nb_bytes * 2]
    bits = ''.join(format(int(padded[i:i+2], 16), '08b') for i in range(0, len(padded), 2))

    out = ''
    for i in range(longueur_chars):
        chunk = bits[i*5 : i*5+5].ljust(5, '0')
        out += BASE32_CHARS[int(chunk, 2)]
    return out


def grouper_par_quatre(s: str) -> str:
    return '-'.join(s[i:i+4] for i in range(0, len(s), 4))


def hmac_hex(secret_hex: str, message: str) -> str:
    key = bytes.fromhex(secret_hex)
    return hmac.new(key, message.encode('utf-8'), hashlib.sha256).hexdigest()


def generer_code(type_licence: str, id_lic: str, expire_le: int, secret_hex: str) -> dict:
    if type_licence not in PREFIXES_AFFICHE:
        raise ValueError(f"Type inconnu : {type_licence}")

    payload = f"MQLIC:v1:{type_licence}:{id_lic}:{expire_le}"
    sig12 = hmac_hex(secret_hex, payload)[:12]
    code_brut = f"{payload}:{sig12}"

    id_hex8 = ''.join(c for c in id_lic if c in '0123456789abcdef').ljust(8, '0')[:8]
    base_str = hex_to_base32_chars(sig12 + id_hex8, 16)

    prefix = PREFIXES_AFFICHE[type_licence]
    code_affiche = f"MQ-{prefix}-{grouper_par_quatre(base_str)}"

    return {
        'id': id_lic,
        'type': type_licence,
        'expire_le': expire_le,
        'code_brut': code_brut,
        'code_affiche': code_affiche,
    }


def verifier_code_brut(code_brut: str, secret_hex: str) -> dict:
    parts = code_brut.split(':')
    if len(parts) != 6:
        return {'valide': False, 'raison': 'Format invalide (6 segments attendus)'}
    marker, version, type_lic, id_lic, expire_str, sig = parts
    if marker != 'MQLIC':
        return {'valide': False, 'raison': 'Marker manquant'}
    if version != 'v1':
        return {'valide': False, 'raison': 'Version inconnue'}
    if type_lic not in PREFIXES_AFFICHE:
        return {'valide': False, 'raison': 'Type inconnu'}
    try:
        expire_le = int(expire_str)
    except ValueError:
        return {'valide': False, 'raison': 'Expiration invalide'}

    payload = f"MQLIC:v1:{type_lic}:{id_lic}:{expire_le}"
    sig_calc = hmac_hex(secret_hex, payload)[:12]
    if sig_calc != sig:
        return {'valide': False, 'raison': 'Signature invalide'}
    if expire_le != 0 and expire_le < int(time.time()):
        return {'valide': False, 'raison': 'Code expiré'}

    return {
        'valide': True,
        'type': type_lic,
        'id': id_lic,
        'expire_le': expire_le,
    }


# ===== Logique CLI =====

DUREE_PAR_TYPE = {
    'ESSAI':    30 * 24 * 3600,
    'CLASSE':   365 * 24 * 3600,
    'ECOLE':    365 * 24 * 3600,
    'PROMO':    0,
    'LIFETIME': 0,
}


def calculer_expiration(type_licence: str) -> int:
    duree = DUREE_PAR_TYPE.get(type_licence, 0)
    return int(time.time()) + duree if duree > 0 else 0


def date_lisible(ts: int) -> str:
    if ts == 0:
        return 'Permanent'
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime('%Y-%m-%d')


def afficher_resultat(resultats: list, secret_hex: str, csv_path: str | None = None):
    print()
    print(f"=== {len(resultats)} code(s) généré(s) ===")
    print()
    for r in resultats:
        verif = verifier_code_brut(r['code_brut'], secret_hex)
        ok = '✔' if verif['valide'] else '✗'
        print(f"  {ok} {r['code_affiche']}")
        print(f"      Type      : {r['type']}")
        print(f"      Expire    : {date_lisible(r['expire_le'])}")
        print(f"      Élèves    : {r.get('nb_eleves', '—')}")
        if r.get('email'):
            print(f"      Email     : {r['email']}")
        if r.get('nom'):
            print(f"      Nom       : {r['nom']}")
        print()

    if csv_path:
        with open(csv_path, 'w', newline='', encoding='utf-8') as f:
            w = csv.writer(f)
            w.writerow(['code_affiche', 'type', 'nb_eleves', 'expire_le_iso',
                        'email', 'nom', 'code_brut'])
            for r in resultats:
                w.writerow([
                    r['code_affiche'], r['type'], r.get('nb_eleves', ''),
                    date_lisible(r['expire_le']), r.get('email', ''),
                    r.get('nom', ''), r['code_brut']
                ])
        print(f"→ CSV écrit : {csv_path}")


def main():
    parser = argparse.ArgumentParser(
        description='Mathéquête — Génération de codes de licence offline',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    sub = parser.add_subparsers(dest='command', required=True)

    for cmd_name, cmd_help in [
        ('essai',   'Code d\'essai 30 jours (30 élèves max)'),
        ('promo',   'Code permanent (1 élève — famille / influenceur)'),
        ('classe',  'Code classe 365 jours (vente directe sans Stripe)'),
        ('ecole',   'Code école 365 jours (pilote / partenariat)'),
        ('verify',  'Vérifier un code brut existant'),
    ]:
        sp = sub.add_parser(cmd_name, help=cmd_help)
        if cmd_name == 'verify':
            sp.add_argument('code_brut', help='Code brut MQLIC:v1:... à vérifier')
        else:
            sp.add_argument('--email', help='Email destinataire')
            sp.add_argument('--nom',   help='Nom du destinataire / école')
            sp.add_argument('--batch', type=int, default=1, help='Nombre de codes à générer')
            sp.add_argument('--csv',   help='Chemin du fichier CSV de sortie')
            if cmd_name in ('classe', 'ecole'):
                sp.add_argument('--tier', required=True, choices=list(TIERS.keys()),
                                help='Palier tarifaire (détermine nb élèves max)')

    args = parser.parse_args()

    # ===== Récupérer la clé HMAC =====
    secret = os.environ.get('MATHEQUETE_HMAC_KEY', '')
    if not secret:
        # En dev local on permet une clé de test, mais on prévient
        secret = 'a' * 64
        print('⚠  MATHEQUETE_HMAC_KEY non défini — utilisation clé de TEST (a×64).')
        print('   Ne JAMAIS utiliser en production. Régénérez via :')
        print('       openssl rand -hex 32')
        print()

    if len(secret) != 64 or not all(c in '0123456789abcdefABCDEF' for c in secret):
        print(f"✗ MATHEQUETE_HMAC_KEY invalide : doit être 64 hex chars, reçu {len(secret)}.",
              file=sys.stderr)
        sys.exit(1)

    # ===== Commande verify =====
    if args.command == 'verify':
        r = verifier_code_brut(args.code_brut, secret)
        print(json.dumps(r, ensure_ascii=False, indent=2))
        sys.exit(0 if r['valide'] else 1)

    # ===== Commandes génération =====
    type_map = {'essai': 'ESSAI', 'promo': 'PROMO', 'classe': 'CLASSE', 'ecole': 'ECOLE'}
    type_licence = type_map[args.command]

    nb_eleves = {
        'ESSAI': 30,
        'PROMO': 1,
    }.get(type_licence)
    if nb_eleves is None:
        nb_eleves = TIERS[args.tier]['nb']

    resultats = []
    for i in range(args.batch):
        id_lic = generer_id('c')
        expire_le = calculer_expiration(type_licence)
        r = generer_code(type_licence, id_lic, expire_le, secret)
        r['nb_eleves'] = nb_eleves
        r['email'] = args.email if args.batch == 1 else None
        r['nom'] = args.nom if args.batch == 1 else None
        resultats.append(r)

    afficher_resultat(resultats, secret, args.csv)


if __name__ == '__main__':
    main()
