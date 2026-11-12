// The service worker's rule for comparing the agreed root with the proof (view/sw.js settle), with made-up
// answers: it must stop on a mismatch and only on a mismatch, and must not ask for a proof when proving is off.
// usage: tools/build-view.py && node tests/settle.mjs [path to a built sw.js]
const ORG = 'e8978b5d18980fa16494fb83167c84cbbe9a6816';
const load = async (hostname) => {
  globalThis.self = { location: { hostname, origin: 'http://x' }, addEventListener() {}, clients: {} };
  return import((process.argv[2] || '../view-dist/_abxfs/sw.js') + `?${hostname}`);
};
const A = '0x' + 'aa'.repeat(32), B = '0x' + 'bb'.repeat(32);
const proved = { known: true, root: A, block: { number: 100 }, participants: 500, via: 'p.example' };
const two = (r) => [['one.example', r], ['two.example', r]];
const head = (root) => ({ root, block: 180, sources: ['x.example', 'y.example'] });
const on = async () => true, off = async () => false;
let asked = 0;
const prove = (value) => async () => { asked++; if (value instanceof Error) throw value; return value; };

const eth = await load(`1-${ORG}-0.localhost`);
// [name, agreed head, deps, wanted state or 'stop']
const CASES = [
  ['all three agree', head(A), { allowed: on, prove: prove({ proved, atFinalized: two(A) }) }, 'proved'],
  ['published since the finalized block', head(B), { allowed: on, prove: prove({ proved, atFinalized: two(A) }) }, 'newer'],
  ['the endpoints give another root at the finalized block', head(B), { allowed: on, prove: prove({ proved, atFinalized: two(B) }) }, 'stop'],
  ['one endpoint gives another root at the finalized block', head(A), { allowed: on, prove: prove({ proved, atFinalized: [...two(A), ['three.example', B]] }) }, 'stop'],
  ['the proof cannot be made', head(A), { allowed: on, prove: prove(new Error('the beacon servers are down')) }, 'agreed'],
  ['the shipped root is too old', head(A), { allowed: on, prove: prove(Object.assign(new Error('past the 14 days'), { kind: 'stale' })) }, 'agreed'],
  ['the contract is not a known collection', head(A), { allowed: on, prove: prove({ proved: { known: false, why: 'not a collection' }, atFinalized: [] }) }, 'agreed'],
  ['proving is switched off, though the proof would mismatch', head(B), { allowed: off, prove: prove({ proved, atFinalized: two(B) }) }, 'agreed', 0],
];
let bad = 0;
for (const [name, got, deps, want, calls] of CASES) {
  asked = 0;
  let state;
  try { state = (await eth.settle(got, deps)).state; } catch (e) { state = e.kind === 'mismatch' && e.verdict && e.agreed ? 'stop' : `crash: ${e.message}`; }
  const ok = state === want && (calls === undefined || asked === calls);
  bad += !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${state}${calls === undefined ? '' : `, proof asked for ${asked} time(s)`}`);
}
// A chain with no light client: no proof is asked for, whatever it would say.
const base = await load(`8453-${ORG}-0.localhost`);
asked = 0;
const s = await base.settle(head(B), { allowed: on, prove: prove({ proved, atFinalized: two(B) }) });
const ok = s.state === 'agreed' && asked === 0;
bad += !ok;
console.log(`${ok ? 'ok  ' : 'FAIL'} a chain with no light client: ${s.state}, proof asked for ${asked} time(s)`);
// A proof that arrives after the page was answered. If it does not match, that must stand from then on.
{
  const sw = await load(`1-${ORG}-3.localhost`);
  const slow = (value) => () => new Promise((r) => setTimeout(() => r(value), 60));
  const quick = await sw.settle(head(B), { allowed: on, prove: slow({ proved, atFinalized: two(B) }), waitMs: 10 });
  const before = sw.standingMismatch();
  await new Promise((r) => setTimeout(r, 120));
  const after = sw.standingMismatch();
  const okLate = quick.state === 'agreed' && before === null && after && after.kind === 'mismatch';
  bad += !okLate;
  console.log(`${okLate ? 'ok  ' : 'FAIL'} a mismatch that arrives after the page was answered: answered as ${quick.state}, then ${after ? 'the mismatch stands' : 'nothing stands'}`);
  const sw2 = await load(`1-${ORG}-4.localhost`);
  await sw2.settle(head(A), { allowed: on, prove: slow({ proved, atFinalized: two(A) }), waitMs: 10 });
  await new Promise((r) => setTimeout(r, 120));
  const none = sw2.standingMismatch();
  bad += none !== null;
  console.log(`${none === null ? 'ok  ' : 'FAIL'} a late proof that matches leaves nothing standing`);
}
// The host's switch: off is seen and kept; a host that later says "on" again does not turn proving back on.
{
  const sw = await load(`1-${ORG}-1.localhost`);
  let serve = { proof: false };
  globalThis.fetch = async () => new Response(JSON.stringify(serve));
  const first = await sw.proofAllowed();
  serve = { proof: true };
  const second = await sw.proofAllowed();
  const ok2 = first === false && second === false;
  bad += !ok2;
  console.log(`${ok2 ? 'ok  ' : 'FAIL'} the switch served off, then on: ${first}, then ${second}`);
  const fresh = await load(`1-${ORG}-2.localhost`);
  globalThis.fetch = async () => { throw new TypeError('unreachable'); };
  const third = await fresh.proofAllowed();
  bad += third !== true;
  console.log(`${third === true ? 'ok  ' : 'FAIL'} the switch cannot be reached: ${third}`);
}
console.log(bad ? `${bad} FAILED` : `ok: ${CASES.length + 5} cases`);
process.exit(bad ? 1 : 0);
