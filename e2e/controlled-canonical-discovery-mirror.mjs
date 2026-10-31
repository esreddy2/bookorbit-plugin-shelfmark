#!/usr/bin/env node
/**
 * Controlled Libgen-compatible HTTP fixture server for Canonical Discovery & Series-Volume E2E (v1.7.8).
 *
 * Runs ONLY inside the isolated `e2e_default` Docker network (`e2e-fixture-mirror:18099`).
 * Serves `#tablelibgen` search HTML, `ads.php` resolution pages, and standards-compliant
 * >16 KB controlled OCF EPUB 3 files testing:
 *   1. Series-prefixed volume discovery ("Percy Jackson and the Olympians, Book Five: The Last Olympian")
 *      filtering out slash omnibuses & wrong-volume candidates and fulfilling from canonical OPF EPUB.
 *   2. Edition-suffixed metadata fallback ("Harry Potter and the Chamber of Secrets: Enhanced Edition")
 *      where raw OpenLibrary metadata returns 0, falling back to canonical title and fulfilling Book 2.
 *   3. Franchise-prefixed companion discovery ("From the Files of Camp Half-Blood: Camp Half-Blood Confidential")
 *      falling back to canonical "Camp Half-Blood Confidential" and fulfilling.
 *   4. Wrong-volume & box-set rejection ("Percy Jackson and the Olympians, Book Four: The Battle of the Labyrinth")
 *      rejecting Stage 1 wrong-volume/box-set releases AND rejecting a deceptive EPUB whose internal OPF
 *      <dc:title> specifies Book 1 before any BookOrbit upload occurs.
 *   5. Honest `no_releases` handling when a real work ("The Chalice of the Gods") or nonexistent work
 *      has zero available releases on configured sources.
 */

import http from 'node:http';

const PORT = Number(process.env.PORT || 18099);
const RUN_HEX = String(process.env.E2E_RUN_HEX || 'e2e178')
  .toLowerCase()
  .replace(/[^0-9a-f]/g, 'c')
  .padEnd(6, '0')
  .slice(0, 6);

