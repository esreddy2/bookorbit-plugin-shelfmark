#!/usr/bin/env node

/**
 * Release signing script for BookOrbit Shelfmark indexer plugin.
 *
 * Reads index.mjs, computes its SHA-256 digest, signs it with the Ed25519
 * private key, verifies the signature against the public key declared in index.mjs,
 * and writes updates/shelfmark.json for BookOrbit's signed update channel.
 *
 * Usage:
 *   node scripts/sign-release.mjs
 *   node scripts/sign-release.mjs [new-version]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const indexPath = join(root, 'index.mjs');
const updatesDir = join(root, 'updates');
const manifestPath = join(updatesDir, 'shelfmark.json');
const defaultKeyPath = join(root, '.secrets', 'ed25519_private.pem');

// 1. Get private key from environment or default file
const privateKeyPem = process.env.SHELFMARK_SIGNING_KEY || (existsSync(defaultKeyPath) ? readFileSync(defaultKeyPath, 'utf8') : null);

if (!privateKeyPem) {
  console.error('Error: No signing key found.');
  console.error('Please ensure .secrets/ed25519_private.pem exists or set SHELFMARK_SIGNING_KEY.');
  process.exit(1);
}

const privateKey = crypto.createPrivateKey(privateKeyPem);

// 2. Read index.mjs
let indexContent = readFileSync(indexPath, 'utf8');

// Optional version bump argument
const newVersion = process.argv[2];
if (newVersion) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(newVersion)) {
    console.error(`Error: Invalid semver "${newVersion}"`);
    process.exit(1);
  }
  indexContent = indexContent.replace(/version:\s*['"][^'"]+['"]/, `version: '${newVersion}'`);
  writeFileSync(indexPath, indexContent, 'utf8');
  console.log(`Updated version in index.mjs to ${newVersion}`);
}

// 3. Extract version, type, and public key
const versionMatch = indexContent.match(/version:\s*['"]([^'"]+)['"]/);
const typeMatch = indexContent.match(/type:\s*['"]([^'"]+)['"]/);
const pubKeyMatch = indexContent.match(/ed25519PublicKey:\s*['"]([^'"]+)['"]/);

if (!versionMatch || !typeMatch || !pubKeyMatch) {
  console.error('Error: index.mjs is missing version, type, or ed25519PublicKey');
  process.exit(1);
}

const version = versionMatch[1];
const type = typeMatch[1];
const expectedPublicKey = pubKeyMatch[1];

// 4. Calculate SHA-256 of index.mjs
const sha256 = crypto.createHash('sha256').update(indexContent).digest('hex');

// 5. Sign index.mjs with Ed25519 private key
const signature = crypto.sign(null, Buffer.from(indexContent), privateKey).toString('base64');

// 6. Verify signature using public key from index.mjs
const verifierKey = crypto.createPublicKey({
  key: {
    kty: 'OKP',
    crv: 'Ed25519',
    x: expectedPublicKey,
  },
  format: 'jwk',
});

const isValid = crypto.verify(null, Buffer.from(indexContent), verifierKey, Buffer.from(signature, 'base64'));
if (!isValid) {
  console.error('Error: Signature verification failed against ed25519PublicKey in index.mjs!');
  process.exit(1);
}

// 7. Write updates/shelfmark.json
const manifest = {
  schemaVersion: 1,
  type,
  version,
  sourceUrl: `https://github.com/hateitwtf/bookorbit-plugin-shelfmark/releases/download/v${version}/index.mjs`,
  sha256,
  signature,
};

mkdirSync(updatesDir, { recursive: true });
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log('✓ Release signed and manifest generated successfully:');
console.log('  Type:      ', manifest.type);
console.log('  Version:   ', manifest.version);
console.log('  SHA-256:   ', manifest.sha256);
console.log('  Signature: ', manifest.signature.slice(0, 32) + '...');
console.log('  Manifest:  ', manifestPath);
