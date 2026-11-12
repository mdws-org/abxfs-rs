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
// Rollups.
const { judgeRollup } = await import(process.argv[2] || '../site/verdict.js');
const at = (root, number) => ({ known: true, root, block: { number } });
const ROLLUP = [
  ['the current root is the root at the final claim', { anchor: at(A, 10), latest: at(A, 90), agreedHead: head(A) }, 'settled'],
  ['the current root is the root at the newest claim only', { anchor: at(B, 10), latest: at(A, 90), agreedHead: head(A) }, 'claimed'],
  ['published since the newest claim', { anchor: at(B, 10), latest: at(C, 90), agreedHead: head(A) }, 'agreed'],
  ['there is no newest claim that counts; the final one matches', { anchor: at(A, 10), latest: null, agreedHead: head(A) }, 'settled'],
  ['there is no newest claim that counts; the final one differs', { anchor: at(B, 10), latest: null, agreedHead: head(A) }, 'agreed'],
  ['the project did not exist at either claim', { anchor: { known: false, why: 'no contract' }, latest: { known: false, why: 'no contract' }, agreedHead: head(A) }, 'agreed'],
  ['no proof could be made', { anchor: null, latest: null, agreedHead: head(A) }, 'agreed'],
  ['the final claim differs and the newest could not be read', { anchor: at(B, 10), latest: { known: false, why: 'the endpoint was down' }, agreedHead: head(A) }, 'agreed', /could not be read: the endpoint was down/],
  ['both claims were read and differ', { anchor: at(B, 10), latest: at(C, 90), agreedHead: head(A) }, 'agreed', /published after block 90/],
];
for (const [name, input, want, says] of ROLLUP) {
  const got = judgeRollup(input);
  const ok = got.state === want && Boolean(got.reason) && (!says || says.test(got.reason));
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} rollup: ${name}: ${got.state}${ok ? '' : `, wanted ${want}${says ? ' saying ' + says : ''}; said: ${got.reason}`}`);
}
// Pages a contract computes.
const { judgeComputed } = await import(process.argv[2] || '../site/verdict.js');
const ran = (output, success = true) => ({ done: true, success, output, block: { number: 70 } });
const COMPUTED = [
  ['computed here, two endpoints the same at that block, the same now', { computed: ran('0xaa'), atFinalized: [['a', '0xaa'], ['b', '0xaa']], headReply: '0xaa', headBlock: 80 }, 'proved'],
  ['one endpoint of three returns another reply at that block', { computed: ran('0xaa'), atFinalized: [['a', '0xaa'], ['b', '0xbb'], ['c', '0xaa']], headReply: '0xaa', headBlock: 80 }, 'differs'],
  ['every endpoint returns another reply at that block', { computed: ran('0xaa'), atFinalized: [['a', '0xbb'], ['b', '0xbb']], headReply: '0xbb', headBlock: 80 }, 'differs'],
  ['the only endpoint that answered returns another reply', { computed: ran('0xaa'), atFinalized: [['a', '0xbb']], headReply: '0xaa', headBlock: 80 }, 'differs'],
  ['only one endpoint answered at that block', { computed: ran('0xaa'), atFinalized: [['a', '0xaa']], headReply: '0xaa', headBlock: 80 }, 'agreed'],
  ['no endpoint answered at that block', { computed: ran('0xaa'), atFinalized: [], headReply: '0xaa', headBlock: 80 }, 'agreed'],
  ['the reply has changed since that block', { computed: ran('0xaa'), atFinalized: [['a', '0xaa'], ['b', '0xaa']], headReply: '0xcc', headBlock: 80 }, 'newer'],
  ['the endpoints agreed on another reply at that very block', { computed: ran('0xaa'), atFinalized: [['a', '0xaa'], ['b', '0xaa']], headReply: '0xcc', headBlock: 70 }, 'differs'],
  ['the finalized block is far behind the endpoints', { computed: ran('0xaa'), atFinalized: [['a', '0xaa'], ['b', '0xaa']], headReply: '0xaa', headBlock: 471 }, 'agreed'],
  ['the finalized block is ahead of the endpoints', { computed: ran('0xaa'), atFinalized: [['a', '0xaa'], ['b', '0xaa']], headReply: '0xaa', headBlock: 69 }, 'agreed'],
  ['the endpoints\' block is not known', { computed: ran('0xaa'), atFinalized: [['a', '0xaa'], ['b', '0xaa']], headReply: '0xaa' }, 'agreed'],
  ['a call the choice of page rested on was not recomputed the same', { computed: ran('0xaa'), atFinalized: [['a', '0xaa'], ['b', '0xaa']], headReply: '0xaa', headBlock: 80, supporting: [{ ok: true, why: 'x' }, { ok: false, why: 'the status was not recomputed' }] }, 'agreed'],
  ['every call the choice of page rested on was recomputed the same', { computed: ran('0xaa'), atFinalized: [['a', '0xaa'], ['b', '0xaa']], headReply: '0xaa', headBlock: 80, supporting: [{ ok: true, why: 'x' }] }, 'proved'],
  ['the call fails at that block', { computed: ran('0x', false), atFinalized: [], headReply: '0xaa', headBlock: 80 }, 'agreed'],
  ['the call fails here and an endpoint returns a reply there', { computed: ran('0x', false), atFinalized: [['a', '0xaa'], ['b', '0xaa']], headReply: '0xaa', headBlock: 80 }, 'differs'],
  ['this EVM does not run the call', { computed: { done: false, why: 'this viewer\'s EVM does not run a log' }, atFinalized: [], headReply: '0xaa', headBlock: 80 }, 'agreed'],
  ['nothing was computed', { computed: null, atFinalized: [], headReply: '0xaa', headBlock: 80 }, 'agreed'],
];
for (const [name, input, want] of COMPUTED) {
  const got = judgeComputed(input);
  // A call that fails here must be said to fail, whatever else is said.
  const said = !(input.computed && input.computed.success === false) || /fails/.test(got.reason);
  if (got.state !== want || !got.reason || !said) bad++;
  console.log(`${got.state === want && got.reason ? 'ok  ' : 'FAIL'} computed: ${name}: ${got.state}${got.state === want ? '' : `, wanted ${want}`}`);
}
// Pages a contract computes on a rollup.
const { judgeRollupComputed } = await import(process.argv[2] || '../site/verdict.js');
const ON_ROLLUP = [
  ['computed here to the reply shown, no endpoint keeps the block', { computed: ran('0xaa'), atClaim: [], headReply: '0xaa' }, 'recomputed', /not compared/],
  ['computed here to the reply shown, one endpoint the same', { computed: ran('0xaa'), atClaim: [['a', '0xaa']], headReply: '0xaa' }, 'recomputed', /1 endpoint returned the same/],
  ['an endpoint returns another reply at that block', { computed: ran('0xaa'), atClaim: [['a', '0xaa'], ['b', '0xbb']], headReply: '0xaa' }, 'differs', /b returns another/],
  ['the call fails here and an endpoint returns a reply', { computed: ran('0x', false), atClaim: [['a', '0xaa']], headReply: '0xaa' }, 'differs', /a returns another/],
  ['the call fails here, nothing to compare', { computed: ran('0x', false), atClaim: [], headReply: '0xaa' }, 'agreed', /fails/],
  ['the reply now is another', { computed: ran('0xaa'), atClaim: [], headReply: '0xcc' }, 'agreed', /changed since that block, or this viewer computes it differently/],
  ['the reply now is another, and an endpoint agreed at that block', { computed: ran('0xaa'), atClaim: [['a', '0xaa']], headReply: '0xcc' }, 'agreed', /which 1 endpoint also returned there.*the page changed since that block$/],
  ['this EVM does not run the call', { computed: { done: false, why: 'opcode 0x43, which this viewer does not run on this chain' }, atClaim: [], headReply: '0xaa' }, 'agreed', /0x43/],
  ['a supporting call did not come out the same', { computed: ran('0xaa'), atClaim: [], headReply: '0xaa', supporting: [{ ok: false, why: 'the status was not recomputed' }] }, 'agreed', /status/],
  ['nothing was computed', { computed: null, atClaim: [], headReply: '0xaa' }, 'agreed', /not recomputed/],
];
for (const [name, input, want, says] of ON_ROLLUP) {
  const got = judgeRollupComputed(input);
  const ok = got.state === want && says.test(got.reason) && got.state !== 'proved';
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} on a rollup: ${name}: ${got.state}${ok ? '' : `, wanted ${want} saying ${says}; said: ${got.reason}`}`);
}
console.log(bad ? `${bad} FAILED` : `ok: ${CASES.length + ROLLUP.length + COMPUTED.length + ON_ROLLUP.length} verdict cases`);
process.exit(bad ? 1 : 0);
