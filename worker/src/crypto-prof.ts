/**
 * crypto-prof.ts — Primitives cryptographiques Sprint D1 (app prof)
 *
 * Toutes les opérations utilisent Web Crypto API natif (zéro dépendance npm).
 * Compatible Cloudflare Workers (V8 isolate).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * MODÈLE DE CHIFFREMENT (envelope encryption)
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   MASTER_ENCRYPTION_KEY (secret worker, 32 bytes hex)
 *     │
 *     │ AES-GCM chiffre
 *     ▼
 *   DEK par prof (32 bytes, généré au signup, stocké chiffré dans profs.dek_chiffree)
 *     │
 *     │ AES-GCM chiffre
 *     ▼
 *   PII élèves (prenom, nom, stats JSON)
 *
 * Suppression compte prof = effacement DEK chiffrée → données élèves
 * deviennent mathématiquement irrécupérables (effacement cryptographique).
 *
 * Rotation MASTER : incrémenter dek_version, ré-encrypter toutes les DEK.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * HACHAGE MOT DE PASSE
 * ───────────────────────────────────────────────────────────────────────────
 *
 * PBKDF2-SHA512 avec 100 000 itérations.
 * Format de sortie compatible PHC :
 *
 *   $pbkdf2-sha512$i=100000$<base64sel>$<base64hash>
 *
 * Pourquoi 100 000 et pas 600 000 ?
 *   - Cloudflare Workers limite PBKDF2 à 100 000 itérations max (anti-DDoS plateforme).
 *   - 100 000 reste robuste (OWASP 2021 minimum recommandé pour PBKDF2-SHA512).
 *   - Le format PHC inclut le nombre d'itérations → migration future transparente.
 *
 * TODO Sprint D4 : migrer vers Argon2id via WASM lib (~200 KB tolérable).
 *   - Ajouter colonne profs.hash_version (1=PBKDF2, 2=Argon2id)
 *   - Stratégie : re-hash au prochain login (rolling migration, zéro perturbation)
 *   - Cf. Plan-Phase35 §D4.5
 *
 * Pourquoi pas Argon2id tout de suite ?
 *   - Workers V8 n'a pas de binaire natif Argon2
 *   - Pas critique pour MVP (PBKDF2 100k SHA-512 = OWASP-approved 2021)
 *   - SubtleCrypto.deriveBits natif = constant time = sécurisé
 */

// ═══════════════════════════════════════════════════════════════════════════
// UTILS — Encodage
// ═══════════════════════════════════════════════════════════════════════════

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function hexToBytes(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) {
		throw new Error('hex string longueur impaire');
	}
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(hex.substr(i * 2, 2), 16);
	}
	return out;
}

