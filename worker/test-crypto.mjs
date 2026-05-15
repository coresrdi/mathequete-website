/**
 * Tests rapides du module crypto-prof.ts (Sprint D1).
 *
 * Exécution :
 *   cd worker && node test-crypto.mjs
 *
 * Compile crypto-prof.ts dans ./dist-test/, puis l'importe en ESM.
 * Vérifie les primitives cryptographiques essentielles : password hash,
 * AES-GCM, JWT, TOTP (vecteurs officiels RFC 6238), envelope encryption.
 *
 * Web Crypto API est natif dans Node 19+.
 */

import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const distDir = './dist-test';

try {
	// Compile crypto-prof.ts avec la config tsconfig.test.json (émet vers dist-test/)
	console.log('Compilation crypto-prof.ts...');
	execSync('npx tsc -p tsconfig.test.json', {
		cwd: process.cwd(),
		stdio: 'inherit'
	});

	const mod = await import(resolve(distDir, 'crypto-prof.js'));

	let ok = 0, ko = 0;
	function assert(cond, label) {
		if (cond) { ok++; console.log(`  OK ${label}`); }
		else      { ko++; console.error(`  KO ${label}`); }
	}
	function assertEq(a, b, label) {
		assert(a === b, `${label} (got=${JSON.stringify(a)}, want=${JSON.stringify(b)})`);
	}

	console.log('\n=== Test 1 : hex / base64 / base32 round-trip ===');
	{
		const bytes = new Uint8Array([0, 1, 2, 254, 255]);
		assertEq(mod.bytesToHex(bytes), '000102feff', 'hex encode');
		const back = mod.hexToBytes('000102feff');
		assertEq(back.length, 5, 'hex decode length');
		for (let i = 0; i < 5; i++) assertEq(back[i], bytes[i], `hex byte ${i}`);

		const b64 = mod.bytesToBase64(bytes);
		const back64 = mod.base64ToBytes(b64);
		for (let i = 0; i < 5; i++) assertEq(back64[i], bytes[i], `b64 byte ${i}`);

		const b32 = mod.bytesToBase32(bytes);
		const back32 = mod.base32ToBytes(b32);
		for (let i = 0; i < 5; i++) assertEq(back32[i], bytes[i], `b32 byte ${i}`);
	}

	console.log('\n=== Test 2 : constantTimeEqual ===');
	{
		const a = new TextEncoder().encode('hello');
		const b = new TextEncoder().encode('hello');
		const c = new TextEncoder().encode('world');
		assert(mod.constantTimeEqual(a, b), 'identiques');
		assert(!mod.constantTimeEqual(a, c), 'differents');
		assert(!mod.constantTimeEqual(a, new TextEncoder().encode('helloo')), 'longueurs diff');
	}

	console.log('\n=== Test 3 : hashPassword + verifyPassword ===');
	{
		const pwd = 'MotDePasse-Super-Solide-2026!';
		const h = await mod.hashPassword(pwd);
		assert(h.startsWith('$pbkdf2-sha512$i=600000$'), 'format PHC');
		assert(await mod.verifyPassword(pwd, h), 'mot de passe correct accepte');
		assert(!await mod.verifyPassword(pwd + 'X', h), 'mot de passe modifie refuse');
		assert(!await mod.verifyPassword('', h), 'mot de passe vide refuse');
	}

	console.log('\n=== Test 4 : sha256Hex ===');
	{
		const h = await mod.sha256Hex('abc');
		assertEq(h, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'SHA-256(abc)');
	}

	console.log('\n=== Test 5 : AES-256-GCM round-trip ===');
	{
		const key = new Uint8Array(32);
		crypto.getRandomValues(key);
		const plaintext = 'Donnees enfant -- Eleve prenom: Lea, Note: 8/10';
		const enc = await mod.aesGcmEncrypt(key, plaintext);
		assert(enc.ciphertext_b64.length > 0, 'ciphertext non vide');
		const dec = await mod.aesGcmDecrypt(key, enc.ciphertext_b64, enc.iv_b64);
		assertEq(dec, plaintext, 'dechiffre identique');

		const wrongKey = new Uint8Array(32);
		crypto.getRandomValues(wrongKey);
		let threw = false;
		try {
			await mod.aesGcmDecrypt(wrongKey, enc.ciphertext_b64, enc.iv_b64);
		} catch { threw = true; }
		assert(threw, 'mauvaise cle = throw (auth tag)');
	}

	console.log('\n=== Test 6 : Envelope encryption DEK ===');
	{
		const masterHex = mod.bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
		const dek = mod.genererDek();
		assertEq(dek.length, 32, 'DEK 32 octets');
		const enc = await mod.chiffrerDek(dek, masterHex);
		const dek2 = await mod.dechiffrerDek(enc.dek_chiffree_b64, enc.dek_iv_b64, masterHex);
		assertEq(dek2.length, dek.length, 'DEK longueur');
		for (let i = 0; i < dek.length; i++) assertEq(dek2[i], dek[i], `DEK byte ${i}`);
	}

	console.log('\n=== Test 7 : JWT HS256 ===');
	{
		const secret = 'super-secret-hmac-key-test-1234567890';
		const payload = {
			sub: 'p_abc123',
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(Date.now() / 1000) + 3600,
			twofa: true
		};
		const token = await mod.signJwt(payload, secret);
		assert(token.split('.').length === 3, 'JWT 3 segments');
		const verified = await mod.verifyJwt(token, secret);
		assert(verified !== null, 'JWT verifie');
		assertEq(verified.sub, payload.sub, 'sub conserve');
		assertEq(verified.twofa, true, 'twofa conserve');

		const bad = await mod.verifyJwt(token, 'autre-secret');
		assert(bad === null, 'mauvais secret refuse');

		const expiredPayload = { ...payload, exp: Math.floor(Date.now() / 1000) - 10 };
		const expiredToken = await mod.signJwt(expiredPayload, secret);
		assert((await mod.verifyJwt(expiredToken, secret)) === null, 'token expire refuse');
	}

	console.log('\n=== Test 8 : TOTP RFC 6238 (vecteurs officiels) ===');
	{
		// RFC 6238 Appendix B : secret ASCII "12345678901234567890" (20 octets)
		// Vecteurs SHA-1 :
		//   t=59         -> 287082
		//   t=1111111109 -> 081804
		//   t=1111111111 -> 050471
		//   t=1234567890 -> 005924
		//   t=2000000000 -> 279037
		const secretAscii = '12345678901234567890';
		const secretBytes = new TextEncoder().encode(secretAscii);
		const secretB32 = mod.bytesToBase32(secretBytes);

		assertEq(await mod.calculerTotp(secretB32, 59),         '287082', 'TOTP t=59');
		assertEq(await mod.calculerTotp(secretB32, 1111111109), '081804', 'TOTP t=1111111109');
		assertEq(await mod.calculerTotp(secretB32, 1111111111), '050471', 'TOTP t=1111111111');
		assertEq(await mod.calculerTotp(secretB32, 1234567890), '005924', 'TOTP t=1234567890');
		assertEq(await mod.calculerTotp(secretB32, 2000000000), '279037', 'TOTP t=2000000000');

		assert(await mod.verifierTotp(secretB32, '287082', 59),      'verif exact');
		assert(await mod.verifierTotp(secretB32, '287082', 59 + 29), 'verif fenetre courante');
		assert(await mod.verifierTotp(secretB32, '287082', 59 - 30), 'verif fenetre precedente');
		assert(!await mod.verifierTotp(secretB32, '287082', 59 + 90),'refus hors tolerance');
		assert(!await mod.verifierTotp(secretB32, '000000', 59),     'refus mauvais code');
		assert(!await mod.verifierTotp(secretB32, 'abc',    59),     'refus code non num');
		assert(!await mod.verifierTotp(secretB32, '12345',  59),     'refus 5 chiffres');
	}

	console.log('\n=== Test 9 : Generateurs ===');
	{
		const cc = mod.genererCodeClasse(2026);
		assert(/^QC-2026-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/.test(cc), `code_classe: ${cc}`);

		const ce = mod.genererCodeEleve();
		assert(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{2}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/.test(ce), `code_eleve: ${ce}`);

		const id = mod.genererId('p', 16);
		assert(/^p_[0-9a-f]{16}$/.test(id), `id: ${id}`);

		const code6 = mod.genererCode6Chiffres();
		assert(/^\d{6}$/.test(code6), `code 6 chiffres: ${code6}`);

		const tok = mod.genererTokenSecuriseUrl(32);
		assert(tok.length >= 40, `token longueur: ${tok.length}`);
		assert(!/[+/=]/.test(tok), 'token URL-safe');
	}

	console.log('\n=== Test 10 : otpauth URI ===');
	{
		const uri = mod.construireOtpauthUri('JBSWY3DPEHPK3PXP', 'Mathequete', 'prof@example.com');
		assert(uri.startsWith('otpauth://totp/'), 'scheme');
		assert(uri.includes('secret=JBSWY3DPEHPK3PXP'), 'secret');
		assert(uri.includes('algorithm=SHA1'), 'algo SHA1');
		assert(uri.includes('digits=6'), 'digits');
		assert(uri.includes('period=30'), 'period');
	}

	console.log('\n========================');
	console.log(`Resultats : ${ok} OK, ${ko} KO`);
	console.log('========================');
	process.exit(ko > 0 ? 1 : 0);

} finally {
	try { rmSync(distDir, { recursive: true, force: true }); } catch {}
}
