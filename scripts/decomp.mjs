#!/usr/bin/env node

/**
 * CLI interface for testing and inspecting the BookOrbit Shelfmark
 * title decomposition and candidate extraction algorithm.
 *
 * Usage:
 *   node scripts/decomp.mjs "The Lord of the Rings: Fellowship of the Ring"
 *   node scripts/decomp.mjs "Percy Jackson book 5: The Last Olympian" -a "Rick Riordan"
 *   node scripts/decomp.mjs "Book 7 of A to Z Mysteries: The Invisible Island" -a "Ron Roy" -e "The Invisible Island"
 *   node scripts/decomp.mjs --corpus "riordan"
 *   node scripts/decomp.mjs           # launches interactive REPL
 *
 * Shorthand syntax supported everywhere:
 *   "Title | Author => ExpectedTitle"
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  decomposeTitleStructure,
  extractCoreTitle,
  extractSearchTitleCandidates,
  extractSeriesVolumeNumber,
  isNoiseDerivative,
  isTitleMatch,
  normalizeString,
  stripEditionDescriptors,
  titleMatchDecision,
} from '../shared/identity.mjs';

const isColorSupported = !process.env.NO_COLOR && (process.stdout.isTTY || process.env.FORCE_COLOR);

const c = {
  reset: isColorSupported ? '\x1b[0m' : '',
  bold: isColorSupported ? '\x1b[1m' : '',
  dim: isColorSupported ? '\x1b[2m' : '',
  italic: isColorSupported ? '\x1b[3m' : '',
  red: isColorSupported ? '\x1b[31m' : '',
  green: isColorSupported ? '\x1b[32m' : '',
  yellow: isColorSupported ? '\x1b[33m' : '',
  blue: isColorSupported ? '\x1b[34m' : '',
  magenta: isColorSupported ? '\x1b[35m' : '',
  cyan: isColorSupported ? '\x1b[36m' : '',
  white: isColorSupported ? '\x1b[37m' : '',
  gray: isColorSupported ? '\x1b[90m' : '',
  bgCyan: isColorSupported ? '\x1b[46m\x1b[30m' : '',
  bgGreen: isColorSupported ? '\x1b[42m\x1b[30m' : '',
  bgRed: isColorSupported ? '\x1b[41m\x1b[30m' : '',
};

const CORPUS_PATHS = [
  process.env.CORPUS_PATH,
  '/home/dev/tmp/kilo/personal/bookorbit-plugin-shelfmark/fixtures/corpus.json',
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/corpus.json'),
].filter(Boolean);

function loadCorpus() {
  for (const p of CORPUS_PATHS) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf8'));
      } catch {}
    }
  }
  return null;
}

function parseShorthandInput(input) {
  let title = input.trim();
  let author = '';
  let expected = '';

  if (title.includes('=>')) {
    const parts = title.split('=>');
    title = parts[0].trim();
    expected = parts[1].trim();
  }

  if (title.includes(' | ')) {
    const parts = title.split(' | ');
    title = parts[0].trim();
    author = parts[1].trim();
  } else if (title.includes(' // ')) {
    const parts = title.split(' // ');
    title = parts[0].trim();
    author = parts[1].trim();
  }

  return { title, author, expected };
}

export function inspectTitle(rawTitle, options = {}) {
  const author = options.author || '';
  const seriesName = options.seriesName || '';
  const expectedTitle = options.expectedTitle || '';
  const candidateTitle = options.candidateTitle || '';

  const decomp = decomposeTitleStructure(rawTitle, { author, seriesName });
  const coreTitle = extractCoreTitle(rawTitle, { author, seriesName });
  const searchCandidates = extractSearchTitleCandidates(rawTitle, { author, seriesName });
  const volumeNumber = extractSeriesVolumeNumber(rawTitle, { author, seriesName });

  let expectedEvaluation = null;
  if (expectedTitle) {
    const primaryTitle = decomp.canonicalTitle || coreTitle;
    const directMatch = isTitleMatch(primaryTitle, expectedTitle, { author });
    const reverseMatch = isTitleMatch(expectedTitle, primaryTitle, { author });
    const normPrimary = normalizeString(primaryTitle);
    const normExpected = normalizeString(expectedTitle);
    const decision = titleMatchDecision(primaryTitle, expectedTitle, { author });

    const pass = directMatch || reverseMatch || (normPrimary && normPrimary === normExpected);
    expectedEvaluation = {
      expectedTitle,
      pass,
      decision,
      directMatch,
      reverseMatch,
    };
  }

  let candidateEvaluation = null;
  if (candidateTitle) {
    const decision = titleMatchDecision(candidateTitle, rawTitle, { author });
    const noise = isNoiseDerivative(candidateTitle, rawTitle);
    candidateEvaluation = {
      candidateTitle,
      isMatch: decision.outcome === 'match',
      isNoiseDerivative: noise,
      decision,
    };
  }

  return {
    rawTitle,
    author: author || null,
    seriesName: seriesName || null,
    canonicalTitle: decomp.canonicalTitle,
    coreTitle,
    primaryTitle: decomp.canonicalTitle || coreTitle,
    seriesPrefix: decomp.seriesPrefix,
    volumeNumber: decomp.volumeNumber ?? volumeNumber,
    hasExplicitPrefix: decomp.hasExplicitPrefix,
    substantiveTail: decomp.substantiveTail,
    colonRhsWorkCandidate: decomp.colonRhsWorkCandidate,
    byAuthorWorkCandidate: decomp.byAuthorWorkCandidate,
    segments: decomp.segments,
    forwardSegment: decomp.forwardSegment,
    backwardSegment: decomp.backwardSegment,
    slidingWindows: decomp.slidingWindows,
    searchCandidates,
    expectedEvaluation,
    candidateEvaluation,
    rawDecomp: decomp,
  };
}

function formatResult(res, { verbose = false } = {}) {
  const lines = [];

  lines.push('');
  lines.push(`${c.bold}${c.cyan}┌── Decomposition Inspector ───────────────────────────────────${c.reset}`);
  lines.push(`${c.bold}${c.cyan}│${c.reset} ${c.bold}Input Title:${c.reset}   ${c.yellow}"${res.rawTitle}"${c.reset}`);
  if (res.author) {
    lines.push(`${c.bold}${c.cyan}│${c.reset} ${c.bold}Author:${c.reset}        ${c.magenta}${res.author}${c.reset}`);
  }
  if (res.seriesName) {
    lines.push(`${c.bold}${c.cyan}│${c.reset} ${c.bold}Series Context:${c.reset}${res.seriesName}`);
  }

  lines.push(`${c.bold}${c.cyan}├─────────────────────────────────────────────────────────────${c.reset}`);
  lines.push(`${c.bold}${c.cyan}│${c.reset} ${c.bold}🎯 Canonical Title:${c.reset} ${c.bold}${c.green}"${res.canonicalTitle}"${c.reset}`);
  if (res.coreTitle && res.coreTitle !== res.canonicalTitle) {
    lines.push(`${c.bold}${c.cyan}│${c.reset} ${c.bold}🧩 Core Title:${c.reset}      "${res.coreTitle}"`);
  }

  if (res.seriesPrefix || res.volumeNumber !== null) {
    const series = res.seriesPrefix ? `"${res.seriesPrefix}"` : `${c.dim}(none)${c.reset}`;
    const vol = res.volumeNumber !== null ? `#${res.volumeNumber}` : `${c.dim}(none)${c.reset}`;
    lines.push(`${c.bold}${c.cyan}│${c.reset} ${c.bold}📚 Series / Vol:${c.reset}    ${series} ${c.bold}${c.blue}[Vol: ${vol}]${c.reset}`);
  }

  const flags = [];
  if (res.hasExplicitPrefix) flags.push(`${c.cyan}explicitPrefix${c.reset}`);
  if (res.substantiveTail) flags.push(`substantiveTail="${res.substantiveTail}"`);
  if (res.colonRhsWorkCandidate) flags.push(`colonRhs="${res.colonRhsWorkCandidate}"`);
  if (res.byAuthorWorkCandidate) flags.push(`byAuthor="${res.byAuthorWorkCandidate}"`);
  if (flags.length > 0) {
    lines.push(`${c.bold}${c.cyan}│${c.reset} ${c.bold}🏷️  Indicators:${c.reset}      ${flags.join('  ')}`);
  }

  if (res.segments && res.segments.length > 1) {
    lines.push(`${c.bold}${c.cyan}│${c.reset} ${c.bold}✂️  Segments (${res.segments.length}):${c.reset}  ${res.segments.map((s, i) => `[${i}] "${s}"`).join('  ')}`);
  }

  if (res.searchCandidates && res.searchCandidates.length > 0) {
    lines.push(`${c.bold}${c.cyan}│${c.reset} ${c.bold}🔍 Search Candidates (ranked for metadata lookup):${c.reset}`);
    res.searchCandidates.forEach((cand, idx) => {
      lines.push(`${c.bold}${c.cyan}│${c.reset}    ${c.dim}${idx + 1}.${c.reset} ${c.white}"${cand}"${c.reset}`);
    });
  }

  if (res.slidingWindows && res.slidingWindows.length > 0) {
    lines.push(`${c.bold}${c.cyan}│${c.reset} ${c.bold}🪟 Sliding Windows:${c.reset}   ${res.slidingWindows.map((w) => `"${w}"`).join(', ')}`);
  }

  if (res.expectedEvaluation) {
    const ev = res.expectedEvaluation;
    const badge = ev.pass
      ? `${c.bgGreen}${c.bold} MATCH PASS ${c.reset}`
      : `${c.bgRed}${c.bold} MATCH FAIL ${c.reset}`;
    lines.push(`${c.bold}${c.cyan}├─────────────────────────────────────────────────────────────${c.reset}`);
    lines.push(`${c.bold}${c.cyan}│${c.reset} ${c.bold}⚖️  Expected Verification:${c.reset} ${badge}`);
    lines.push(`${c.bold}${c.cyan}│${c.reset}    ${c.bold}Expected:${c.reset}      "${ev.expectedTitle}"`);
    lines.push(`${c.bold}${c.cyan}│${c.reset}    ${c.bold}Observed:${c.reset}      "${res.primaryTitle}"`);
    lines.push(`${c.bold}${c.cyan}│${c.reset}    ${c.bold}Outcome:${c.reset}       ${ev.decision.outcome} (workConfidence: ${ev.decision.workConfidence})`);
    if (ev.decision.conflicts?.length) {
      lines.push(`${c.bold}${c.cyan}│${c.reset}    ${c.bold}Conflicts:${c.reset}     ${c.red}${ev.decision.conflicts.join(', ')}${c.reset}`);
    }
  }

  if (res.candidateEvaluation) {
    const ce = res.candidateEvaluation;
    const badge = ce.isMatch
      ? `${c.bgGreen}${c.bold} MATCH ${c.reset}`
      : `${c.bgRed}${c.bold} REJECT ${c.reset}`;
    lines.push(`${c.bold}${c.cyan}├─────────────────────────────────────────────────────────────${c.reset}`);
    lines.push(`${c.bold}${c.cyan}│${c.reset} ${c.bold}🔬 Candidate Release Match Evaluation:${c.reset} ${badge}`);
    lines.push(`${c.bold}${c.cyan}│${c.reset}    ${c.bold}Candidate:${c.reset}     "${ce.candidateTitle}"`);
    lines.push(`${c.bold}${c.cyan}│${c.reset}    ${c.bold}Against:${c.reset}       "${res.rawTitle}"`);
    lines.push(`${c.bold}${c.cyan}│${c.reset}    ${c.bold}Outcome:${c.reset}       ${ce.decision.outcome} (conf: ${ce.decision.workConfidence})`);
    if (ce.isNoiseDerivative) {
      lines.push(`${c.bold}${c.cyan}│${c.reset}    ${c.bold}Derivative:${c.reset}    ${c.red}YES (Noise / Study Guide / Summary)${c.reset}`);
    }
    if (ce.decision.conflicts?.length) {
      lines.push(`${c.bold}${c.cyan}│${c.reset}    ${c.bold}Conflicts:${c.reset}     ${c.red}${ce.decision.conflicts.join(', ')}${c.reset}`);
    }
  }

  if (verbose) {
    lines.push(`${c.bold}${c.cyan}├─────────────────────────────────────────────────────────────${c.reset}`);
    lines.push(`${c.bold}${c.cyan}│${c.reset} ${c.bold}Raw Decomposition Object:${c.reset}`);
    const dump = JSON.stringify(res.rawDecomp, null, 2);
    dump.split('\n').forEach((l) => lines.push(`${c.bold}${c.cyan}│${c.reset}   ${c.dim}${l}${c.reset}`));
  }

  lines.push(`${c.bold}${c.cyan}└─────────────────────────────────────────────────────────────${c.reset}`);
  return lines.join('\n');
}

function printHelp() {
  console.log(`
${c.bold}Shelfmark Title Decomposition CLI${c.reset}

${c.bold}USAGE:${c.reset}
  node scripts/decomp.mjs [options] [title]
  npm run decomp -- [options] [title]

${c.bold}EXAMPLES:${c.reset}
  # Simple title decomposition
  node scripts/decomp.mjs "The Lord of the Rings: Fellowship of the Ring"

  # With author
  node scripts/decomp.mjs "Hercule Poirot: Mystery of the Blue Train" -a "Agatha Christie"

  # Shorthand syntax (title | author => expected)
  node scripts/decomp.mjs "Harry Potter 1: Philosopher's Stone | J.K. Rowling => Philosopher's Stone"

  # Compare against candidate release
  node scripts/decomp.mjs "1984" -c "Summary and Analysis of 1984"

  # Query / search corpus test cases
  node scripts/decomp.mjs --corpus "poirot"
  node scripts/decomp.mjs --corpus            # run full corpus evaluation

  # Output JSON
  node scripts/decomp.mjs "Percy Jackson book 5: The Last Olympian" --json

  # Interactive REPL mode
  node scripts/decomp.mjs

${c.bold}OPTIONS:${c.reset}
  -a, --author <name>       Author name for context-aware disambiguation
  -s, --series <name>       Series name for explicit series stripping
  -e, --expected <title>    Expected work title to verify match against
  -c, --candidate <title>   Test candidate release title match against input
  -j, --json                Output JSON structure
  -v, --verbose             Print full raw decomposition AST/properties
  -i, --interactive, --repl Force interactive REPL mode
  --corpus [filter]         Run or filter cases from test corpus
  -h, --help                Show this help message
`);
}

function runCorpus(filter = '') {
  const corpus = loadCorpus();
  if (!corpus) {
    console.error(`${c.red}Could not find corpus file. Checked CORPUS_PATH and fixtures/corpus.json${c.reset}`);
    process.exit(1);
  }

  const query = filter.toLowerCase().trim();
  const cases = query
    ? corpus.filter((item) =>
        (item.input_title || '').toLowerCase().includes(query) ||
        (item.expected_title || '').toLowerCase().includes(query) ||
        (item.expected_author || '').toLowerCase().includes(query)
      )
    : corpus;

  console.log(`\n${c.bold}Running Corpus Evaluation on ${cases.length} case(s)${query ? ` matching "${query}"` : ''}:${c.reset}\n`);

  let passCount = 0;
  let failCount = 0;

  for (let i = 0; i < cases.length; i++) {
    const item = cases[i];
    const res = inspectTitle(item.input_title, {
      author: item.expected_author,
      expectedTitle: item.expected_title,
    });

    const isPass = res.expectedEvaluation?.pass;
    if (isPass) {
      passCount++;
      if (cases.length <= 15) {
        console.log(` ${c.green}✔${c.reset} [#${i + 1}] "${item.input_title}" -> "${res.canonicalTitle}"`);
      }
    } else {
      failCount++;
      console.log(` ${c.red}✘${c.reset} [#${i + 1}] "${item.input_title}"`);
      console.log(`     ${c.dim}author:${c.reset}   "${item.expected_author || ''}"`);
      console.log(`     ${c.dim}expected:${c.reset} "${item.expected_title}"`);
      console.log(`     ${c.dim}got:${c.reset}      "${res.canonicalTitle}" (core: "${res.coreTitle}")`);
    }
  }

  const total = cases.length;
  const pct = total > 0 ? ((passCount / total) * 100).toFixed(1) : '0.0';
  console.log(`\n${c.bold}Summary:${c.reset} ${c.green}${passCount} passed${c.reset}, ${failCount > 0 ? `${c.red}${failCount} failed${c.reset}` : '0 failed'} / ${total} total (${pct}%)\n`);
}

function startRepl() {
  console.log(`
${c.bold}${c.cyan}Shelfmark Title Decomposition CLI${c.reset} (Type ${c.bold}:help${c.reset} for commands, ${c.bold}:quit${c.reset} to exit)
${c.dim}Format: Title [ | Author ] [ => ExpectedTitle ]${c.reset}
`);

  let jsonMode = false;
  let verboseMode = false;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.bold}${c.cyan}decomp>${c.reset} `,
  });

  rl.prompt();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    if (trimmed === ':q' || trimmed === ':quit' || trimmed === '.quit' || trimmed === 'exit' || trimmed === 'quit') {
      rl.close();
      return;
    }

    if (trimmed === ':help' || trimmed === '.help') {
      console.log(`
${c.bold}Commands:${c.reset}
  :help                 Show this help message
  :json                 Toggle JSON output mode (currently: ${jsonMode ? 'ON' : 'OFF'})
  :verbose              Toggle verbose output mode (currently: ${verboseMode ? 'ON' : 'OFF'})
  :corpus [query]       Search / evaluate corpus test cases (e.g. :corpus Riordan)
  :quit or :q           Exit the REPL

${c.bold}Input Syntax:${c.reset}
  <Title>
  <Title> | <Author>
  <Title> | <Author> => <ExpectedTitle>
  <Title> => <ExpectedTitle>
`);
      rl.prompt();
      return;
    }

    if (trimmed === ':json' || trimmed === '.json') {
      jsonMode = !jsonMode;
      console.log(`JSON mode is now ${jsonMode ? `${c.green}ON${c.reset}` : `${c.yellow}OFF${c.reset}`}`);
      rl.prompt();
      return;
    }

    if (trimmed === ':verbose' || trimmed === '.verbose') {
      verboseMode = !verboseMode;
      console.log(`Verbose mode is now ${verboseMode ? `${c.green}ON${c.reset}` : `${c.yellow}OFF${c.reset}`}`);
      rl.prompt();
      return;
    }

    if (trimmed.startsWith(':corpus') || trimmed.startsWith('.corpus')) {
      const q = trimmed.replace(/^[:.]corpus\s*/i, '').trim();
      runCorpus(q);
      rl.prompt();
      return;
    }

    const { title, author, expected } = parseShorthandInput(trimmed);
    const result = inspectTitle(title, {
      author,
      expectedTitle: expected,
    });

    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatResult(result, { verbose: verboseMode }));
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\nGoodbye!');
    process.exit(0);
  });
}

