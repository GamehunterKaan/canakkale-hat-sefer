/** Municipal timetable refresh. Imports are side-effect free for offline tests. */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { refreshSchedules } from './lib/schedule-refresh.mjs';
import { aiParsePDF } from './lib/schedule-ai.mjs';

async function main() {
  if (process.argv.includes('--self-test')) {
    await import('../test/schedule-test.mjs');
    await import('../test/schedule-refresh-test.mjs');
    await import('../test/schedule-ai-test.mjs');
    return;
  }
  if (process.argv.length > 2) throw new Error('Usage: node scripts/fetch-schedule.mjs [--self-test]. Unsafe validation overrides are not supported.');
  // Without a key a PDF the parser rejects keeps its last verified times.
  const result = await refreshSchedules({ aiParse: process.env.ANTHROPIC_API_KEY ? aiParsePDF : null });
  for (const error of result.report.errors) console.error(error);
  const aiNotes = result.report.warnings.filter(w => w.includes(': AI transcription '));
  for (const note of aiNotes) console.error(note);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const sourceLines = result.report.sources.map(s => `- [${s.label}](${s.url})` +
      (s.state === 'ai' ? ' — published from an AI transcription (unverified)' : '')).join('\n');
    const omissions = result.report.sources.filter(s => s.indexOnlyRoutes?.length)
      .map(s => `${s.label}: index-only routes without timetable tables: ${s.indexOnlyRoutes.join(', ')}`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Timetable verification: ${result.ok ? 'passed' : 'FAILED'}\n\n` +
      `[Municipality timetable page](${result.report.sourcePage})\n\n${sourceLines}\n\n` +
      [...omissions, ...result.report.errors, ...aiNotes].map(e => `- ${e.replace(/\n/g, '; ')}`).join('\n') + '\n');
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exitCode = 1; });
}
