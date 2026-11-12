// The rules site/base.js applies to Base's contracts on Ethereum, against a made-up Ethereum state. Proofs are
// tested elsewhere (proof-replay); here the words a proof would give are supplied directly, so that each rule
// can be met by a state that breaks only it.
// usage: node tests/base-rules.mjs [path to base.js]
import { keccak256 } from '../site/keccak-lookup.js';
const { baseClaims } = await import(process.argv[2] || '../site/base.js');
const hx = (u) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const fb = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/../g)?.map((x) => parseInt(x, 16)) ?? []);
const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const k = (...h) => '0x' + hx(keccak256(fb(h.map((x) => x.replace(/^0x/, '')).join(''))));
const S = (n) => '0x' + w(n);
const PORTAL = '0x49048044d57e1c92a77f79988d21fa8faf74e97e', REGISTRY = '0x909f6cf47ed12f010a796527f562bfc26c7f4e72', FACTORY = '0x43edb88c4b80fdd2adff2412a7bebf9df42cb40e';
const IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const GAME_IMPL = 'c08b8ffaf04abb1d7013b74a0e57eccbd7fa5a70';
const HEAD = '36602c57343d527f9e4ac34f21c619cefc926c8bd93b54bf5a39c7ab2127a895af1cc0691d7e3dff593da1005b363d3d373d3d3d3d61030a806062363936013d73' + GAME_IMPL + '5af43d3d93803e606057fd5bf3';
const RETIRED = 1_000_000;

// A game's code: head, creator, claim, L1 parent hash, L2 block, parent game, intermediate roots, length.
function gameCode({ claim, l2Block, head = HEAD }) {
  const args = 'c1'.repeat(20) + claim.slice(2) + 'ab'.repeat(32) + w(l2Block) + 'de'.repeat(20) + 'ee'.repeat(776 - 20 - 32 - 32 - 32 - 20);
  return '0x' + head + args + '030a';
}
// The world: address -> slot -> word, and address -> code. `tweak` edits it to break one rule.
function world(tweak = () => {}) {
  const store = {}, code = {};
  const set = (a, slot, word) => { (store[a] ||= {})[slot] = '0x' + w(word); };
  const addGame = (proxy, { claim, l2Block, createdAt, status, proofs = 1, respected = 1, type = 621, record = true }) => {
    code[proxy] = gameCode({ claim, l2Block });
    set(proxy, S(0), BigInt(createdAt) | (BigInt(createdAt + 500) << 64n) | (BigInt(status) << 128n) | (1n << 136n) | (BigInt(respected) << 144n));
    set(proxy, S(7), (BigInt(proofs) << 64n) | 5n);
    const extra = code[proxy].slice(2 + HEAD.length + 168, -4);
    const uuid = k(w(621), claim, w(96), w(extra.length / 2), extra + '0'.repeat((64 - (extra.length % 64)) % 64));
    if (record) set(FACTORY, k(uuid, w(103)), (BigInt(type) << 224n) | (BigInt(createdAt) << 160n) | BigInt(proxy));
    return (BigInt(type) << 224n) | (BigInt(createdAt) << 160n) | BigInt(proxy);
  };
  const A = '0x' + 'a1'.repeat(20), N = '0x' + 'b2'.repeat(20);
  const t = { A, N, set, addGame, store, code, anchor: { claim: '0x' + '11'.repeat(32), l2Block: 5000, createdAt: 2_000_000, status: 2 }, newest: { claim: '0x' + '22'.repeat(32), l2Block: 11000, createdAt: 2_400_000, status: 0 }, listLength: 7n, listType: undefined };
  set(PORTAL, IMPL, '0x03863ab7f64b733cff85c8ff44a86601c568ca70'); set(PORTAL, S(62), REGISTRY);
  set(REGISTRY, IMPL, '0x4483f964f6711cb55f633820ed174e780369b99d'); set(REGISTRY, S(1), FACTORY); set(REGISTRY, S(2), A);
  set(REGISTRY, S(6), 621n | (BigInt(RETIRED) << 32n));
  set(FACTORY, IMPL, '0x94eab8f73fd83407d26c006d159923760d483029'); set(FACTORY, k(w(621), w(101)), '0x' + GAME_IMPL);
  tweak(t, 'before');
  addGame(A, t.anchor);
  const id = addGame(N, t.newest);
  set(FACTORY, S(104), t.listLength);
  set(FACTORY, '0x' + w(BigInt(k(w(104))) + t.listLength - 1n), t.listType === undefined ? id : (id & ((1n << 224n) - 1n)) | (BigInt(t.listType) << 224n));
  tweak(t, 'after');
  const block = { number: 100, hash: '0x' + '99'.repeat(32), timestamp: 3_000_000 };
  return {
    provedAccount: async ({ address, slots }) => (store[address] || code[address] ? { exists: true, codeHash: code[address] ? '0x' + hx(keccak256(fb(code[address]))) : '0x' + '00'.repeat(32), words: slots.map((s) => (store[address] || {})[s] || '0x' + w(0)), block, via: 'made-up' } : { exists: false, block }),
    provedCode: async ({ address, codeHash }) => { if ('0x' + hx(keccak256(fb(code[address]))) !== codeHash) throw Object.assign(new Error('code hash'), { kind: 'check' }); return code[address]; },
  };
}
const at = (phase, fn) => (t, when) => { if (when === phase) fn(t); };
const badCode = (t, edit) => { t.code[t.A] = edit(t.code[t.A]); };

