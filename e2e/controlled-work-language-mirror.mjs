#!/usr/bin/env node
/**
 * Controlled Libgen-compatible HTTP fixture server for Work + Actual Reading-Language E2E (v1.7.7).
 *
 * Runs ONLY inside the isolated `e2e_default` Docker network (`e2e-fixture-mirror:18099`).
 * Serves `#tablelibgen` search HTML, `ads.php` resolution pages, and standards-compliant
 * >16 KB controlled OCF EPUB 3 files testing:
 *   1. Request #116 exact metadata (1984, ISBN 9791223228388, year 2026) fulfilled from
 *      English EPUB lacking ISBN, year, and dc:language, with accented English & mixed scripts.
 *   2. Different ISBN + different year + conflicting French metadata hint fulfilled from
 *      genuine English reading text (Jane Eyre by Charlotte Brontë).
 *   3. Deceptive English metadata + English cover/TOC + Spanish & mixed-script Korean chapters
 *      rejected before upload (The Picture of Dorian Gray by Oscar Wilde).
 *   4. Insufficient readable evidence (English cover + English TOC + image-scan chapters)
 *      routed to review_required before upload (Wuthering Heights by Emily Brontë).
 *   5. Bounded alternative recovery where Candidate A (exact ISBN + exact year + dc:language=en
 *      but Portuguese chapters) is rejected and Candidate B (absent ISBN/year + English chapters)
 *      automatically fulfills (Sense and Sensibility by Jane Austen).
 */

import http from 'node:http';

const PORT = Number(process.env.PORT || 18099);
const RUN_HEX = String(process.env.E2E_RUN_HEX || 'e2e777')
  .toLowerCase()
  .replace(/[^0-9a-f]/g, 'b')
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
  modifiedDate = '2026-01-15T10:00:00Z',
  identifiers = [],
  useStreaming = false,
  chapters = [],
  coverHtmlBody = null,
  navTocItems = ['Chapter One', 'Chapter Two', 'Chapter Three'],
  paddingBytes = 18000,
}) {
  const idXml = identifiers
    .map((id, idx) => `<dc:identifier id="id-${idx}">${esc(id)}</dc:identifier>`)
    .join('\n    ');
  const primaryId = identifiers.length > 0 ? 'id-0' : 'pub-fallback';
  const fallbackIdXml = identifiers.length === 0
    ? '<dc:identifier id="pub-fallback">urn:uuid:00000000-0000-4000-8000-000000000000</dc:identifier>'
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

  if (coverHtmlBody) {
    manifestItems.push(`<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="cover"/>`);
  }

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

  const navLis = navTocItems
    .map((label, idx) => `<li><a href="chapter${Math.min(idx + 1, Math.max(1, chapters.length))}.xhtml">${esc(label)}</a></li>`)
    .join('\n        ');
  const navXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><title>${esc(title)} - Table of Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
      ${navLis}
    </ol>
  </nav>
</body>
</html>`;

  // Stylesheet padding guarantees every controlled OCF archive exceeds Shelfmark's 10 KB file-size check
  // without polluting chapter prose (especially critical for testing insufficient-reading-text EPUBs!).
  const cssCommentPad = `/* Controlled E2E stylesheet padding (${RUN_HEX}) ${'x'.repeat(Math.max(1024, paddingBytes))} */\nbody { font-family: serif; line-height: 1.5; }\n`;

  const files = [
    { name: 'mimetype', data: Buffer.from('application/epub+zip', 'utf8'), stream: false },
    { name: 'META-INF/container.xml', data: Buffer.from(containerXml, 'utf8'), stream: useStreaming },
    { name: 'OEBPS/content.opf', data: Buffer.from(opfXml, 'utf8'), stream: useStreaming },
    { name: 'OEBPS/styles.css', data: Buffer.from(cssCommentPad, 'utf8'), stream: useStreaming },
    { name: 'OEBPS/nav.xhtml', data: Buffer.from(navXhtml, 'utf8'), stream: useStreaming },
  ];

  if (coverHtmlBody) {
    const coverXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head><title>Cover - ${esc(title)}</title></head>
<body>${coverHtmlBody}</body>
</html>`;
    files.push({ name: 'OEBPS/cover.xhtml', data: Buffer.from(coverXhtml, 'utf8'), stream: useStreaming });
  }

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

