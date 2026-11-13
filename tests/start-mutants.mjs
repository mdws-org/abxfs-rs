// site/start.js and site/published.js with one rule removed at a time; tests/start.mjs must FAIL against each.
// usage: node tests/start-mutants.mjs
import { readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const root = join(new URL('.', import.meta.url).pathname, '..');
const MUTANTS = [
  ['start', 'a whole root', 'const ROOT = /^0x[0-9a-f]{64}$/;', 'const ROOT = /^0x[0-9a-f]{64}/;'],
  ['start', 'a root from its first letter', 'const ROOT = /^0x[0-9a-f]{64}$/;', 'const ROOT = /0x[0-9a-f]{64}$/;'],
  ['start', 'no block for a chain with no light client', '  if (!built) return null;\n', ''],
  ['start', 'the built-in root given back not counting as the reader\'s', 'if (isRoot(own) && cleaned(own) !== built.root) return', 'if (isRoot(own)) return'],
  ['start', 'only a well-formed root', 'if (isRoot(own) && cleaned(own) !== built.root) return', 'if (own && cleaned(own) !== built.root) return'],
  ['start', 'saying the block is the reader\'s', 'if (start.own) return `yours, ${start.root}', 'if (false) return `yours, ${start.root}'],
  ['start', 'a remembered block newer than the built-in one', '&& r.slot > built.slot &&', '&&'],
  ['start', 'nothing remembered from the reader\'s root', 'if (!start || start.own || !fin', 'if (!start || !fin'],
  ['start', 'nothing remembered from a fallback', '|| fin.shipped ||', '||'],
  ['start', 'only something newer remembered', 'if (fin.finalizedSlot <= floor) return null;', ''],
  ['start', 'two hosts for an agreed start', '.filter((g) => g.hosts.size >= 2)', '.filter((g) => g.hosts.size >= 1)'],
  ['start', 'the newest agreed block', '.sort((x, y) => y.slot - x.slot)', '.sort((x, y) => x.slot - y.slot)'],
  ['published', 'build.txt being those two lines', 'if (!m) throw new Error(`${BUILD_FILE} on chain is not a build hash and a file hash`);', 'if (!m) return { build: "", sha256: "" };'],
  ['published', 'build.txt ending after its two lines', 'abxfs-check\\.html\\n?$/;', 'abxfs-check\\.html\\n?/;'],
  ['published', 'build.txt starting with its first line', 'const LINES = /^build ', 'const LINES = /build '],
  ['start', 'a reader\'s block needing a newer finalized block', "if (start.own && fin.shipped) return", "if (false) return"],
  ['start', 'the built-in block standing as the newest', "if (start.own && fin.shipped) return", "if (fin.shipped) return"],
  ['published', 'a whole hash', 'const HASH = /^[0-9a-f]{64}$/;', 'const HASH = /^[0-9a-f]{64}/;'],
  ['published', 'another build being different', "return published === mine ? { state: 'same'", "return true ? { state: 'same'"],
  ['published', 'a published build that was not read', 'if (published === null || published === undefined) return', 'if (false) return'],
  ['published', 'a copy that has no build', "if (!HASH.test(String(mine))) return { state: 'unknown', text: 'this copy does not know its own build' };", ''],
  ['published', 'a published value that is no hash', "if (!HASH.test(String(published))) return { state: 'unknown', text: 'what is published on chain is not a build hash' };", ''],
];
let bad = 0;
for (const [which, name, find, put] of MUTANTS) {
  const src = await readFile(join(root, `site/${which}.js`), 'utf8');
  const mutant = join(root, `site/${which}.mutant.js`);
  if (src.split(find).length !== 2) { console.log(`FAIL ${name}: the line to change is in ${which}.js ${src.split(find).length - 1} times`); bad++; continue; }
  try {
    await writeFile(mutant, src.replace(find, put));
    const args = which === 'start' ? ['../site/start.mutant.js', '../site/published.js'] : ['../site/start.js', '../site/published.mutant.js'];
    const caught = spawnSync(process.execPath, [join(root, 'tests/start.mjs'), ...args], { encoding: 'utf8' }).status === 1;
    if (!caught) bad++;
    console.log(`${caught ? 'ok  ' : 'FAIL'} without ${name}: the test ${caught ? 'fails' : 'still passes'}`);
  } finally { await rm(mutant, { force: true }); }
}
console.log(bad ? `${bad} of ${MUTANTS.length} changes NOT caught` : `ok: each of ${MUTANTS.length} changes fails the test`);
process.exit(bad ? 1 : 0);
