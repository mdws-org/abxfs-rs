// The service worker's rule for a token page it has also computed itself (view/sw.js recheck and tokenGate), with
// made-up answers: only a difference puts a warning in front of the page; the warning shows the replies' hashes;
// the way through is the warning's own link followed as a page load, and nothing a script on the same origin
// can do opens the page or reads that link; a run that started earlier does not undo a later one; nothing is
// computed when proving is off or the chain has no light client.
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
const request = (path = '/', mode = 'navigate', destination = 'document') => ({ url: 'http://x' + path, mode, destination });
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
  const gate = sw.tokenGate(request());
  check(v.state === want && Boolean(gate) === gated && asked === calls, name, `${v.state}, gated ${Boolean(gate)}, computed ${asked} times`);
}

// The warning and the way through.
const differ = { computed: ran('0xbb'), atFinalized: [...two('0xbb'), ['three.example', '0xaa']] };
const sw = await load(`1-${ORG}-99.localhost`);
const shown = page('0xaa');
await sw.recheck(shown, { allowed: on, compute: compute(differ) });
const warning = sw.tokenGate(request());
const html = await warning.text();
const csp = warning.headers.get('content-security-policy') || '';
check(warning.status === 502 && /compute different pages/.test(html), 'a difference puts a warning in front of the page', html.slice(0, 80));
check(html.includes(shown.hash) && /Computed here, at that block<\/h2><p><span class="mono">0x[0-9a-f]{64}/.test(html) && html.includes('block 100') && html.includes('three.example'), 'the warning shows the hash computed here, each endpoint\'s at that block, and the page\'s', html.slice(0, 300));
check(/default-src 'none'/.test(csp) && /(^|; )sandbox( |;|$)/.test(csp) && /frame-ancestors 'none'/.test(csp), 'the warning runs no script, is sandboxed and may not be framed', csp);
check(warning.headers.get('cross-origin-opener-policy') === 'same-origin', 'the warning is cut off from a window that opened it');
const nonce = (html.match(/\?abxfs-open=([0-9a-f]{32})"/) || [])[1];
check(Boolean(nonce), 'the warning holds a way through');
// What a script on the project's own origin can try.
const framed = sw.tokenGate(request('/', 'navigate', 'iframe'));
check(framed.status === 502 && !/abxfs-open/.test(await framed.text()), 'a frame gets no link');
const fetched = sw.tokenGate(request('/', 'cors', ''));
check(fetched.status === 502 && !/abxfs-open/.test(await fetched.text()), 'a fetch gets no link');
check(sw.tokenGate(request('/?abxfs-open=' + nonce, 'cors', '')).status === 502 && sw.tokenGate(request()).status === 502, 'a fetch with the right number opens nothing');
check(sw.tokenGate(request('/?abxfs-open=' + nonce, 'navigate', 'iframe')).status === 502 && sw.tokenGate(request()).status === 502, 'a frame with the right number opens nothing');
check(sw.tokenGate(request('/?abxfs-open=' + '0'.repeat(32))).status === 502, 'another number does not open the page');
check(sw.tokenGate(request('/?abxfs-open=')).status === 502, 'an empty number does not open the page');
// A reply that changes from block to block does not get past the warning: it stands for the project.
check(sw.tokenGate(request()).status === 502, 'the warning stands whatever reply the page is now made from');
const opened = sw.tokenGate(request('/?abxfs-open=' + nonce));
check(opened.status === 302 && opened.headers.get('location') === '/', 'the warning\'s link, followed as a page load, opens the page');
check(sw.tokenGate(request()) === null, 'and the page stays open afterwards');
const sw2 = await load(`1-${ORG}-98.localhost`);
await sw2.recheck(shown, { allowed: on, compute: compute(differ) });
check(sw2.tokenGate(request('/?abxfs-open=' + nonce)).status === 502, 'a number from another warning does not open the page');

// Runs that end out of order: one that started earlier does not undo what a later one found.
const later = (value, ms) => async () => { await new Promise((r) => setTimeout(r, ms)); return value; };
const same = { computed: ran('0xaa'), atFinalized: two('0xaa') };
const sw3 = await load(`1-${ORG}-97.localhost`);
await Promise.all([sw3.recheck(shown, { allowed: on, compute: later(same, 40) }), sw3.recheck(shown, { allowed: on, compute: later(differ, 5) })]);
check(sw3.tokenGate(request()) !== null, 'an earlier run that ends later with "the same" does not remove the warning');
await sw3.recheck(shown, { allowed: on, compute: compute(same) });
check(sw3.tokenGate(request()) === null, 'a later run that finds the same removes it');
const sw4 = await load(`1-${ORG}-96.localhost`);
await sw4.recheck(shown, { allowed: on, compute: compute(differ) });
await sw4.recheck(page('0xcc'), { allowed: on, compute: compute(same) });
check(sw4.tokenGate(request()) !== null, 'a later run that only finds the page changed does not remove it');
console.log(bad ? `${bad} FAILED` : 'ok: every recheck case');
process.exit(bad ? 1 : 0);