const ACCENTED_MIXED_ENGLISH_1984_CHAPTERS = [
  `<p>Epigraph: «Война — это мир, свобода — это рабство» — γνῶθι σεαυτόν — 자유와 진실.</p>
   <p>It was a bright cold day in April, and the clocks were striking thirteen as Winston Smith slipped through the glass doors of Victory Mansions. At the Chestnut Tree Café earlier that week, he had noticed the naïve façade of official optimism crumbling beside a worn résumé and a faded postcard from Zürich.</p>
   <p>Inside the flat a fruity voice was reading out a list of figures that had something to do with the production of pig-iron. Winston turned a switch and the voice sank somewhat, though the words were still distinguishable vis-à-vis the cold London wind outside.</p>`,
  `<p>Charlotte Brontë and Émile Zola might have recognized the strange déjà vu of life under the telescreen’s scrutiny, where every cliché of the régime was repeated from morning until night across the dreary squares of the city.</p>
   <p>He took down from the shelf a heavy cream-laid notebook with reassuringly smooth pages, dipped his pen into the inkwell, and began to write down what he had witnessed with his own eyes before memory itself could be rewritten.</p>`,
  `<p>Julia slipped a small folded note into his hand in the corridor—an audacious gesture that broke the grey monotony of their daily routine. When they finally met beneath the hazel boughs in the countryside, a thrush sang fearlessly from the hedge.</p>
   <p>Even if the future never read a single line of his diary, keeping faith with ordinary human truth mattered more than every slogan painted across the white pyramid of the Ministry.</p>`,
];

const ENGLISH_JANE_EYRE_CHAPTERS = [
  `<p>There was no possibility of taking a walk that afternoon at Gateshead Hall. We had been wandering, indeed, in the leafless shrubbery an hour in the morning; but since dinner the cold winter wind had brought with it clouds so sombre, and a rain so penetrating, that further outdoor exercise was now out of the question.</p>
   <p>I was glad of it: I never liked long walks, especially on chilly afternoons, when returning home through the twilight left me humbled beside Bessie and the Reed children in the drawing-room.</p>`,
  `<p>At Thornfield Hall, Monsieur Rochester spoke briefly of his ward Adèle and her Parisian gouvernante, yet every conversation around the hearth unfolded in clear, unmistakable English prose.</p>
   <p>Reader, I walked along the gallery above the courtyard and looked across the Yorkshire moors, convinced that an independent mind must judge character by truth and kindness rather than rank or fortune.</p>`,
  `<p>When spring returned to the orchard beneath the ancient chestnut tree, the evening air grew mild and fragrant, and the shadows of the house lengthened peacefully across the lawn as Jane listened to the distant rookery.</p>`,
];

const SPANISH_DORIAN_CHAPTERS = [
  `<p>El estudio estaba lleno del rico aroma de las rosas, y cuando la ligera brisa de verano agitaba los árboles del jardín, entraba por la puerta abierta el intenso perfume de las lilas o el aroma más delicado de los espinos en flor.</p>
   <p>Desde el rincón del diván persa en que yacía tendido, fumando innumerables cigarrillos como era su costumbre, Lord Henry Wotton divisaba apenas el resplandor de las dulces flores de color de miel.</p>`,
  `<p>En el centro de la habitación, sujeto a un caballete vertical, se alzaba el retrato de cuerpo entero de un joven de extraordinaria belleza, y delante de él, a cierta distancia, estaba sentado el artista mismo, Basil Hallward.</p>
   <p>Cuando el pintor contempló la graciosa y encantadora figura que con tanto arte había reflejado en su lienzo, una sonrisa de placer iluminó su rostro y pareció quedarse allí durante largo rato.</p>`,
  `<p>Es tu mejor obra, Basil, la mejor cosa que has hecho nunca —dijo Lord Henry con voz lánguida—. Debes enviarla sin falta el año próximo a la galería Grosvenor para que todo Londres pueda admirarla.</p>`,
];

const KOREAN_DORIAN_CHAPTERS = [
  `<p>화실 안은 장미의 진한 향기로 가득 차 있었고, 여름의 가벼운 산들바람이 정원의 나무들을 흔들 때마다 열린 문틈으로 라일락의 무거운 향기나 산사나무 꽃의 더욱 섬세한 향기가 밀려들어왔다 (Oscar Wilde, Dorian Gray, London).</p>
   <p>페르시아풍 긴 소파 구석에 누워 습관처럼 끝없이 담배를 피우고 있던 헨리 워튼 경은 달콤한 꿀빛 꽃들의 반짝임을 어렴풋이 바라보고 있었다.</p>`,
  `<p>방 한가운데 똑바로 세워진 이젤 위에는 비범한 아름다움을 지닌 한 젊은이의 전신 초상화가 놓여 있었고, 그 앞쪽 조금 떨어진 곳에는 화가인 바질 홀워드 자신이 앉아 있었다.</p>
   <p>화가가 자신의 예술로 그토록 우아하고 매력적인 모습을 화폭에 담아낸 것을 바라보았을 때, 기쁨의 미소가 그의 얼굴을 스치고 지나가며 오랫동안 머무는 듯했다.</p>`,
  `<p>이것은 자네 최고의 작품일세, 바질, 자네가 지금까지 그린 것 가운데 가장 훌륭한 걸작이야 하고 헨리 경이 나른한 목소리로 말했다. 내년에는 반드시 이 그림을 전시회에 보내야만 하네.</p>`,
];

