// The verdict rule (site/verdict.js), case by case.
// usage: node tests/verdict.mjs [path to verdict.js]
const { judge } = await import(process.argv[2] || '../site/verdict.js');
const A = '0x' + 'aa'.repeat(32), B = '0x' + 'bb'.repeat(32), C = '0x' + 'cc'.repeat(32);
const proved = { known: true, root: A, block: { number: 100 } };
const two = (r) => [['one.example', r], ['two.example', r]];
const head = (root, block = 180) => ({ root, block });
const CASES = [
  ['proof, endpoints at that block and the head all give one root', { proved, atFinalized: two(A), agreedHead: head(A) }, 'proved'],
  ['the head has moved on since the finalized block', { proved, atFinalized: two(A), agreedHead: head(B) }, 'newer'],
  ['the endpoints give another root at the finalized block', { proved, atFinalized: two(B), agreedHead: head(B) }, 'mismatch'],
  ['one endpoint of three gives another root at the finalized block', { proved, atFinalized: [...two(A), ['three.example', C]], agreedHead: head(A) }, 'mismatch'],
  ['the endpoints lie at the finalized block but the head matches the proof', { proved, atFinalized: two(B), agreedHead: head(A) }, 'mismatch'],
  ['a single endpoint answers at the finalized block, with another root', { proved, atFinalized: [['one.example', B]], agreedHead: head(A) }, 'mismatch'],
  ['nobody answers at the finalized block, though the head matches the proof', { proved, atFinalized: [], agreedHead: head(A) }, 'agreed'],
  ['one endpoint answers at the finalized block and agrees; the head matches too', { proved, atFinalized: [['one.example', A]], agreedHead: head(A) }, 'agreed'],
  ['nobody answers at the finalized block; the head differs', { proved, atFinalized: [], agreedHead: head(B) }, 'agreed'],
  ['the proved block is 400 blocks behind the endpoints', { proved, atFinalized: two(A), agreedHead: head(A, 500) }, 'proved'],
  ['the proved block is 401 blocks behind the endpoints (an old block offered as the newest)', { proved, atFinalized: two(A), agreedHead: head(A, 501) }, 'agreed'],
  ['the endpoints for the current root are AT the proved block and give another root', { proved, atFinalized: two(A), agreedHead: head(B, 100) }, 'mismatch'],
  ['the endpoints for the current root are at the proved block and give the same root', { proved, atFinalized: two(A), agreedHead: head(A, 100) }, 'proved'],
  ['the endpoints are behind the proved block and give another root', { proved, atFinalized: two(A), agreedHead: head(B, 99) }, 'agreed'],
  ['the proved block is ahead of the endpoints', { proved, atFinalized: two(A), agreedHead: head(A, 99) }, 'agreed'],
  ['the endpoints\' block is not known', { proved, atFinalized: two(A), agreedHead: { root: A } }, 'agreed'],
  ['no proof: the contract is not a known collection', { proved: { known: false, why: 'not a collection' }, atFinalized: [], agreedHead: head(A) }, 'agreed'],
  ['no proof was attempted', { proved: null, agreedHead: head(A) }, 'agreed'],
];
let bad = 0;
for (const [name, input, want] of CASES) {
  const got = judge(input);
  if (got.state !== want || !got.reason) bad++;
  console.log(`${got.state === want && got.reason ? 'ok  ' : 'FAIL'} ${name}: ${got.state}${got.state === want ? '' : `, wanted ${want}`}`);
}
console.log(bad ? `${bad} FAILED` : `ok: ${CASES.length} verdict cases`);
process.exit(bad ? 1 : 0);
