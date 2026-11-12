// site/bamfs.js with one check removed at a time; tests/bamfs-replay.mjs must FAIL against each.
// usage: node tests/bamfs-mutants.mjs
import { readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const root = join(new URL('.', import.meta.url).pathname, '..');
const src = await readFile(join(root, 'site/bamfs.js'), 'utf8');
const MUTANTS = [
  ['a node hashing to its id', "if (H(Uint8Array.of(prefix), blob) !== id) refuse(`node ${id}: its contents do not hash to its id`);", ''],
  ['a directory\'s root node hashing to its CID (second generation)', "if (H(Uint8Array.of(0x12), fromHex(root)) !== cid) refuse(`directory ${cid}: its root node does not hash to its CID`);", ''],
  ['a file\'s record hashing to its CID (second generation)', "if (H(Uint8Array.of(0x11), fromHex(info.root), keccak256(mimeBytes), Uint8Array.of(info.compression), fromHex(info.outputHash)) !== cid) refuse(`file ${cid}: its record does not hash to its CID`);", ''],
  ['a directory\'s entries hashing to its CID (first generation)', "if (H(Uint8Array.of(0x02), keccak256(concat(...hashes))) !== cid) refuse(`directory ${cid}: its entries do not hash to its CID`);", ''],
  ['a file\'s record hashing to its CID (first generation)', "if (H(Uint8Array.of(0x01), keccak256(concat(...ids.map(fromHex))), keccak256(mimeBytes), Uint8Array.of(info.compression), fromHex(info.outputHash)) !== cid) refuse(`file ${cid}: its record does not hash to its CID`);", ''],
  ['a chunk\'s bytes hashing to its id', "if (H(BACKEND, payload) !== c.id) refuse(`chunk ${c.id}: its bytes do not hash to its id`);", ''],
  ['a FastLZ literal run inside the stream', "if (i + 1 + run > d.length) refuse('a FastLZ stream ends inside a literal run');", ''],
  ['a FastLZ back-reference inside the stream', "if (i + 1 + long >= d.length) refuse('a FastLZ stream ends inside a back-reference');", ''],
  ['a FastLZ reference after the start', "if (back > o) refuse('a FastLZ stream refers to bytes before its start');", ''],
];
// Second guards: what they check is already bound by a hash above, so removing one alone changes no outcome.
const SECOND_GUARDS = [
  ['a chunk\'s size matching its leaf', "if (c.size !== undefined && payload.length !== c.size) refuse(`chunk ${c.id} is ${payload.length} bytes, its leaf says ${c.size}`);", ''],
  ['an entry leaf ending at its last record', "if (at !== leaf.length) refuse('an entry leaf has bytes after its records');", ''],
  ['an entry leaf\'s offsets matching its records', "if (area + be(leaf, 3 + 2 * i, 2) !== at) refuse('an entry leaf\\'s offsets do not match its records');", ''],
];
const run = (file) => spawnSync(process.execPath, [join(root, 'tests/bamfs-replay.mjs'), file], { encoding: 'utf8' });
let bad = 0;
for (const [list, expectCaught] of [[MUTANTS, true], [SECOND_GUARDS, false]]) for (const [i, [what, find, put]] of list.entries()) {
  if (src.split(find).length !== 2) { console.log(`FAIL "${what}" does not match the source exactly once`); bad++; continue; }
  const file = join(root, `site/.bamfs-mutant-${expectCaught ? 'm' : 'g'}${i}.js`);
  await writeFile(file, src.replace(find, put));
  const r = run(file);
  await rm(file);
  const caught = r.status === 1;
  const ok = caught === expectCaught;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} without ${what}: ${caught ? 'caught: ' + (r.stdout.split('\n').find((l) => l.startsWith('FAIL')) || '').slice(0, 90) : expectCaught ? 'NOT CAUGHT' : 'still refused by a hash check, as expected'}`);
}
console.log(bad ? `${bad} problem(s)` : `ok: all ${MUTANTS.length} mutants caught, ${SECOND_GUARDS.length} second guards confirmed`);
process.exit(bad ? 1 : 0);