const PORTUGUESE_SENSE_CHAPTERS = [
  `<p>A família Dashwood estava estabelecida havia muito tempo em Sussex. A sua propriedade era grande e a sua residência ficava em Norland Park, no centro das suas terras, onde durante muitas gerações tinham vivido de maneira tão respeitável que conquistaram a estima de todos os vizinhos.</p>
   <p>O antigo proprietário desta herdade era um homem solteiro que alcançou uma idade muito avançada e que durante muitos anos da sua vida teve na irmã uma companheira constante e uma governanta dedicada.</p>`,
  `<p>Mas a morte dela, ocorrida dez anos antes da sua própria, produziu uma grande alteração na sua casa; para suprir tal perda, ele convidou e recebeu na sua residência a família do sobrinho, o senhor Henry Dashwood, legítimo herdeiro da propriedade de Norland.</p>
   <p>Na companhia do sobrinho e da sobrinha, e dos filhos de ambos, a velhice do velho cavalheiro transcorreu de modo confortável, e o seu apego a todos eles cresceu a cada estação que passava.</p>`,
  `<p>Elinor, esta filha mais velha cujo conselho era tão eficaz, possuía uma força de entendimento e uma serenidade de julgamento que a qualificavam, embora tivesse apenas dezenove anos, para ser a conselheira da mãe em todas as dificuldades.</p>`,
];

const ENGLISH_SENSE_CHAPTERS = [
  `<p>The family of Dashwood had long been settled in Sussex. Their estate was large, and their residence was at Norland Park, in the centre of their property, where, for many generations, they had lived in so respectable a manner as to engage the general good opinion of their surrounding acquaintance.</p>
   <p>The late owner of this estate was a single man, who lived to a very advanced age, and who for many years of his life, had a constant companion and housekeeper in his sister.</p>`,
  `<p>By a former marriage, Mr. Henry Dashwood had one son: by his present lady, three daughters. The son, a steady respectable young man, was amply provided for by the fortune of his mother, which had been large, and half of which devolved on him on his coming of age.</p>
   <p>Elinor, this eldest daughter, whose advice was so effectual, possessed a strength of understanding, and coolness of judgment, which qualified her, though only nineteen, to be the counsellor of her mother.</p>`,
  `<p>Marianne’s abilities were, in many respects, quite equal to Elinor’s. She was sensible and clever; but eager in everything: her sorrows, her joys, could have no moderation. She was generous, amiable, interesting: she was everything but prudent.</p>`,
];

