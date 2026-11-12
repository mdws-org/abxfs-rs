// The verdict rule (site/verdict.js), case by case.
// usage: node tests/verdict.mjs [path to verdict.js]
const { judge } = await import(process.argv[2] || '../site/verdict.js');
const A = '0x' + 'aa'.repeat(32), B = '0x' + 'bb'.repeat(32), C = '0x' + 'cc'.repeat(32);
const proved = { known: true, root: A, block: { number: 100 } };
const two = (r) => [['one.example', r], ['two.example', r]];
const CASES = [
  ['proof, endpoints at that block and the head all give one root', { proved, atFinalized: two(A), agreedHead: { root: A } }, 'proved'],
  ['the head has moved on since the finalized block', { proved, atFinalized: two(A), agreedHead: { root: B } }, 'newer'],
  ['the endpoints give another root at the finalized block', { proved, atFinalized: two(B), agreedHead: { root: B } }, 'mismatch'],
  ['one endpoint of three gives another root at the finalized block', { proved, atFinalized: [...two(A), ['three.example', C]], agreedHead: { root: A } }, 'mismatch'],
  ['the endpoints lie at the finalized block but the head matches the proof', { proved, atFinalized: two(B), agreedHead: { root: A } }, 'mismatch'],
  ['a single endpoint answers at the finalized block, with another root', { proved, atFinalized: [['one.example', B]], agreedHead: { root: A } }, 'mismatch'],
  ['nobody answers at the finalized block; the head matches the proof', { proved, atFinalized: [], agreedHead: { root: A } }, 'proved'],
  ['nobody answers at the finalized block; the head differs', { proved, atFinalized: [], agreedHead: { root: B } }, 'agreed'],
  ['one endpoint answers at the finalized block and agrees; the head differs', { proved, atFinalized: [['one.example', A]], agreedHead: { root: B } }, 'agreed'],
  ['no proof: the contract is not a known collection', { proved: { known: false, why: 'not a collection' }, atFinalized: [], agreedHead: { root: A } }, 'agreed'],
  ['no proof was attempted', { proved: null, agreedHead: { root: A } }, 'agreed'],
];
let bad = 0;
for (const [name, input, want] of CASES) {
  const got = judge(input);
  if (got.state !== want || !got.reason) bad++;
  console.log(`${got.state === want && got.reason ? 'ok  ' : 'FAIL'} ${name}: ${got.state}${got.state === want ? '' : `, wanted ${want}`}`);
}
console.log(bad ? `${bad} FAILED` : `ok: ${CASES.length} verdict cases`);
process.exit(bad ? 1 : 0);
