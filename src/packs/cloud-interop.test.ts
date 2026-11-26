// The cloud's real code builds and signs the sample pack (cloud/src/packs/build.ts with fflate, the signed
// message of scripts/pack.ts, the Worker's Web Crypto verifier); the machine's own code must accept exactly
// that, and both verifiers must refuse the same forgeries.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPack } from '../../cloud/src/packs/build';
import { signingMessage as cloudSigningMessage } from '../../cloud/src/packs/format';
import { verifyPackSignature as cloudVerify } from '../../cloud/src/packs/signature';
import { SAMPLE_PACK_DIR } from './test-packs.js';
import { sha256Hex, verifyPack, verifyPackSignature } from './verify.js';

function sampleFiles() {
  const out: { path: string; data: Uint8Array }[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(SAMPLE_PACK_DIR, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else out.push({ path: r, data: new Uint8Array(fs.readFileSync(path.join(SAMPLE_PACK_DIR, r))) });
    }
  };
  walk('notes');
  walk('assets');
  return out;
}

describe('cloud-built, cloud-signed sample pack', () => {
  it('verifies and unpacks on the machine; both verifiers agree on forgeries', async () => {
    const template = JSON.parse(fs.readFileSync(path.join(SAMPLE_PACK_DIR, 'pack.json'), 'utf8'));
    const { zip, manifest } = await buildPack(template, sampleFiles());
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64');
    const keys = { k1: pub };
    const sha = sha256Hex(zip);
    // exactly what `npm run pack -- sign` does
    const signature = crypto.sign(null, cloudSigningMessage(manifest.id, manifest.version, sha), privateKey).toString('base64');

    const pack = verifyPack(zip, { id: manifest.id, version: manifest.version }, { sha256: sha, signature, keyId: 'k1', size: zip.length }, keys);
    expect(pack.notes.map((n) => n.relPath)).toEqual(manifest.files.filter((f) => f.path.startsWith('notes/')).map((f) => f.path.slice(6)).sort());
    expect(pack.notes.filter((n) => n.loai === 'bai-hoc').length).toBeGreaterThan(0);
    expect(pack.assets).toEqual(['assets/bia.svg']);

    const cases = [
      { packId: manifest.id, version: manifest.version, sha256: sha, ok: true },
      { packId: manifest.id, version: '9.9.9', sha256: sha, ok: false },
      { packId: 'goi-khac', version: manifest.version, sha256: sha, ok: false },
      { packId: manifest.id, version: manifest.version, sha256: '0'.repeat(64), ok: false },
    ];
    for (const c of cases) {
      const opts = { keyId: 'k1', signature, packId: c.packId, version: c.version, sha256: c.sha256 };
      expect([c, verifyPackSignature({ keys, ...opts })]).toEqual([c, c.ok]);
      expect([c, await cloudVerify({ publicKeys: keys, ...opts })]).toEqual([c, c.ok]);
    }
  });
});
