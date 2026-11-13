// The rules site/arbitrum.js applies to a rollup contract on Ethereum, against made-up storage words and logs.
// usage: node tests/arbitrum-rules.mjs [path to arbitrum.js]
import { keccak256 } from '../site/keccak-lookup.js';
const { confirmed } = await import(process.argv[2] || '../site/arbitrum.js');
const hx = (u) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const fb = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/../g)?.map((x) => parseInt(x, 16)) ?? []);
const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const k = (...h) => '0x' + hx(keccak256(fb(h.map((x) => x.replace(/^0x/, '')).join(''))));
const ROLLUP = '0x4dceb440657f21083db8add07665f8ddbe1dcfc0';
const PRIMARY = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', SECONDARY = '0x2b1dbce74324248c222f0ec2d5ed7bd323cfc425b336f0253c5ccfda7265546d';
const BLOCK_HASH = 'b1'.repeat(32);

function world(tweak = () => {}) {
  const parent = '0x' + 'aa'.repeat(32);
  const after = [BLOCK_HASH, 'c2'.repeat(32), w(77), w(0), w(1), 'd3'.repeat(32)];
  const inbox = 'e4'.repeat(32);
  const t = { store: {}, parent, after, inbox, createdAt: 900, status: 2, head: 1000, logs: null };
  t.assertion = k(parent, k(...after), inbox);
  const data = () => '0x' + [...Array(7).fill(w(9)), ...Array(6).fill(w(8)), ...t.after, t.inbox, ...Array(5).fill(w(7))].join('');
  t.store[PRIMARY] = '0x' + w('0x7fc126ff51183a78c5e0437467f325f661d8df17');
  t.store[SECONDARY] = '0x' + w('0x6490ba0a60cc7d3a59c9eee135d9eed24553a60d');
  tweak(t, 'before');
  t.store['0x' + w(116)] ??= t.assertion;
  t.store[k(t.store['0x' + w(116)], w(117))] ??= '0x' + w((BigInt(t.createdAt) << 128n) | (1n << 192n) | (BigInt(t.status) << 200n));
  t.logs ??= [{ topics: ['0x' + '00'.repeat(32), t.assertion, t.parent], data: data() }];
  tweak(t, 'after');
  return {
    provedAccount: async ({ slots }) => ({ exists: !t.gone, codeHash: '0x' + '00'.repeat(32), words: slots.map((s) => t.store[s] || '0x' + w(0)), block: { number: t.head, hash: '0x' + '99'.repeat(32), timestamp: 5 } }),
    logs: async () => t.logs,
  };
}
const at = (phase, fn) => (t, when) => { if (when === phase) fn(t); };
const CASES = [
  ['an honest state', undefined, '0x' + BLOCK_HASH],
  ['the rollup contract does not exist', at('before', (t) => { t.gone = true; }), 'refuse'],
  ['the admin logic was upgraded', at('before', (t) => { t.store[PRIMARY] = '0x' + w('0x' + '77'.repeat(20)); }), 'upgraded'],
  ['the user logic was upgraded', at('before', (t) => { t.store[SECONDARY] = '0x' + w('0x' + '77'.repeat(20)); }), 'upgraded'],
  ['there is no confirmed assertion', at('before', (t) => { t.store['0x' + w(116)] = '0x' + w(0); }), 'refuse'],
  ['the assertion is not marked confirmed', at('before', (t) => { t.status = 1; }), 'refuse'],
  ['the assertion names an Ethereum block after the proved one', at('before', (t) => { t.createdAt = 1001; }), 'refuse'],
  ['the assertion names no Ethereum block', at('before', (t) => { t.createdAt = 0; }), 'refuse'],
  ['the log gives another block hash for the rollup', at('after', (t) => { t.logs[0].data = t.logs[0].data.replace(BLOCK_HASH, 'b2'.repeat(32)); }), 'rpc'],
  ['the log gives another inbox accumulator', at('after', (t) => { t.logs[0].data = t.logs[0].data.replace('e4'.repeat(32), 'e5'.repeat(32)); }), 'rpc'],
  ['the log names another parent', at('after', (t) => { t.logs[0].topics[2] = '0x' + 'ab'.repeat(32); }), 'rpc'],
  ['the log is malformed', at('after', (t) => { t.logs[0].data = '0x1234'; }), 'rpc'],
  ['a wrong log comes before the right one', at('after', (t) => { t.logs.unshift({ topics: ['0x', t.assertion, '0x' + 'ab'.repeat(32)], data: t.logs[0].data }); }), '0x' + BLOCK_HASH],
  ['there is no log', at('after', (t) => { t.logs = []; }), 'rpc'],
];
let bad = 0;
for (const [name, tweak, want] of CASES) {
  let got;
  try { got = (await confirmed({ fin: {}, urls: [], chainId: 42161, deps: world(tweak) })).blockHash; } catch (e) { got = e.kind === 'check' ? 'refuse' : e.kind === 'upgraded' ? 'upgraded' : e.kind === 'rpc' ? 'rpc' : `crash: ${e.message}`; }
  const ok = got === want;
  bad += !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (wanted ${want})`}`);
}
console.log(bad ? `${bad} FAILED` : `ok: ${CASES.length} cases`);
process.exit(bad ? 1 : 0);