const CATALOG = [
  // Scenario 1: Exact Request #116 metadata (1984, ISBN 9791223228388, year 2026)
  // Fulfilled from streaming-ZIP English EPUB with NO ISBN, NO year, NO dc:language, accented words & mixed scripts
  {
    md5: makeMd5('01'),
    matchTokens: ['1984'],
    title: '1984',
    author: 'George Orwell',
    language: 'English',
    sizeLabel: '24 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: '1984',
      creator: 'George Orwell',
      language: null,
      pubDate: null,
      modifiedDate: '2025-02-01T12:00:00Z',
      identifiers: ['urn:uuid:11111111-2222-4333-8444-555555555501'],
      useStreaming: true,
      chapters: ACCENTED_MIXED_ENGLISH_1984_CHAPTERS,
    }),
  },

  // Scenario 2: Different ISBN (9780199535590 vs 9780141441146) + different year (1998 vs 2006)
  // + conflicting French release/OPF metadata hint, fulfilled from genuine English chapters
  {
    md5: makeMd5('02'),
    matchTokens: ['jane eyre'],
    title: 'Jane Eyre',
    author: 'Charlotte Brontë',
    language: 'French',
    sizeLabel: '24 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: 'Jane Eyre',
      creator: 'Charlotte Brontë',
      language: 'fr',
      pubDate: '1998-04-15',
      modifiedDate: '2024-06-01T00:00:00Z',
      identifiers: ['urn:isbn:9780199535590'],
      useStreaming: false,
      chapters: ENGLISH_JANE_EYRE_CHAPTERS,
    }),
  },

  // Scenario 3 Candidate A: Deceptive English metadata + English cover + English TOC + accented Spanish body text
  {
    md5: makeMd5('03'),
    matchTokens: ['picture of dorian gray'],
    title: 'The Picture of Dorian Gray',
    author: 'Oscar Wilde',
    language: 'English',
    sizeLabel: '650 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: 'The Picture of Dorian Gray',
      creator: 'Oscar Wilde',
      language: 'en',
      pubDate: '2003-04-24',
      identifiers: ['urn:isbn:9780141439570'],
      coverHtmlBody: '<h1>The Picture of Dorian Gray</h1><p>Complete and Unabridged English Penguin Classics Edition by Oscar Wilde with English Introduction and Critical Notes from London.</p>',
      navTocItems: [
        'The Preface: Art and Morality in Nineteenth-Century London',
        'Chapter One: Basil Hallward’s Studio and Lord Henry Wotton',
        'Chapter Two: Youth and Portrait in Mayfair',
      ],
      chapters: SPANISH_DORIAN_CHAPTERS,
    }),
  },

  // Scenario 3 Candidate B: Deceptive English metadata + English cover + English TOC + mixed-script Korean body text
  {
    md5: makeMd5('04'),
    matchTokens: ['picture of dorian gray'],
    title: 'The Picture of Dorian Gray',
    author: 'Oscar Wilde',
    language: 'English',
    sizeLabel: '420 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: 'The Picture of Dorian Gray',
      creator: 'Oscar Wilde',
      language: 'en',
      pubDate: '2003-04-24',
      identifiers: ['urn:isbn:9780141439570'],
      coverHtmlBody: '<h1>The Picture of Dorian Gray</h1><p>Authoritative English Text by Oscar Wilde published in London and New York.</p>',
      navTocItems: [
        'Chapter One: The Studio Rose Garden',
        'Chapter Two: The Portrait of Dorian Gray',
        'Chapter Three: Conversations in London',
      ],
      chapters: KOREAN_DORIAN_CHAPTERS,
    }),
  },

  // Scenario 4: Insufficient readable text (dc:language=en + rich English cover + 20 English TOC links + image-scan chapters) -> review_required
  {
    md5: makeMd5('05'),
    matchTokens: ['wuthering heights'],
    title: 'Wuthering Heights',
    author: 'Emily Brontë',
    language: 'English',
    sizeLabel: '24 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: 'Wuthering Heights',
      creator: 'Emily Brontë',
      language: 'en',
      pubDate: '2003-01-30',
      identifiers: ['urn:isbn:9780141439556'],
      coverHtmlBody: '<h1>Wuthering Heights by Emily Brontë</h1><p>This English cover blurb contains dozens of English words describing Heathcliff and Catherine Earnshaw on the Yorkshire moors, testing that cover pages never satisfy reading-language verification.</p>',
      navTocItems: Array.from({ length: 20 }, (_, i) => `Chapter ${i + 1}: Mr. Lockwood Visits Thrushcross Grange and Wuthering Heights`),
      chapters: [
        '<div><img src="scan001.jpg" alt="Scanned English page one from Yorkshire edition"/><p>Plate I</p></div>',
        '<div><img src="scan002.jpg" alt="Scanned English page two from Yorkshire edition"/><p>Plate II</p></div>',
      ],
    }),
  },

  // Scenario 5 Candidate A (ranked #1 by 650 KB): Exact ISBN + exact year + dc:language="en", BUT Portuguese reading chapters -> REJECTED!
  {
    md5: makeMd5('06'),
    matchTokens: ['sense and sensibility'],
    title: 'Sense and Sensibility',
    author: 'Jane Austen',
    language: 'English',
    sizeLabel: '650 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: 'Sense and Sensibility',
      creator: 'Jane Austen',
      language: 'en',
      pubDate: '2003-01-30',
      identifiers: ['urn:isbn:9780141439662'],
      coverHtmlBody: '<h1>Sense and Sensibility</h1><p>English Edition by Jane Austen</p>',
      chapters: PORTUGUESE_SENSE_CHAPTERS,
    }),
  },

  // Scenario 5 Candidate B (ranked #2 by 420 KB): NO ISBN, NO year, streaming ZIP, genuine English reading chapters -> FULFILLED!
  {
    md5: makeMd5('07'),
    matchTokens: ['sense and sensibility'],
    title: 'Sense and Sensibility',
    author: 'Jane Austen',
    language: 'English',
    sizeLabel: '420 KB',
    format: 'epub',
    epubBytes: buildControlledEpub({
      title: 'Sense and Sensibility',
      creator: 'Jane Austen',
      language: null,
      pubDate: null,
      modifiedDate: '2025-03-01T00:00:00Z',
      identifiers: ['urn:uuid:cccccccc-3333-4333-8333-333333333307'],
      useStreaming: true,
      chapters: ENGLISH_SENSE_CHAPTERS,
    }),
  },
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
          <td>220</td>
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
  console.log(`[ControlledWorkLangMirror] Listening on 0.0.0.0:${PORT} (RUN_HEX=${RUN_HEX}, items=${CATALOG.length})`);
});