export function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToBase64(bytes: Uint8Array): string {
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Base32 (RFC 4648, sans padding) — utilisé pour le secret TOTP exporté en QR. */
const BASE32_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function bytesToBase32(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (let i = 0; i < bytes.length; i++) {
		value = (value << 8) | bytes[i];
		bits += 8;
		while (bits >= 5) {
			out += BASE32_ALPHA[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) {
		out += BASE32_ALPHA[(value << (5 - bits)) & 31];
	}
	return out;
}

export function base32ToBytes(b32: string): Uint8Array {
	const clean = b32.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (let i = 0; i < clean.length; i++) {
		const idx = BASE32_ALPHA.indexOf(clean[i]);
		if (idx < 0) throw new Error('caractère base32 invalide: ' + clean[i]);
		value = (value << 5) | idx;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return new Uint8Array(out);
}

/** Comparaison constant-time (anti-timing attack). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

export function constantTimeEqualStr(a: string, b: string): boolean {
	return constantTimeEqual(encoder.encode(a), encoder.encode(b));
}

// ═══════════════════════════════════════════════════════════════════════════
// MOT DE PASSE — PBKDF2-SHA512 100k itérations (limite Cloudflare Workers)
// ═══════════════════════════════════════════════════════════════════════════

// Cloudflare Workers limite PBKDF2 à 100 000 itérations max.
// TODO Sprint D4 : migrer vers Argon2id (cf. doc en haut de fichier).
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH_LEN = 64;     // 512 bits
const PBKDF2_SALT_LEN = 16;     // 128 bits

/**
 * Hache un mot de passe en format PHC-like :
 *   $pbkdf2-sha512$i=100000$<base64salt>$<base64hash>
 */
export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_LEN));
	const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS, PBKDF2_HASH_LEN);
	return `$pbkdf2-sha512$i=${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

/**
 * Vérifie un mot de passe contre un hash PHC.
 * Retourne true si match, false sinon. Constant-time.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = stored.split('$');
	if (parts.length !== 5 || parts[1] !== 'pbkdf2-sha512') return false;
	const iterMatch = parts[2].match(/^i=(\d+)$/);
	if (!iterMatch) return false;
	const iter = parseInt(iterMatch[1], 10);
	if (iter < 100_000 || iter > 10_000_000) return false; // borne anti-DoS
	const salt = base64ToBytes(parts[3]);
	const expected = base64ToBytes(parts[4]);
	const actual = await pbkdf2(password, salt, iter, expected.length);
	return constantTimeEqual(actual, expected);
}

async function pbkdf2(
	password: string,
	salt: Uint8Array,
	iterations: number,
	keyLen: number
): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(password),
		'PBKDF2',
		false,
		['deriveBits']
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt, iterations, hash: 'SHA-512' },
		key,
		keyLen * 8
	);
	return new Uint8Array(bits);
}

// ═══════════════════════════════════════════════════════════════════════════
// HASH SIMPLE — SHA-256 (refresh tokens, magic link tokens, codes 2FA)
// ═══════════════════════════════════════════════════════════════════════════

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
	const data = typeof input === 'string' ? encoder.encode(input) : input;
	const buf = await crypto.subtle.digest('SHA-256', data);
	return bytesToHex(new Uint8Array(buf));
}

// ═══════════════════════════════════════════════════════════════════════════
// AES-256-GCM — Chiffrement données prof/élève
// ═══════════════════════════════════════════════════════════════════════════

const AES_IV_LEN = 12; // 96 bits recommandés pour GCM

/** Importe une clé AES-256-GCM depuis 32 octets bruts. */
export async function importAesKey(rawKey: Uint8Array, usages: ('encrypt' | 'decrypt')[]): Promise<CryptoKey> {
	if (rawKey.length !== 32) {
		throw new Error('AES-256 nécessite 32 octets, reçu ' + rawKey.length);
	}
	return await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, usages);
}

/**
 * Chiffre du texte avec AES-256-GCM. Retourne { ciphertext, iv } en base64.
 * Le tag d'authentification (16 octets) est concaténé au ciphertext par WebCrypto.
 */
export async function aesGcmEncrypt(
	rawKey: Uint8Array,
	plaintext: string
): Promise<{ ciphertext_b64: string; iv_b64: string }> {
	const key = await importAesKey(rawKey, ['encrypt']);
	const iv = crypto.getRandomValues(new Uint8Array(AES_IV_LEN));
	const ct = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		encoder.encode(plaintext)
	);
	return {
		ciphertext_b64: bytesToBase64(new Uint8Array(ct)),
		iv_b64: bytesToBase64(iv)
	};
}

/** Déchiffre AES-256-GCM. Throw si tag d'auth invalide (corruption ou mauvaise clé). */
export async function aesGcmDecrypt(
	rawKey: Uint8Array,
	ciphertext_b64: string,
	iv_b64: string
): Promise<string> {
	const key = await importAesKey(rawKey, ['decrypt']);
	const ct = base64ToBytes(ciphertext_b64);
	const iv = base64ToBytes(iv_b64);
	const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
	return decoder.decode(pt);
}

// ═══════════════════════════════════════════════════════════════════════════
// ENVELOPE ENCRYPTION — DEK par prof
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Génère une nouvelle DEK (Data Encryption Key) aléatoire de 32 octets.
 * À appeler au signup d'un prof.
 */
export function genererDek(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Chiffre la DEK d'un prof avec la KEK globale (MASTER_ENCRYPTION_KEY).
 * Stocke le résultat dans profs.dek_chiffree + profs.dek_iv.
 */
export async function chiffrerDek(
	dek: Uint8Array,
	masterKeyHex: string
): Promise<{ dek_chiffree_b64: string; dek_iv_b64: string }> {
	const masterKey = hexToBytes(masterKeyHex);
	if (masterKey.length !== 32) {
		throw new Error('MASTER_ENCRYPTION_KEY doit être 64 caractères hex (32 octets)');
	}
	const kek = await importAesKey(masterKey, ['encrypt']);
	const iv = crypto.getRandomValues(new Uint8Array(AES_IV_LEN));
	const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, dek);
	return {
		dek_chiffree_b64: bytesToBase64(new Uint8Array(ct)),
		dek_iv_b64: bytesToBase64(iv)
	};
}

/**
 * Déchiffre la DEK d'un prof avec la KEK globale.
 * À appeler au début de chaque opération qui accède aux PII d'un prof.
 */
export async function dechiffrerDek(
	dek_chiffree_b64: string,
	dek_iv_b64: string,
	masterKeyHex: string
): Promise<Uint8Array> {
	const masterKey = hexToBytes(masterKeyHex);
	const kek = await importAesKey(masterKey, ['decrypt']);
	const ct = base64ToBytes(dek_chiffree_b64);
	const iv = base64ToBytes(dek_iv_b64);
	const dek = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, kek, ct);
	return new Uint8Array(dek);
}

// ═══════════════════════════════════════════════════════════════════════════
// JWT HS256 — Tokens d'accès courts (8h)
// ═══════════════════════════════════════════════════════════════════════════

export interface JwtPayload {
	sub: string;            // prof_id
	iat: number;
	exp: number;
	twofa: boolean;         // true si 2FA validée (sinon token "pre-2fa")
	jti?: string;           // identifiant unique du token
}

/** Encode base64url (sans padding). */
function base64UrlEncode(bytes: Uint8Array | string): string {
	const b64 = typeof bytes === 'string' ? btoa(bytes) : bytesToBase64(bytes);
	return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): Uint8Array {
	const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
	return base64ToBytes(b64);
}

/** Signe un JWT HS256 avec un secret. Le secret est la HMAC_SECRET_KEY existante. */
export async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
	const header = { alg: 'HS256', typ: 'JWT' };
	const h = base64UrlEncode(JSON.stringify(header));
	const p = base64UrlEncode(JSON.stringify(payload));
	const data = `${h}.${p}`;
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sigBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
	const sig = base64UrlEncode(new Uint8Array(sigBuf));
	return `${data}.${sig}`;
}

/** Vérifie un JWT HS256. Retourne le payload si valide, null sinon. */
export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	const [h, p, s] = parts;
	const data = `${h}.${p}`;
	try {
		const key = await crypto.subtle.importKey(
			'raw',
			encoder.encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['verify']
		);
		const sigBytes = base64UrlDecode(s);
		const ok = await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(data));
		if (!ok) return null;
		const payload = JSON.parse(decoder.decode(base64UrlDecode(p))) as JwtPayload;
		if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
			return null;
		}
		return payload;
	} catch {
		return null;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// TOTP — RFC 6238 (compatible Google Authenticator / Authy / Aegis)
// ═══════════════════════════════════════════════════════════════════════════

/** Génère un secret TOTP aléatoire (20 octets = 160 bits, recommandation RFC). */
export function genererSecretTotp(): { raw: Uint8Array; base32: string } {
	const raw = crypto.getRandomValues(new Uint8Array(20));
	return { raw, base32: bytesToBase32(raw) };
}

/**
 * Calcule le code TOTP 6 chiffres pour un secret donné à un instant donné.
 * @param secretBase32 Le secret TOTP en base32 (tel que stocké et donné à l'utilisateur)
 * @param timestamp Unix seconds (par défaut: maintenant)
 * @param step Fenêtre TOTP en secondes (30 par défaut, standard RFC 6238)
 */
export async function calculerTotp(
	secretBase32: string,
	timestamp: number = Math.floor(Date.now() / 1000),
	step: number = 30
): Promise<string> {
	const secret = base32ToBytes(secretBase32);
	const counter = Math.floor(timestamp / step);
	const counterBytes = new Uint8Array(8);
	const view = new DataView(counterBytes.buffer);
	view.setBigUint64(0, BigInt(counter), false);

	const key = await crypto.subtle.importKey(
		'raw',
		secret,
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['sign']
	);
	const hmacBuf = await crypto.subtle.sign('HMAC', key, counterBytes);
	const hmac = new Uint8Array(hmacBuf);

	const offset = hmac[hmac.length - 1] & 0x0f;
	const code = (
		((hmac[offset] & 0x7f) << 24) |
		((hmac[offset + 1] & 0xff) << 16) |
		((hmac[offset + 2] & 0xff) << 8) |
		(hmac[offset + 3] & 0xff)
	) % 1_000_000;
	return code.toString().padStart(6, '0');
}

/**
 * Vérifie un code TOTP avec une tolérance de ±1 fenêtre (90s total).
 * Retourne true si le code matche dans [t-step, t, t+step].
 */
export async function verifierTotp(
	secretBase32: string,
	code: string,
	timestamp: number = Math.floor(Date.now() / 1000),
	step: number = 30
): Promise<boolean> {
	if (!/^\d{6}$/.test(code)) return false;
	for (const delta of [-step, 0, step]) {
		const candidat = await calculerTotp(secretBase32, timestamp + delta, step);
		if (constantTimeEqualStr(candidat, code)) return true;
	}
	return false;
}

/**
 * Construit l'URI otpauth:// à mettre dans un QR code.
 * Compatible Google Authenticator, Authy, Aegis, 1Password, Microsoft Authenticator.
 *
 * Format : otpauth://totp/<issuer>:<account>?secret=<base32>&issuer=<issuer>&algorithm=SHA1&digits=6&period=30
 */
export function construireOtpauthUri(
	secretBase32: string,
	issuer: string,
	account: string
): string {
	const params = new URLSearchParams({
		secret: secretBase32,
		issuer,
		algorithm: 'SHA1',
		digits: '6',
		period: '30'
	});
	const label = encodeURIComponent(`${issuer}:${account}`);
	return `otpauth://totp/${label}?${params.toString()}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// CODES — Codes 6 chiffres (2FA email/SMS), code_classe, code_eleve
// ═══════════════════════════════════════════════════════════════════════════

/** Génère un code 6 chiffres uniformément aléatoire (0-999999). */
export function genererCode6Chiffres(): string {
	const buf = crypto.getRandomValues(new Uint32Array(1));
	return (buf[0] % 1_000_000).toString().padStart(6, '0');
}

/**
 * Génère un code_classe au format QC-AAAA-XXXX
 * Ex: QC-2026-7K3M (caractères évitent confusion : pas de 0/O/1/I/L)
 */
export function genererCodeClasse(annee: number = new Date().getUTCFullYear()): string {
	const alpha = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sans I, L, O, 0, 1
	let out = '';
	const buf = crypto.getRandomValues(new Uint8Array(4));
	for (let i = 0; i < 4; i++) out += alpha[buf[i] % alpha.length];
	return `QC-${annee}-${out}`;
}

/**
 * Génère un code_eleve court (8 caractères) que l'élève entre dans l'app Godot
 * pour se lier à un prof. Format : XX-AAAA
 */
export function genererCodeEleve(): string {
	const alpha = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
	const buf = crypto.getRandomValues(new Uint8Array(6));
	let out = '';
	for (let i = 0; i < 2; i++) out += alpha[buf[i] % alpha.length];
	out += '-';
	for (let i = 2; i < 6; i++) out += alpha[buf[i] % alpha.length];
	return out;
}

/** Génère un token aléatoire URL-safe (pour magic links, refresh tokens). */
export function genererTokenSecuriseUrl(longueur: number = 32): string {
	const bytes = crypto.getRandomValues(new Uint8Array(longueur));
	return base64UrlEncode(bytes);
}

/** Génère un ID style "prefix_hex" — pour profs, sessions, élèves. */
export function genererId(prefix: string, longueurHex: number = 16): string {
	const bytes = crypto.getRandomValues(new Uint8Array(longueurHex / 2));
	return `${prefix}_${bytesToHex(bytes)}`;
}
