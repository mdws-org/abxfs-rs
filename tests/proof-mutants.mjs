// Do the proof tests have teeth? Each mutant is site/proof.js with one check removed; tests/proof-replay.mjs is
// run against it and must FAIL. A mutant that passes means a check nothing tests.
// usage: node tests/proof-mutants.mjs
import { readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(new URL('.', import.meta.url).pathname, '..');
const src = await readFile(join(root, 'site/proof.js'), 'utf8');
const MUTANTS = [
  ['each node hashing to what its parent names', 'if (!equal(keccak256(raw), want))', 'if (false)'],
  ['the leaf path matching the key', 'const matches = part.length <= 64 - at && part.every((n, i) => n === nibbles[at + i]);', 'const matches = true;'],
  ['a leaf ending exactly at the key\'s end', "if (at !== 64) refuse(`${what}: a leaf before the end of the key`);", ''],
  ['no nodes after a leaf', "if (used !== proof.length) refuse(`${what}: nodes after the proof ended`);\n        return target;", 'return target;'],
  ['no nodes after an empty branch slot', "else if (child.length === 0) { if (used !== proof.length) refuse(`${what}: nodes after the proof ended`); return null; }", 'else if (child.length === 0) { return null; }'],
  ['a proof that stops early', "if (used >= proof.length) refuse(`${what}: the proof stops before the key is reached`);", 'if (used >= proof.length) return null;'],
  ['an extension naming a node', "if (!Array.isArray(target) && target.length !== 32) refuse(`${what}: an extension that names no node`);", ''],
  ['a proof being a list', "if (!Array.isArray(list) || list.length > MAX_NODES) refuse(`${what} is not a proof`);", ''],
  ['RLP: a limit on nesting', "if (depth > RLP_DEPTH) refuse('RLP: lists nested too deep');", ''],
  ['RLP: bytes after the item', "if (end !== u.length) refuse('RLP: bytes after the item');", ''],
  ['RLP: a small byte as a string', "if (len === 1 && u[start] < 0x80) refuse('RLP: a single small byte encoded as a string');", ''],
  ['RLP: long form for a short length', "if (len < 56) refuse('RLP: long form used for a short length');", ''],
  ['RLP: a length with a leading zero', "if (u[at] === 0) refuse('RLP: length has a leading zero');", ''],
  ['RLP: an item past its list', "if (next > end) refuse('RLP: list item runs past its list');", ''],
  ['the header hashing to the proved block', 'if (got !== blockHash.toLowerCase())', 'if (false)'],
  ['a proof offered for empty storage', "if (nodes.length) refuse('a proof was given for an empty storage');", ''],
  ['the account having four fields', "if (!Array.isArray(fields) || fields.length !== 4 || fields[2].length !== 32 || fields[3].length !== 32) refuse('the account is not four fields');", ''],
  ['storage keyed by the hash of the slot', "keccak256(bytes(slot, 'slot', 32))", "bytes(slot, 'slot', 32)"],
  ['accounts keyed by the hash of the address', "keccak256(bytes(address, 'address', 20))", "bytes('0x' + '00'.repeat(12) + address.slice(2), 'address', 32)"],
  ['stored words without leading zeros', "if (!(u instanceof Uint8Array) || u.length > max || (u.length && u[0] === 0)) refuse(`${what} is not a canonical integer`);", ''],
  ['a stored zero', "if (!value.length) refuse('a zero word is stored, which the trie never holds');", ''],
  ['quantities without leading zeros in the header', 'const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/i;', 'const QUANTITY = /^0x[0-9a-f]+$/i;'],
];
let bad = 0;
for (const [i, [what, find, put]] of MUTANTS.entries()) {
  if (src.split(find).length !== 2) { console.log(`FAIL mutant ${i}: "${what}" does not match the source exactly once`); bad++; continue; }
  const file = join(root, `site/.proof-mutant-${i}.js`);
  await writeFile(file, src.replace(find, put));
  const r = spawnSync(process.execPath, [join(root, 'tests/proof-replay.mjs'), file], { encoding: 'utf8' });
  await rm(file);
  const caught = r.status === 1;
  const first = (r.stdout.split('\n').find((l) => l.startsWith('FAIL')) || '').slice(0, 120);
  console.log(`${caught ? 'ok  ' : 'FAIL'} without ${what}: ${caught ? 'caught: ' + first : 'NOT CAUGHT (exit ' + r.status + ') ' + (r.stderr || '').split('\n')[0].slice(0, 80)}`);
  if (!caught) bad++;
}
console.log(bad ? `${bad} mutant(s) not caught` : `ok: all ${MUTANTS.length} mutants caught`);
process.exit(bad ? 1 : 0);
