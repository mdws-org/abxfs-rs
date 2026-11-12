// The service worker's rule for a token page it has also computed itself (view/sw.js recheck and tokenGate), with
// made-up answers: only a difference puts a warning in front of the page; the warning shows both replies; the
// way through works only with the number the warning was given; nothing is computed when proving is off or the
// chain has no light client.
// usage: tools/build-view.py && node tests/recheck.mjs [path to a built sw.js]
const ORG = 'ff75c6d3d76fea5fa19f9a14422a87ee88717b5f';
const load = async (hostname) => {
  globalThis.self = { location: { hostname, origin: 'http://x' }, addEventListener() {}, clients: {} };
  return import((process.argv[2] || '../view-dist/_abxfs/sw.js') + `?${hostname}`);
};
const page = (reply, hash = '0x' + '11'.repeat(32)) => ({ read: { kind: 'page' }, sources: ['x.example', 'y.example'], block: 180, hash, call: { to: '0x' + ORG, data: '0xc87b56dd' }, reply });
const ran = (output, success = true) => ({ done: true, success, output, block: { number: 100 } });
const two = (r) => [['one.example', r], ['two.example', r]];
const on = async () => true, off = async () => false;
let asked = 0;
const compute = (value) => async () => { asked++; if (value instanceof Error) throw value; return value; };
const request = (path = '/', mode = 'navigate') => ({ url: 'http://x' + path, mode });
let bad = 0;
const check = (ok, name, got = '') => { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ': ' + got}`); };

// [name, host, page, deps, wanted state, whether the page is then gated, times computed]
const CASES = [
  ['computed here and the endpoints give the same', '1', page('0xaa'), { allowed: on, compute: compute({ computed: ran('0xaa'), atFinalized: two('0xaa') }) }, 'proved', false, 1],
  ['the reply has changed since the finalized block', '1', page('0xcc'), { allowed: on, compute: compute({ computed: ran('0xaa'), atFinalized: two('0xaa') }) }, 'newer', false, 1],
  ['this EVM does not run the call', '1', page('0xaa'), { allowed: on, compute: compute({ computed: { done: false, why: 'a log' }, atFinalized: [] }) }, 'agreed', false, 1],
  ['only one endpoint answered at the finalized block', '1', page('0xaa'), { allowed: on, compute: compute({ computed: ran('0xaa'), atFinalized: [['one.example', '0xaa']] }) }, 'agreed', false, 1],
  ['an endpoint returns another reply at the finalized block', '1', page('0xaa'), { allowed: on, compute: compute({ computed: ran('0xaa'), atFinalized: [...two('0xaa'), ['three.example', '0xbb']] }) }, 'differs', true, 1],
  ['the call fails here and the endpoints return a reply', '1', page('0xaa'), { allowed: on, compute: compute({ computed: ran('0x', false), atFinalized: two('0xaa') }) }, 'differs', true, 1],
  ['proving is switched off, though it would differ', '1', page('0xaa'), { allowed: off, compute: compute({ computed: ran('0xbb'), atFinalized: two('0xaa') }) }, 'agreed', false, 0],
  ['a chain with no light client, though it would differ', '8453', page('0xaa'), { allowed: on, compute: compute({ computed: ran('0xbb'), atFinalized: two('0xaa') }) }, 'agreed', false, 0],
];
let n = 0;
for (const [name, chainId, p, deps, want, gated, calls] of CASES) {
  const sw = await load(`${chainId}-${ORG}-${n++}.localhost`);
  asked = 0;
  const v = await sw.recheck(p, deps);
  const gate = sw.tokenGate(request(), p);
  check(v.state === want && Boolean(gate) === gated && asked === calls, name, `${v.state}, gated ${Boolean(gate)}, computed ${asked} times`);
}

// The warning and the way through.
const sw = await load(`1-${ORG}-99.localhost`);
const shown = page('0xaa'), mine = ran('0xbb');
await sw.recheck(shown, { allowed: on, compute: compute({ computed: mine, atFinalized: [...two('0xbb'), ['three.example', '0xaa']] }) });
const warning = sw.tokenGate(request(), shown);
const html = await warning.text();
check(warning.status === 502 && /compute different pages/.test(html), 'a difference puts a warning in front of the page', html.slice(0, 80));
check(html.includes(shown.hash) && /Computed here<\/h2><p><span class="mono">0x[0-9a-f]{64}/.test(html) && html.includes('block 100'), 'the warning shows both replies and the block', html.slice(0, 200));
check(/default-src 'none'/.test(warning.headers.get('content-security-policy') || ''), 'the warning page runs no script');
const nonce = (html.match(/\?abxfs-open=([0-9a-f]{32})"/) || [])[1];
check(Boolean(nonce), 'the warning holds a way through');
check((await sw.tokenGate(request('/', 'no-cors'), shown)).status === 502, 'a request that is not a navigation is refused while the warning stands');
check(sw.tokenGate(request('/?abxfs-open=' + '0'.repeat(32)), shown).status === 502, 'another number does not open the page');
check(sw.tokenGate(request('/?abxfs-open='), shown).status === 502, 'an empty number does not open the page');
check(sw.tokenGate(request('/'), page('0xdd', '0x' + '22'.repeat(32))) === null, 'a page made from another reply is not held back');
const opened = sw.tokenGate(request('/?abxfs-open=' + nonce), shown);
check(opened.status === 302 && opened.headers.get('location') === '/', 'the number from the warning opens the page');
check(sw.tokenGate(request('/'), shown) === null, 'and the page stays open afterwards');
const sw2 = await load(`1-${ORG}-98.localhost`);
await sw2.recheck(shown, { allowed: on, compute: compute({ computed: mine, atFinalized: [...two('0xbb'), ['three.example', '0xaa']] }) });
check(sw2.tokenGate(request('/?abxfs-open=' + nonce), shown).status === 502, 'a number from another warning does not open the page');
console.log(bad ? `${bad} FAILED` : 'ok: every recheck case');
process.exit(bad ? 1 : 0);
