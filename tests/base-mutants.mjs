// site/base.js with one rule removed at a time; tests/base-rules.mjs and tests/base-replay.mjs are run against
// each and at least one must FAIL.
// usage: node tests/base-mutants.mjs
import { readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const root = join(new URL('.', import.meta.url).pathname, '..');
const src = await readFile(join(root, 'site/base.js'), 'utf8');
const MUTANTS = [
  ['an upgraded contract is not read', "if (addressOf(a.words[0]) !== want) refuse(`${name} has been upgraded since this viewer was written, so its storage is not read`);", ''],
  ['the portal naming this registry', "if (addressOf(portal.words[0]) !== REGISTRY) refuse('the portal names another anchor state registry');", ''],
  ['the registry naming this factory', "if (addressOf(registry.words[0]) !== FACTORY) refuse('the registry names another dispute game factory');", ''],
  ['the respected game type', "if (Number(packed & 0xffffffffn) !== GAME_TYPE) refuse('the registry respects a game type this viewer does not read');", ''],
  ['the factory\'s implementation for the type', "if (addressOf(factory.words[0]) !== '0x' + GAME_IMPL) refuse('the factory creates games from another implementation');", ''],
  ['the anchor having won', "if (anchor.status !== STATUS.defenderWins) refuse('the anchor game did not resolve in the claimant\\'s favour');", ''],
  ['the clone being the pinned one', '!code.startsWith(CLONE_HEAD) || ', ''],
  ['the factory\'s record naming this game', 'if (addressOf(word(record)) !== proxy || Number(record >> 224n) !== GAME_TYPE)', 'if (false)'],
  ['the factory\'s record giving the type', ' || Number(record >> 224n) !== GAME_TYPE) refuse(`the factory has no record', ') refuse(`the factory has no record'],
  ['the blacklist', 'if (blacklisted) refuse(`the game at ${proxy} is blacklisted`);', ''],
  ['respected when created', 'if (!((s0 >> 144n) & 0xffn)) refuse(`the game at ${proxy} was not of the respected type when it was created`);', ''],
  ['retirement', 'if (createdAt <= retirementTimestamp) refuse(`the game at ${proxy} is retired`);', ''],
  ['a challenged newest game not counting', 'g.status !== STATUS.challengerWins && ', ''],
  ['a newest game needing a proof', 'g.proofCount >= 1 && ', ''],
  ['a newest game not older than the anchor', ' && g.l2Block >= anchor.l2Block', ''],
  ['the newest game being of the respected type', 'if (Number(newest >> 224n) === GAME_TYPE) {', 'if (true) {'],
  ['the output root equalling the claim', 'if (outputRoot !== claim.rootClaim)', 'if (false)'],
];
let bad = 0;
for (const [i, [what, find, put]] of MUTANTS.entries()) {
  if (src.split(find).length !== 2) { console.log(`FAIL mutant ${i}: "${what}" does not match the source exactly once`); bad++; continue; }
  const file = join(root, `site/.base-mutant-${i}.js`);
  await writeFile(file, src.replace(find, put));
  const runs = ['tests/base-rules.mjs', 'tests/base-replay.mjs'].map((t) => spawnSync(process.execPath, [join(root, t), file], { encoding: 'utf8' }));
  await rm(file);
  const caught = runs.some((r) => r.status === 1);
  const first = (runs.map((r) => r.stdout.split('\n').find((l) => l.startsWith('FAIL'))).find(Boolean) || '').slice(0, 110);
  console.log(`${caught ? 'ok  ' : 'FAIL'} without ${what}: ${caught ? 'caught: ' + first : 'NOT CAUGHT ' + runs.map((r) => r.status).join(',') + ' ' + (runs.map((r) => r.stderr.split('\n').find((l) => /Error/.test(l))).find(Boolean) || '').slice(0, 90)}`);
  if (!caught) bad++;
}
console.log(bad ? `${bad} mutant(s) not caught` : `ok: all ${MUTANTS.length} mutants caught`);
process.exit(bad ? 1 : 0);
