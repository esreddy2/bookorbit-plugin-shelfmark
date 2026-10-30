#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const sharedPath = join(root, 'shared', 'identity.mjs');
const indexPath = join(root, 'index.mjs');

let shared = readFileSync(sharedPath, 'utf8');
// Strip export keywords to make it a plain top-level script.
shared = shared.replace(/^export\s+(const|let|var|function|class)\s/gm, '$1 ');
shared = shared.replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '');
shared = shared.replace(/^export\s+default\s+/gm, '');

const indexContent = readFileSync(indexPath, 'utf8');
const startMarker = '// >>> IDENTITY MODULE START';
const endMarker = '// <<< IDENTITY MODULE END';
const i = indexContent.indexOf(startMarker);
const j = indexContent.indexOf(endMarker);
if (i === -1 || j === -1 || j < i) {
  console.error('Markers not found in index.mjs');
  process.exit(1);
}
const before = indexContent.slice(0, i + startMarker.length);
const after = indexContent.slice(j);
const next = before + '\n' + shared + '\n' + after;
writeFileSync(indexPath, next, 'utf8');
console.log('Built index.mjs with inlined identity module.');