// [name, tweak, expected: { anchor: l2Block, latest: l2Block | null } or 'refuse']
const OK = { anchor: 5000, latest: 11000 }, NO_LATEST = { anchor: 5000, latest: null };
const CASES = [
  ['an honest state', undefined, OK],
  ['the portal was upgraded', at('after', (t) => t.set(PORTAL, IMPL, '0x' + '77'.repeat(20))), 'refuse'],
  ['the registry was upgraded', at('after', (t) => t.set(REGISTRY, IMPL, '0x' + '77'.repeat(20))), 'refuse'],
  ['the factory was upgraded', at('after', (t) => t.set(FACTORY, IMPL, '0x' + '77'.repeat(20))), 'refuse'],
  ['the portal names another registry', at('after', (t) => t.set(PORTAL, S(62), '0x' + '77'.repeat(20))), 'refuse'],
  ['the registry names another factory', at('after', (t) => t.set(REGISTRY, S(1), '0x' + '77'.repeat(20))), 'refuse'],
  ['the registry respects another game type', at('after', (t) => t.set(REGISTRY, S(6), 622n | (BigInt(RETIRED) << 32n))), 'refuse'],
  ['the factory makes games from another implementation', at('after', (t) => t.set(FACTORY, k(w(621), w(101)), '0x' + '77'.repeat(20))), 'refuse'],
  ['the factory has no games', at('before', (t) => { t.listLength = 0n; }), 'refuse'],
  ['the anchor game lost its challenge', at('before', (t) => { t.anchor.status = 1; }), 'refuse'],
  ['the anchor game is unresolved', at('before', (t) => { t.anchor.status = 0; }), 'refuse'],
  ['the anchor game is blacklisted', at('after', (t) => t.set(REGISTRY, k(w(t.A), w(5)), 1n)), 'refuse'],
  ['the anchor game is retired', at('before', (t) => { t.anchor.createdAt = RETIRED; }), 'refuse'],
  ['the anchor game was not of the respected type when created', at('before', (t) => { t.anchor.respected = 0; }), 'refuse'],
  ['the factory has no record of the anchor game', at('before', (t) => { t.anchor.record = false; }), 'refuse'],
  ['the factory records the anchor game under another type', at('before', (t) => { t.anchor.type = 5; }), 'refuse'],
  ['the anchor game is a clone of another implementation', at('after', (t) => badCode(t, (c) => c.replace(GAME_IMPL, '77'.repeat(20)))), 'refuse'],
  ['the anchor game\'s code is too short to hold a claim', at('after', (t) => badCode(t, (c) => c.slice(0, 2 + HEAD.length + 100))), 'refuse'],
  ['the newest game lost its challenge', at('before', (t) => { t.newest.status = 1; }), NO_LATEST],
  ['the newest game has no proof accepted', at('before', (t) => { t.newest.proofs = 0; }), NO_LATEST],
  ['the newest game is blacklisted', at('after', (t) => t.set(REGISTRY, k(w(t.N), w(5)), 1n)), NO_LATEST],
  ['the newest game is retired', at('before', (t) => { t.newest.createdAt = RETIRED - 1; }), NO_LATEST],
  ['the newest game is of another type', at('before', (t) => { t.listType = 5; }), NO_LATEST],
  ['the newest game is older than the anchor', at('before', (t) => { t.newest.l2Block = 4000; }), NO_LATEST],
  ['the newest game has resolved in the claimant\'s favour', at('before', (t) => { t.newest.status = 2; }), OK],
];
let bad = 0;
for (const [name, tweak, want] of CASES) {
  let got;
  try { const c = await baseClaims({ fin: {}, urls: [], deps: world(tweak) }); got = { anchor: c.anchor.l2Block, latest: c.latest ? c.latest.l2Block : null }; }
  catch (e) { got = e.kind === 'check' ? 'refuse' : `crash: ${e.message}`; }
  const ok = JSON.stringify(got) === JSON.stringify(want);
  bad += !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${typeof got === 'string' ? got : `anchor ${got.anchor}, latest ${got.latest}`}${ok ? '' : ` (wanted ${JSON.stringify(want)})`}`);
}
console.log(bad ? `${bad} FAILED` : `ok: ${CASES.length} cases`);
process.exit(bad ? 1 : 0);
