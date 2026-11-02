import { readFileSync, existsSync } from 'node:fs';

const WORK_DIR = '/home/dev/tmp/kilo/personal/bookorbit-plugin-shelfmark/work';
const s1Report = `${WORK_DIR}/suite1-full-live-report.json`;
const s2Report = `${WORK_DIR}/suite2-full-live-report.json`;

function summarizeSuite(name, path) {
  if (!existsSync(path)) {
    return { name, status: 'Not started / waiting for first checkpoint' };
  }
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const total = data.totalCases || 0;
    const evaluated = data.evaluatedLiveCases || (data.metadataResolution?.results?.length ?? 0);
    const work = data.metadataResolution?.workMatches ?? 0;
    const exact = data.metadataResolution?.exactPublicationMatches ?? 0;
    const isFinal = Boolean(data.isFinal);
    return {
      name,
      status: isFinal ? 'COMPLETED' : 'IN PROGRESS',
      progress: `${evaluated}/${total} (${((evaluated / total) * 100).toFixed(1)}%)`,
      workMatches: `${work}/${evaluated} (${evaluated ? ((work / evaluated) * 100).toFixed(1) : 0}%)`,
      exactPublicationMatches: `${exact}/${evaluated} (${evaluated ? ((exact / evaluated) * 100).toFixed(1) : 0}%)`,
      decompPassRate: data.decomposition?.passRate || 'N/A',
      lastUpdated: data.generatedAt,
    };
  } catch (err) {
    return { name, error: err.message };
  }
}

console.log('========================================================================');
console.log('LIVE FULL SUITE EVALUATION PROGRESS DASHBOARD');
console.log('========================================================================\n');
console.log(JSON.stringify({
  suite1: summarizeSuite('Suite 1 (13,954 cases)', s1Report),
  suite2: summarizeSuite('Suite 2 (13,575 cases)', s2Report),
}, null, 2));
