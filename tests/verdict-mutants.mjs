// The rule for pages a contract computes (judgeComputed in site/verdict.js) with one condition removed at a time;
// tests/verdict.mjs must FAIL against each.
// usage: node tests/verdict-mutants.mjs
import { readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const root = join(new URL('.', import.meta.url).pathname, '..');
const src = await readFile(join(root, 'site/verdict.js'), 'utf8');
const MUTANTS = [
  ['an endpoint that returns another reply being a warning', "  if (dissent.length) return { state: 'differs',", "  if (dissent.length > 99) return { state: 'differs',"],
  ['two endpoints at the finalized block', 'if (atFinalized.length < 2) return { state: \'agreed\', reason: `the page was recomputed', 'if (atFinalized.length < 1) return { state: \'agreed\', reason: `the page was recomputed'],
  ['the same reply now', "if (headReply !== computed.output) return behind === 0", "if (false) return behind === 0"],
  ['a call that fails here while an endpoint returns a reply being a warning', 'if (!computed.success && atFinalized.length) return', 'if (false) return'],
  ['a call that fails here being said to fail', "  if (!computed.success) return { state: 'agreed',", "  if (false) return { state: 'agreed',"],
  ['the finalized block being near the endpoints\' block', 'if (!near) return', 'if (false) return'],
  ['the finalized block not being ahead of the endpoints', 'near = behind >= 0 &&', 'near = behind >= -9 &&'],
  ['another reply at the same block being a warning', "return behind === 0 ? { state: 'differs',", "return false ? { state: 'differs',"],
  ['the calls the choice of page rested on', 'if (unsure) return', 'if (false) return'],
  ['a call that was not run', "if (!computed || !computed.done) return { state: 'agreed',", "if (!computed) return { state: 'agreed',"],
];
const mutant = join(root, 'site/verdict.mutant.js');
let bad = 0;
try {
  for (const [name, find, put] of MUTANTS) {
    if (src.split(find).length !== 2) { console.log(`FAIL ${name}: the line to change is in verdict.js ${src.split(find).length - 1} times`); bad++; continue; }
    await writeFile(mutant, src.replace(find, put));
    const r = spawnSync(process.execPath, [join(root, 'tests/verdict.mjs'), '../site/verdict.mutant.js'], { encoding: 'utf8' });
    const caught = r.status === 1;
    if (!caught) bad++;
    console.log(`${caught ? 'ok  ' : 'FAIL'} without ${name}: the test ${caught ? 'fails' : 'still passes'}`);
  }
} finally { await rm(mutant, { force: true }); }
console.log(bad ? `${bad} of ${MUTANTS.length} changes NOT caught` : `ok: each of ${MUTANTS.length} changes to the rule fails the test`);
process.exit(bad ? 1 : 0);