function makeMd5(suffix2) {
  return `${RUN_HEX}${'0'.repeat(24)}${suffix2}`;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildControlledEpub({
  title,
  creator,
  language = 'en',
  pubDate = null,
  modifiedDate = '2026-02-01T10:00:00Z',
  identifiers = [],
  useStreaming = false,
  chapters = [],
  paddingBytes = 18000,
}) {
  const idXml = identifiers
    .map((id, idx) => `<dc:identifier id="id-${idx}">${esc(id)}</dc:identifier>`)
    .join('\n    ');
  const primaryId = identifiers.length > 0 ? 'id-0' : 'pub-fallback';
  const fallbackIdXml = identifiers.length === 0
    ? '<dc:identifier id="pub-fallback">urn:uuid:00000000-0000-4000-8000-000000000178</dc:identifier>'
    : '';
  const langXml = language ? `<dc:language>${esc(language)}</dc:language>` : '';
  const dateXml = pubDate ? `<dc:date>${esc(pubDate)}</dc:date>` : '';
  const modXml = modifiedDate ? `<meta property="dcterms:modified">${esc(modifiedDate)}</meta>` : '';

  const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  const manifestItems = [
    `<item id="style" href="styles.css" media-type="text/css"/>`,
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
  ];
  const spineItems = [];

  chapters.forEach((_, idx) => {
    const id = `ch${idx + 1}`;
    manifestItems.push(`<item id="${id}" href="chapter${idx + 1}.xhtml" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="${id}"/>`);
  });

  const opfXml = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="${primaryId}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${esc(title)}</dc:title>
    <dc:creator>${esc(creator)}</dc:creator>
    ${langXml}
    ${dateXml}
    ${modXml}
    ${idXml}
    ${fallbackIdXml}
  </metadata>
  <manifest>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine>
    ${spineItems.join('\n    ')}
  </spine>
</package>`;

  const navXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><title>${esc(title)} - Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
      <li><a href="chapter1.xhtml">Chapter One</a></li>
      <li><a href="chapter2.xhtml">Chapter Two</a></li>
    </ol>
  </nav>
</body>
</html>`;

  const cssCommentPad = `/* Controlled E2E stylesheet padding (${RUN_HEX}) ${'x'.repeat(Math.max(1024, paddingBytes))} */\nbody { font-family: serif; line-height: 1.5; }\n`;

  const files = [
    { name: 'mimetype', data: Buffer.from('application/epub+zip', 'utf8'), stream: false },
    { name: 'META-INF/container.xml', data: Buffer.from(containerXml, 'utf8'), stream: useStreaming },
    { name: 'OEBPS/content.opf', data: Buffer.from(opfXml, 'utf8'), stream: useStreaming },
    { name: 'OEBPS/styles.css', data: Buffer.from(cssCommentPad, 'utf8'), stream: useStreaming },
    { name: 'OEBPS/nav.xhtml', data: Buffer.from(navXhtml, 'utf8'), stream: useStreaming },
  ];

  chapters.forEach((bodyHtml, idx) => {
    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${esc(title)} - Part ${idx + 1}</title><link rel="stylesheet" href="styles.css"/></head>
<body>
${bodyHtml}
</body>
</html>`;
    files.push({ name: `OEBPS/chapter${idx + 1}.xhtml`, data: Buffer.from(xhtml, 'utf8'), stream: useStreaming });
  });

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const dataBuf = f.data;
    const sum = crc32(dataBuf);
    const flags = f.stream ? 0x0008 : 0x0000;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(flags, 6);
    lfh.writeUInt16LE(0, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(f.stream ? 0 : sum, 14);
    lfh.writeUInt32LE(f.stream ? 0 : dataBuf.length, 18);
    lfh.writeUInt32LE(f.stream ? 0 : dataBuf.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    let dd = Buffer.alloc(0);
    if (f.stream) {
      dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(sum, 4);
      dd.writeUInt32LE(dataBuf.length, 8);
      dd.writeUInt32LE(dataBuf.length, 12);
    }

    const cde = Buffer.alloc(46);
    cde.writeUInt32LE(0x02014b50, 0);
    cde.writeUInt16LE(20, 4);
    cde.writeUInt16LE(20, 6);
    cde.writeUInt16LE(flags, 8);
    cde.writeUInt16LE(0, 10);
    cde.writeUInt16LE(0, 12);
    cde.writeUInt16LE(0, 14);
    cde.writeUInt32LE(sum, 16);
    cde.writeUInt32LE(dataBuf.length, 20);
    cde.writeUInt32LE(dataBuf.length, 24);
    cde.writeUInt16LE(nameBuf.length, 28);
    cde.writeUInt16LE(0, 30);
    cde.writeUInt16LE(0, 32);
    cde.writeUInt16LE(0, 34);
    cde.writeUInt16LE(0, 36);
    cde.writeUInt32LE(0, 38);
    cde.writeUInt32LE(offset, 42);

    localParts.push(lfh, nameBuf, dataBuf, dd);
    centralParts.push(cde, nameBuf);
    offset += lfh.length + nameBuf.length + dataBuf.length + dd.length;
  }

  const cdBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

const ENGLISH_DEMIGOD_PROSE = [
  `<p>The end of the world started when a pegasus landed on the hood of my car along the East River drive in Manhattan. Up until then, I had been having a pleasant afternoon driving with Rachel Dare while the summer breeze drifted across the harbor.</p>
   <p>Beckendorf was already waiting near the bronze railing with his backpack slung over one shoulder, checking his watch as the afternoon shadows stretched across the pier toward Long Island Sound.</p>`,
  `<p>When we returned to the cabins beside the strawberry fields and the climbing wall, Chiron gathered the senior counselors around the ping-pong table in the Big House rec room to review our defenses.</p>
   <p>Every camper understood that defending the bridges and tunnels of New York would require courage, loyalty, and careful coordination before dawn broke over the Empire State Building.</p>`,
  `<p>Standing on the steps overlooking the valley, Annabeth unrolled the architectural blueprints she had studied all winter, pointing out each pass where scouts could watch the horizon in clear English daylight.</p>`,
];

const ENGLISH_CHAMBER_PROSE = [
  `<p>Not for the first time, an argument had broken out over breakfast at number four, Privet Drive, while the morning sunlight slanted across the kitchen table and Hedwig ruffled her feathers inside her locked cage.</p>
   <p>Harry missed the stone corridors, the towering bookshelves of the library, and the autumn wind sweeping across the Quidditch pitch beside the Forbidden Forest more than words could easily express.</p>`,
  `<p>When Ron, Fred, and George arrived outside his barred bedroom window in the turquoise flying car at midnight, they stowed his trunk neatly in the boot and soared above the sleeping Surrey streets toward the Burrow.</p>
   <p>In Flourish and Blotts along Diagon Alley, stacks of leatherbound spellbooks reached the rafters while students compared their course schedules for the new term at Hogwarts School.</p>`,
  `<p>Deep beneath the castle, echoes drifted through the ancient stone passages as Harry and Ron pieced together the mystery with Hermione’s careful notes tucked safely inside Harry’s robes.</p>`,
];

const CATALOG = [
  // ─── SCENARIO 1: Percy Jackson Book Five ("The Last Olympian") ───
  // Trap 1A (920 KB, larger size!): Slash-separated multi-book omnibus -> MUST BE REJECTED!
  {
    md5: makeMd5('11'),
    matchTokens: ['last olympian'],
    title: 'The Lightning Thief / The Sea of Monsters / The Titan\'s Curse / The Battle of the Labyrinth / The Last Olympian',
    author: 'Rick Riordan',
    language: 'English',
    sizeLabel: '920 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: 'Percy Jackson Complete Five-Book Omnibus',
      creator: 'Rick Riordan',
      language: 'en',
      chapters: ENGLISH_DEMIGOD_PROSE,
    }),
  },
  // Trap 1B (810 KB, larger size!): Wrong-volume mislabeled candidate (Book 1) -> MUST BE REJECTED!
  {
    md5: makeMd5('12'),
    matchTokens: ['last olympian'],
    title: 'The Last Olympian (Percy Jackson and the Olympians, Book 1)',
    author: 'Rick Riordan',
    language: 'English',
    sizeLabel: '810 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: 'The Lightning Thief',
      creator: 'Rick Riordan',
      language: 'en',
      chapters: ENGLISH_DEMIGOD_PROSE,
    }),
  },
  // Valid 1C (420 KB): Authentic Book 5 release whose EPUB OPF uses canonical "<dc:title>The Last Olympian</dc:title>" -> FULFILLED!
  {
    md5: makeMd5('13'),
    matchTokens: ['last olympian'],
    title: 'Percy Jackson 5 - The Last Olympian',
    author: 'Rick Riordan',
    language: 'English',
    sizeLabel: '420 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: 'The Last Olympian',
      creator: 'Rick Riordan',
      language: null,
      pubDate: null,
      useStreaming: true,
      chapters: ENGLISH_DEMIGOD_PROSE,
    }),
  },

  // ─── SCENARIO 2: Harry Potter Enhanced Edition ("Harry Potter and the Chamber of Secrets: Enhanced Edition") ───
  // Trap 2A (850 KB): Wrong volume in same series -> MUST BE REJECTED!
  {
    md5: makeMd5('21'),
    matchTokens: ['harry potter'],
    title: 'Book 1: Harry Potter and the Philosopher\'s Stone',
    author: 'J.K. Rowling',
    language: 'English',
    sizeLabel: '850 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: 'Harry Potter and the Philosopher\'s Stone',
      creator: 'J.K. Rowling',
      language: 'en',
      chapters: ENGLISH_CHAMBER_PROSE,
    }),
  },
  // Valid 2B (480 KB): Canonical Book 2 release -> FULFILLED!
  {
    md5: makeMd5('22'),
    matchTokens: ['chamber of secrets'],
    title: 'Book 2: Harry Potter and the Chamber of Secrets',
    author: 'J.K. Rowling',
    language: 'English',
    sizeLabel: '480 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: 'Harry Potter and the Chamber of Secrets',
      creator: 'J.K. Rowling',
      language: 'en',
      chapters: ENGLISH_CHAMBER_PROSE,
    }),
  },

  // ─── SCENARIO 3: Camp Half-Blood Companion ("From the Files of Camp Half-Blood: Camp Half-Blood Confidential") ───
  // Trap 3A (950 KB): Multi-book slash omnibus -> MUST BE REJECTED!
  {
    md5: makeMd5('31'),
    matchTokens: ['camp half-blood'],
    title: 'Demigod Files / Demigod Diaries / Camp Half-Blood Confidential',
    author: 'Rick Riordan',
    language: 'English',
    sizeLabel: '950 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: 'Demigod Omnibus',
      creator: 'Rick Riordan',
      language: 'en',
      chapters: ENGLISH_DEMIGOD_PROSE,
    }),
  },
  // Valid 3B (360 KB): Authentic companion book with descriptive guide subtitle -> FULFILLED!
  {
    md5: makeMd5('32'),
    matchTokens: ['camp half-blood confidential'],
    title: 'Camp Half-Blood Confidential: Your Real Guide to the Demigod Training Camp',
    author: 'Rick Riordan',
    language: 'English',
    sizeLabel: '360 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: 'Camp Half-Blood Confidential',
      creator: 'Rick Riordan',
      language: 'en',
      chapters: ENGLISH_DEMIGOD_PROSE,
    }),
  },

  // ─── SCENARIO 4: Wrong-Volume & Box-Set Rejection ("Percy Jackson and the Olympians, Book Four: The Battle of the Labyrinth") ───
  // Stage-1 Trap 4A: Multi-volume range box set
  {
    md5: makeMd5('41'),
    matchTokens: ['labyrinth'],
    title: 'Percy Jackson and the Olympians Books 1-5: Including The Battle of the Labyrinth',
    author: 'Rick Riordan',
    language: 'English',
    sizeLabel: '990 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: 'Percy Jackson Books 1-5',
      creator: 'Rick Riordan',
      language: 'en',
      chapters: ENGLISH_DEMIGOD_PROSE,
    }),
  },
  // Stage-1 Trap 4B: Explicit wrong volume in release title (Book 2 vs requested Book Four)
  {
    md5: makeMd5('42'),
    matchTokens: ['battle of the labyrinth'],
    title: 'The Battle of the Labyrinth (Percy Jackson and the Olympians, Book 2)',
    author: 'Rick Riordan',
    language: 'English',
    sizeLabel: '720 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: 'The Sea of Monsters',
      creator: 'Rick Riordan',
      language: 'en',
      chapters: ENGLISH_DEMIGOD_PROSE,
    }),
  },
  // Stage-2 Trap 4C: Release title omits volume ("The Battle of the Labyrinth"), but internal OPF <dc:title> is Book 1!
  {
    md5: makeMd5('43'),
    matchTokens: ['battle of the labyrinth'],
    title: 'The Battle of the Labyrinth',
    author: 'Rick Riordan',
    language: 'English',
    sizeLabel: '410 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: 'Percy Jackson and the Olympians, Book 1: The Lightning Thief',
      creator: 'Rick Riordan',
      language: 'en',
      chapters: ENGLISH_DEMIGOD_PROSE,
    }),
  },
  // Note: Scenario 5 ("The Chalice of the Gods" & nonexistent Book Eleven) intentionally has ZERO mirror entries!
];

const BY_MD5 = new Map(CATALOG.map((item) => [item.md5, item]));
const requestLog = [];

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  requestLog.push({
    at: new Date().toISOString(),
    method: req.method,
    path: u.pathname,
    search: u.search,
  });

  if (u.pathname === '/_health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, catalogSize: CATALOG.length }));
    return;
  }

  if (u.pathname === '/_stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, requests: requestLog }));
    return;
  }

  if (u.pathname === '/index.php') {
    const q = (u.searchParams.get('req') || '').toLowerCase();
    const matched = CATALOG.filter((item) =>
      item.matchTokens.every((tok) => q.includes(tok))
    );

    const rowsHtml = matched
      .map(
        (item) => `<tr>
          <td><a href="edition.php?id=${item.md5}">${esc(item.title)}</a></td>
          <td>${esc(item.author)}</td>
          <td></td>
          <td></td>
          <td>${esc(item.language)}</td>
          <td>260</td>
          <td>${esc(item.sizeLabel)}</td>
          <td>${esc(item.format)}</td>
          <td><a href="ads.php?md5=${item.md5}">[1]</a></td>
        </tr>`
      )
      .join('\n');

    const html = `<!DOCTYPE html>
<html><body>
<table id="tablelibgen">
  <tr><th>Title</th><th>Author</th><th>Publisher</th><th>Year</th><th>Language</th><th>Pages</th><th>Size</th><th>Ext</th><th>Mirrors</th></tr>
  ${rowsHtml}
</table>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (u.pathname === '/ads.php') {
    const md5 = (u.searchParams.get('md5') || '').toLowerCase();
    const item = BY_MD5.get(md5);
    if (!item) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const html = `<!DOCTYPE html>
<html><body>
  <table>
    <tr><td><a href="get.php?md5=${item.md5}&amp;key=CONTROLLED_E2E_KEY"><h2>GET</h2></a></td></tr>
    <tr><td>Title: ${esc(item.title)} Author(s): ${esc(item.author)} Language: ${esc(item.language)} Extension: ${esc(item.format)} Size: ${esc(item.sizeLabel)}</td></tr>
  </table>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (u.pathname === '/get.php') {
    const md5 = (u.searchParams.get('md5') || '').toLowerCase();
    const item = BY_MD5.get(md5);
    if (!item) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const safeName = item.title.replace(/[^a-z0-9]+/gi, '_');
    res.writeHead(200, {
      'Content-Type': 'application/epub+zip',
      'Content-Length': String(item.epubBytes.length),
      'Content-Disposition': `attachment; filename="${safeName}_${item.md5.slice(-2)}.epub"`,
    });
    res.end(item.epubBytes);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ControlledCanonicalMirror] Listening on 0.0.0.0:${PORT} (RUN_HEX=${RUN_HEX}, items=${CATALOG.length})`);
});
