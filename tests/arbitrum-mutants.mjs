// site/arbitrum.js with one rule removed at a time; tests/arbitrum-rules.mjs must FAIL against each.
// usage: node tests/arbitrum-mutants.mjs
import { readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const root = join(new URL('.', import.meta.url).pathname, '..');
const src = await readFile(join(root, 'site/arbitrum.js'), 'utf8');
const MUTANTS = [
  ['the rollup contract existing', "if (!top.exists) refuse(`${r.name}'s rollup contract does not exist at the finalized block`);", ''],
  ['the admin logic being the pinned one', 'addressOf(top.words[0]) !== r.primary || ', ''],
  ['the user logic being the pinned one', ' || addressOf(top.words[1]) !== r.secondary', ''],
  ['a confirmed assertion existing', "if (BigInt(assertion) === 0n) refuse(`${r.name} has no confirmed assertion`);", ''],
  ['the assertion being marked confirmed', "if (Number((node >> 200n) & 0xffn) !== CONFIRMED) refuse(`${r.name}'s newest confirmed assertion is not marked confirmed`);", ''],
  ['the assertion naming a possible Ethereum block', "if (!createdAtBlock || createdAtBlock > top.block.number) refuse(`${r.name}'s newest confirmed assertion names an Ethereum block that cannot be right`);", ''],
  ['what the log gives hashing to the assertion', 'if (hash(parent, hash(...after), d[19]) !== assertion) continue;', ''],
  ['the log being well formed', 'if (!d || !parent) continue;', 'if (!d || !parent) return { blockHash: "0x00" };'],
];
let bad = 0;
for (const [i, [what, find, put]] of MUTANTS.entries()) {
  if (src.split(find).length !== 2) { console.log(`FAIL mutant ${i}: "${what}" does not match the source exactly once`); bad++; continue; }
  const file = join(root, `site/.arbitrum-mutant-${i}.js`);
  await writeFile(file, src.replace(find, put));
  const r = spawnSync(process.execPath, [join(root, 'tests/arbitrum-rules.mjs'), file], { encoding: 'utf8' });
  await rm(file);
  const caught = r.status === 1;
  console.log(`${caught ? 'ok  ' : 'FAIL'} without ${what}: ${caught ? 'caught: ' + (r.stdout.split('\n').find((l) => l.startsWith('FAIL')) || '').slice(0, 100) : 'NOT CAUGHT'}`);
  if (!caught) bad++;
}
console.log(bad ? `${bad} mutant(s) not caught` : `ok: all ${MUTANTS.length} mutants caught`);
process.exit(bad ? 1 : 0);
