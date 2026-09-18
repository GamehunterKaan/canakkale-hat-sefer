/** Municipal timetable refresh. Imports are side-effect free for offline tests. */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { refreshSchedules } from './lib/schedule-refresh.mjs';

async function main() {
  if (process.argv.includes('--self-test')) {
    await import('../test/schedule-test.mjs');
    await import('../test/schedule-refresh-test.mjs');
    return;
  }
  if (process.argv.length > 2) throw new Error('Usage: node scripts/fetch-schedule.mjs [--self-test]. Unsafe validation overrides are not supported.');
  const result = await refreshSchedules();
  for (const error of result.report.errors) console.error(error);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const sourceLines = result.report.sources.map(s => `- [${s.label}](${s.url})`).join('\n');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Timetable verification: ${result.ok ? 'passed' : 'FAILED'}\n\n${sourceLines}\n\n` +
      result.report.errors.map(e => `- ${e.replace(/\n/g, '; ')}`).join('\n') + '\n');
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exitCode = 1; });
}
