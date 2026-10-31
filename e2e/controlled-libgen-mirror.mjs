#!/usr/bin/env node
/**
 * Controlled Libgen-compatible HTTP fixture server for isolated E2E testing.
 *
 * Runs ONLY inside the isolated `e2e_default` Docker network (`e2e-fixture-mirror:18099`).
 * Serves `#tablelibgen` search HTML (which Shelfmark's real LibgenSource parses into
 * releases with `year: null` and `isbn: null`), `ads.php` resolution pages, and
 * standards-compliant >16 KB controlled EPUB 3 files via `get.php`.
 */

import http from 'node:http';

const PORT = Number(process.env.PORT || 18099);
const RUN_HEX = String(process.env.E2E_RUN_HEX || 'e2e776')
  .toLowerCase()
  .replace(/[^0-9a-f]/g, 'a')
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

/**
 * Builds a valid OCF EPUB 3 archive (>= 16 KB so Shelfmark's 10 KB minimum check
 * and BookOrbit's EPUB metadata/chapter extractor both accept it cleanly).
 * First entry (`mimetype`) is always stored non-streaming per OCF spec; subsequent
 * entries optionally use bit-3 streaming data descriptors (`useStreaming = true`).
 */
function buildControlledEpub({
  title,
  creator,
  language = 'en',
  pubDate = null,
  modifiedDate = '2026-01-15T10:00:00Z',
  identifiers = [],
  useStreaming = false,
  uniqueSeed = '',
}) {
  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const idXml = identifiers
    .map((id, idx) => `<dc:identifier id="id-${idx}">${esc(id)}</dc:identifier>`)
    .join('\n    ');
  const primaryId = identifiers.length > 0 ? 'id-0' : 'pub-fallback';
  const fallbackIdXml = identifiers.length === 0
    ? '<dc:identifier id="pub-fallback">urn:uuid:00000000-0000-4000-8000-000000000000</dc:identifier>'
    : '';
  const dateXml = pubDate ? `<dc:date>${esc(pubDate)}</dc:date>` : '';
  const modXml = modifiedDate ? `<meta property="dcterms:modified">${esc(modifiedDate)}</meta>` : '';

  const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  const opfXml = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="${primaryId}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${esc(title)}</dc:title>
    <dc:creator>${esc(creator)}</dc:creator>
    <dc:language>${esc(language)}</dc:language>
    ${dateXml}
    ${modXml}
    ${idXml}
    ${fallbackIdXml}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>`;

  const navXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${esc(language)}">
<head><title>${esc(title)}</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol><li><a href="chapter1.xhtml">Chapter 1</a></li></ol>
  </nav>
</body>
</html>`;

  const paragraph = `<p>${esc(title)} by ${esc(creator)} — controlled isolated E2E edition fixture (${esc(uniqueSeed)}). Reading text block for realistic OCF archive sizing.</p>\n`;
  const chapter1Xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="${esc(language)}">
<head><title>${esc(title)} - Chapter 1</title></head>
<body>
  <h1>${esc(title)}</h1>
  <h2>${esc(creator)}</h2>
  ${paragraph.repeat(120)}
</body>
</html>`;

  const files = [
    { name: 'mimetype', data: Buffer.from('application/epub+zip', 'utf8'), stream: false },
    { name: 'META-INF/container.xml', data: Buffer.from(containerXml, 'utf8'), stream: useStreaming },
    { name: 'OEBPS/content.opf', data: Buffer.from(opfXml, 'utf8'), stream: useStreaming },
    { name: 'OEBPS/nav.xhtml', data: Buffer.from(navXhtml, 'utf8'), stream: useStreaming },
    { name: 'OEBPS/chapter1.xhtml', data: Buffer.from(chapter1Xhtml, 'utf8'), stream: useStreaming },
  ];

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
    lfh.writeUInt16LE(0, 8); // store
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

const CATALOG = [
  // Scenario 1: Correct automatic fulfillment from unknown-year release
  {
    md5: makeMd5('01'),
    matchTokens: ['war of the worlds'],
    title: 'The War of the Worlds',
    author: 'H. G. Wells',
    language: 'English',
    sizeLabel: '18 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: 'The War of the Worlds',
      creator: 'H. G. Wells',
      language: 'en',
      pubDate: '2005-03-31',
      modifiedDate: '2024-02-01T00:00:00Z',
      identifiers: [
        'urn:uuid:aaaaaaaa-1111-4111-8111-111111111101',
        'urn:isbn:9780141441030',
      ],
      useStreaming: false,
      uniqueSeed: `scenario1-${RUN_HEX}-war-of-the-worlds-2005-9780141441030`,
    }),
  },
  // Scenario 2: Wrong edition EPUB (2011 / 9780199564095 vs requested 2003 / 9780141439846)
  {
    md5: makeMd5('02'),
    matchTokens: ['dracula'],
    title: 'Dracula',
    author: 'Bram Stoker',
    language: 'English',
    sizeLabel: '18 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: 'Dracula',
      creator: 'Bram Stoker',
      language: 'en',
      pubDate: '2011-05-12',
      modifiedDate: '2024-03-10T00:00:00Z',
      identifiers: [
        'urn:isbn:9780199564095',
      ],
      useStreaming: false,
      uniqueSeed: `scenario2-${RUN_HEX}-dracula-wrong-edition-2011-9780199564095`,
    }),
  },
  // Scenario 3: Unverifiable edition EPUB (no dc:date, no ISBN; dcterms:modified + UUID digits must NOT fabricate a match)
  {
    md5: makeMd5('03'),
    matchTokens: ['treasure island'],
    title: 'Treasure Island',
    author: 'Robert Louis Stevenson',
    language: 'English',
    sizeLabel: '18 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: 'Treasure Island',
      creator: 'Robert Louis Stevenson',
      language: 'en',
      pubDate: null,
      modifiedDate: '2011-08-01T12:00:00Z', // matches requested 2011 year ONLY in packaging modified timestamp!
      identifiers: [
        'urn:uuid:12345678-1234-4123-8123-978019956035',
        'calibre:2011080199',
      ],
      useStreaming: false,
      uniqueSeed: `scenario3-${RUN_HEX}-treasure-island-unverifiable-no-year-no-isbn`,
    }),
  },
  // Scenario 4 Candidate A (ranked #1 by sizeLabel 650 KB): Wrong edition (1998 Dover 9780486270715)
  {
    md5: makeMd5('04'),
    matchTokens: ['invisible man'],
    title: 'The Invisible Man',
    author: 'H. G. Wells',
    language: 'English',
    sizeLabel: '650 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: 'The Invisible Man',
      creator: 'H. G. Wells',
      language: 'en',
      pubDate: '1998-06-01',
      modifiedDate: '2023-05-01T00:00:00Z',
      identifiers: [
        'urn:isbn:9780486270715',
      ],
      useStreaming: false,
      uniqueSeed: `scenario4-${RUN_HEX}-candA-invisible-man-wrong-1998-9780486270715`,
    }),
  },
  // Scenario 4 Candidate B (ranked #2 by sizeLabel 420 KB): Verified matching edition (2005 Penguin 9780141439983, bit-3 streaming ZIP)
  {
    md5: makeMd5('05'),
    matchTokens: ['invisible man'],
    title: 'The Invisible Man',
    author: 'H. G. Wells',
    language: 'English',
    sizeLabel: '420 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: 'The Invisible Man',
      creator: 'H. G. Wells',
      language: 'en',
      pubDate: '2005-04-28',
      modifiedDate: '2025-01-10T00:00:00Z',
      identifiers: [
        'urn:uuid:bbbbbbbb-2222-4222-8222-222222222202',
        '978-0-14-143998-3',
      ],
      useStreaming: true,
      uniqueSeed: `scenario4-${RUN_HEX}-candB-invisible-man-verified-2005-9780141439983`,
    }),
  },
];

const BY_MD5 = new Map(CATALOG.map((item) => [item.md5, item]));
const requestLog = [];

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
          <td><a href="edition.php?id=${item.md5}">${escHtml(item.title)}</a></td>
          <td>${escHtml(item.author)}</td>
          <td></td>
          <td></td>
          <td>${escHtml(item.language)}</td>
          <td>160</td>
          <td>${escHtml(item.sizeLabel)}</td>
          <td>${escHtml(item.format)}</td>
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
    <tr><td>Title: ${escHtml(item.title)} Author(s): ${escHtml(item.author)} Language: ${escHtml(item.language)} Extension: ${escHtml(item.format)} Size: ${escHtml(item.sizeLabel)}</td></tr>
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
    res.writeHead(200, {
      'Content-Type': 'application/epub+zip',
      'Content-Length': String(item.epubBytes.length),
      'Content-Disposition': `attachment; filename="${item.md5}.epub"`,
    });
    res.end(item.epubBytes);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ControlledLibgenMirror] Listening on 0.0.0.0:${PORT}`);
});