async function main() {
  const args = process.argv.slice(2);

  let author = '';
  let series = '';
  let expected = '';
  let candidate = '';
  let json = false;
  let verbose = false;
  let forceInteractive = false;
  let corpusMode = false;
  let corpusFilter = '';
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      printHelp();
      return;
    }
    if (arg === '-j' || arg === '--json') {
      json = true;
    } else if (arg === '-v' || arg === '--verbose') {
      verbose = true;
    } else if (arg === '-i' || arg === '--interactive' || arg === '--repl') {
      forceInteractive = true;
    } else if (arg === '-a' || arg === '--author') {
      author = args[++i] || '';
    } else if (arg === '-s' || arg === '--series') {
      series = args[++i] || '';
    } else if (arg === '-e' || arg === '--expected') {
      expected = args[++i] || '';
    } else if (arg === '-c' || arg === '--candidate') {
      candidate = args[++i] || '';
    } else if (arg === '--corpus') {
      corpusMode = true;
      if (args[i + 1] && !args[i + 1].startsWith('-')) {
        corpusFilter = args[++i];
      }
    } else if (arg.startsWith('--corpus=')) {
      corpusMode = true;
      corpusFilter = arg.slice(9);
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (corpusMode) {
    runCorpus(corpusFilter);
    return;
  }

  if (positional.length === 0 && !forceInteractive && !process.stdin.isTTY) {
    // Pipe / stdin mode
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;
      const parsed = parseShorthandInput(line);
      const res = inspectTitle(parsed.title, {
        author: parsed.author || author,
        seriesName: series,
        expectedTitle: parsed.expected || expected,
        candidateTitle: candidate,
      });
      if (json) {
        console.log(JSON.stringify(res));
      } else {
        console.log(formatResult(res, { verbose }));
      }
    }
    return;
  }

  if (positional.length === 0 || forceInteractive) {
    startRepl();
    return;
  }

  const rawInput = positional.join(' ');
  const parsed = parseShorthandInput(rawInput);
  const targetTitle = parsed.title;
  const targetAuthor = author || parsed.author;
  const targetExpected = expected || parsed.expected;

  const result = inspectTitle(targetTitle, {
    author: targetAuthor,
    seriesName: series,
    expectedTitle: targetExpected,
    candidateTitle: candidate,
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatResult(result, { verbose }));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
