// site/refuse.js: what a host's setting refuses, then each rule changed in turn (the cases must then FAIL).
// usage: node tests/refuse.mjs
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
const L = '8453-ab025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6-0', HOST = `${L}.fromchain.example`;
const CASES = [
  ['a listed project is refused', { refuse: [L] }, HOST, true],
  ['a listed project in capitals and spaces is refused', { refuse: [`  ${L.toUpperCase()} `] }, HOST, true],
  ['another project is shown', { refuse: [L] }, `1-${'0'.repeat(40)}-0.fromchain.example`, false],
  ['a longer label that starts the same is shown', { refuse: [L] }, `${L}1.fromchain.example`, false],
  ['an empty list refuses nothing', { refuse: [] }, HOST, false],
  ['no list refuses nothing', { proof: true }, HOST, false],
  ['a list that is not a list refuses nothing', { refuse: L }, HOST, false],
  ['an entry that is not a string is skipped', { refuse: [{ label: L }, 7, null] }, HOST, false],
  ['an entry with other characters is skipped', { refuse: ['*', `${L}.fromchain.example`, '../x'] }, HOST, false],
  ['no setting refuses nothing', null, HOST, false],
  ['a setting that is a string refuses nothing', 'refuse', HOST, false],
  ['the check host is never refused by a project label', { refuse: [L] }, 'check.fromchain.example', false],
  ['a list past its limit refuses nothing', { refuse: Array.from({ length: 10_001 }, () => L) }, HOST, false],
  ['an empty hostname is shown', { refuse: [''] }, '', false],
];
async function run(file) {
  const { refuses } = await import(file + '?' + Math.random());
  return CASES.filter(([, setting, host, want]) => { try { return refuses(setting, host) !== want; } catch { return true; } }).map((c) => c[0]);
}
const bad = await run('../site/refuse.js');
for (const [name] of CASES) console.log(`${bad.includes(name) ? 'FAIL' : 'ok  '} ${name}`);
// Each rule changed in turn: the cases above must then fail.
const src = readFileSync(new URL('../site/refuse.js', import.meta.url), 'utf8');
const MUTANTS = [
  ['the list being a list', "Array.isArray(setting.refuse) ? setting.refuse : []", "setting.refuse ? [].concat(setting.refuse) : []"],
  ['the limit on the list', 'if (list.length > MAX_LIST) return new Set();', ''],
  ['an entry being a string', "if (typeof x === 'string') out.add", "out.add"],
  ['capitals not mattering', 'out.add(x.trim().toLowerCase());', 'out.add(x.trim());'],
  ['spaces not mattering', 'out.add(x.trim().toLowerCase());', 'out.add(x.toLowerCase());'],
  ['the label being the whole first part', "refusedLabels(setting).has(label)", "[...refusedLabels(setting)].some((r) => label.startsWith(r))"],
  ['an empty label never being refused', "label !== '' && ", ''],
  ['a listed label being refused', "return label !== '' && refusedLabels(setting).has(label);", 'return false;'],
];
let missed = 0;
for (const [name, find, put] of MUTANTS) {
  if (src.split(find).length !== 2) { console.log(`FAIL the change "${name}" does not apply once`); missed++; continue; }
  const f = new URL('../site/refuse.mutant.js', import.meta.url);
  writeFileSync(f, src.replace(find, put));
  const failed = await run('../site/refuse.mutant.js');
  rmSync(f);
  if (!failed.length) missed++;
  console.log(`${failed.length ? 'ok  ' : 'FAIL'} without ${name}: ${failed.length ? 'the test fails' : 'THE TEST STILL PASSES'}`);
}
console.log(bad.length || missed ? `${bad.length + missed} FAILED` : `ok: ${CASES.length} cases, and each of ${MUTANTS.length} changes fails them`);
process.exit(bad.length || missed ? 1 : 0);
