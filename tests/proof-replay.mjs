// site/proof.js against recorded proofs (tests/fixtures/proof-*.json, written by proof-live.mjs after each proof
// had matched a reference trie library), offline, plus RLP cases written by hand.
// usage: node tests/proof-replay.mjs [path to proof.js]
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
const P = await import(process.argv[2] || '../site/proof.js');
const dir = join(new URL('.', import.meta.url).pathname, 'fixtures');
const fb = (h) => Uint8Array.from(h.slice(2).match(/../g)?.map((x) => parseInt(x, 16)) ?? []);
const hx = (u) => '0x' + Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
let failed = 0, done = 0;
const check = (ok, text) => { done++; if (!ok) { failed++; console.log('FAIL ' + text); } };
const refused = (fn) => { try { fn(); return false; } catch (e) { return e.constructor.name === 'ProofError'; } };

// RLP: the Ethereum wiki's examples, both ways, and encodings that are not canonical.
const big = new Uint8Array(1024).fill(7);
for (const [item, enc] of [[fb('0x646f67'), '0x83646f67'], [[fb('0x636174'), fb('0x646f67')], '0xc88363617483646f67'], [new Uint8Array(0), '0x80'], [[], '0xc0'], [Uint8Array.of(0x0f), '0x0f'], [Uint8Array.of(0x04, 0x00), '0x820400'], [[[], [[]], [[], [[]]]], '0xc7c0c1c0c3c0c1c0'], [big, '0xb90400' + '07'.repeat(1024)]]) {
  check(hx(P.rlpEncode(item)) === enc, `rlpEncode gives ${hx(P.rlpEncode(item)).slice(0, 40)}, wanted ${enc.slice(0, 40)}`);
  check(JSON.stringify(P.rlpDecode(fb(enc)), (k, v) => (v instanceof Uint8Array ? hx(v) : v)) === JSON.stringify(item, (k, v) => (v instanceof Uint8Array ? hx(v) : v)), `rlpDecode of ${enc.slice(0, 40)}`);
}
for (const [bad, why] of [['0x8105', 'a small byte as a string'], ['0xb8054142434445', 'long form for a short string'], ['0xb9003841' + '41'.repeat(55), 'a length with a leading zero'], ['0x83646f6700', 'bytes after the item'], ['0x83646f', 'a string past the end'], ['0xc883636174', 'a list past the end'], ['0xc5c383010203', 'an item that runs past its list into the next item'], ['0xf8054142434445', 'long form for a short list'], ['0x', 'nothing']]) check(refused(() => P.rlpDecode(fb(bad))), `rlpDecode accepted ${why}`);

// Hand-built tries, for shapes no real trie has. Here the test chooses the root, so any node can be made.
{
  const { keccak256 } = await import('../site/keccak-lookup.js');
  const nib = (u) => Array.from(u).flatMap((b) => [b >> 4, b & 15]);
  const hp = (nibbles, leaf) => { // hex-prefix encoding of a path
    const odd = nibbles.length % 2, first = ((leaf ? 2 : 0) + odd) << 4 | (odd ? nibbles[0] : 0), rest = nibbles.slice(odd);
    return Uint8Array.of(first, ...Array.from({ length: rest.length / 2 }, (_, i) => rest[2 * i] << 4 | rest[2 * i + 1]));
  };
  const node = (items) => { const raw = P.rlpEncode(items); return { raw, hash: keccak256(raw) }; };
  const key = keccak256(Uint8Array.of(1, 2, 3)), k = nib(key), empty = new Uint8Array(0);
  const value = Uint8Array.of(0x2a);
  const verify = (root, proof, forKey = key) => P.verifyProof(root, forKey, proof, 'hand-built');
  // One leaf holding the whole key.
  const whole = node([hp(k, true), value]);
  check(hx(verify(whole.hash, [whole.raw]) ?? empty) === '0x2a', 'hand-built: a one-leaf trie');
  // A leaf whose path is only the key's first ten nibbles.
  const short = node([hp(k.slice(0, 10), true), value]);
  check(refused(() => verify(short.hash, [short.raw])), 'hand-built: a leaf that ends before the key does was accepted');
  // A branch, then a leaf: the usual shape; and the same branch asked for a key it has no child for.
  const leaf = node([hp(k.slice(1), true), value]);
  const slots = Array.from({ length: 17 }, () => empty); slots[k[0]] = leaf.hash;
  const branch = node(slots);
  check(hx(verify(branch.hash, [branch.raw, leaf.raw]) ?? empty) === '0x2a', 'hand-built: branch then leaf');
  const elsewhere = Uint8Array.from(key); elsewhere[0] ^= 0x10;
  check(verify(branch.hash, [branch.raw], elsewhere) === null, 'hand-built: an empty branch slot is absence');
  check(refused(() => verify(branch.hash, [branch.raw, leaf.raw], elsewhere)), 'hand-built: absence with a node left over was accepted');
  // An extension over sixty nibbles, a branch, and a leaf small enough to sit inside the branch.
  const tiny = [hp(k.slice(61), true), value];
  const inner = Array.from({ length: 17 }, () => empty); inner[k[60]] = tiny;
  const b2 = node(inner), ext = node([hp(k.slice(0, 60), false), b2.hash]);
  check(hx(verify(ext.hash, [ext.raw, b2.raw]) ?? empty) === '0x2a', 'hand-built: a leaf embedded in its branch');
  const near = Uint8Array.from(key); near[31] ^= 0x01;
  check(verify(ext.hash, [ext.raw, b2.raw], near) === null, 'hand-built: an embedded leaf with another path is absence');
  const far = Uint8Array.from(key); far[2] ^= 0x01;
  check(verify(ext.hash, [ext.raw], far) === null, 'hand-built: an extension that leaves the key is absence');
  // Accounts that are not four well-sized fields, and a stored zero.
  const address = '0x' + '77'.repeat(20), ak = nib(keccak256(fb(address))), r32 = keccak256(Uint8Array.of(9));
  for (const [what, fields] of [['three fields', [Uint8Array.of(1), empty, r32]], ['a short storage root', [Uint8Array.of(1), empty, r32.subarray(1), r32]], ['a nonce with a leading zero', [Uint8Array.of(0, 1), empty, r32, r32]], ['five fields', [Uint8Array.of(1), empty, r32, r32, empty]]]) {
    const acct = node([hp(ak, true), P.rlpEncode(fields)]);
    check(refused(() => P.accountAt(hx(acct.hash), address, [hx(acct.raw)])), `hand-built: an account with ${what} was accepted`);
  }
  const good = node([hp(ak, true), P.rlpEncode([Uint8Array.of(1), empty, r32, r32])]);
  check(P.accountAt(hx(good.hash), address, [hx(good.raw)])?.storageRoot === hx(r32), 'hand-built: a well-formed account');
  const slot = '0x' + '00'.repeat(31) + '05', sk = nib(keccak256(fb(slot)));
  for (const [what, stored] of [['a zero', empty], ['a word with a leading zero', Uint8Array.of(0, 7)], ['a word of 33 bytes', new Uint8Array(33).fill(1)]]) {
    const st = node([hp(sk, true), P.rlpEncode(stored)]);
    check(refused(() => P.storageAt(hx(st.hash), slot, [hx(st.raw)])), `hand-built: a slot storing ${what} was accepted`);
  }
  const seven = node([hp(sk, true), P.rlpEncode(Uint8Array.of(7))]);
  check(BigInt(P.storageAt(hx(seven.hash), slot, [hx(seven.raw)])) === 7n, 'hand-built: a slot storing 7');
}

for (const file of (await readdir(dir)).filter((f) => /^proof-.*\.json$/.test(f)).sort()) {
  const fx = JSON.parse(await readFile(join(dir, file), 'utf8'));
  let header;
  try { header = P.executionHeader(fx.block.hash, fx.block); check(header.stateRoot === fx.block.stateRoot.toLowerCase(), `${file}: header state root`); } catch (e) { check(false, `${file}: header refused: ${e.message}`); continue; }
  for (const [name, edit] of [['state root', (b) => { b.stateRoot = '0x' + 'ee' + b.stateRoot.slice(4); }], ['number', (b) => { b.number = '0x' + (parseInt(b.number, 16) + 1).toString(16); }], ['base fee removed', (b) => { delete b.baseFeePerGas; }], ['gas used with a leading zero', (b) => { b.gasUsed = '0x0' + b.gasUsed.slice(2); }], ['mix hash removed', (b) => { delete b.mixHash; }], ['extra data', (b) => { b.extraData += '00'; }]]) {
    const b = structuredClone(fx.block); edit(b);
    check(refused(() => P.executionHeader(fx.block.hash, b)), `${file}: header with ${name} changed was accepted`);
  }
  check(refused(() => P.executionHeader(fx.block.hash, null)), `${file}: a missing block was accepted`);
  const lies = (nodes, verify, what) => {
    for (let n = 0; n < nodes.length; n++) for (let k = 0; k < 12; k++) {
      const at = 2 + Math.floor(((nodes[n].length - 3) * k) / 11), alt = nodes.slice();
      alt[n] = nodes[n].slice(0, at) + (nodes[n][at] === 'f' ? '0' : 'f') + nodes[n].slice(at + 1);
      check(refused(() => verify(alt)), `${what}: node ${n} changed at ${at} was accepted`);
    }
    for (const alt of [nodes.slice(0, -1), [...nodes, nodes[nodes.length - 1]], nodes.slice(1), [nodes[nodes.length - 1], ...nodes]]) check(refused(() => verify(alt)), `${what}: a node dropped or added was accepted`);
  };
  for (const c of fx.cases) {
    const p = c.proof, what = `${file} ${c.address}`;
    let acct;
    try { acct = P.accountAt(c.stateRoot, c.address, p.accountProof); } catch (e) { check(false, `${what}: account refused: ${e.message}`); continue; }
    const exists = !(BigInt(p.nonce) === 0n && BigInt(p.balance) === 0n && p.codeHash.endsWith('5d85a470') && p.storageHash.endsWith('63b421'));
    check(acct ? (acct.storageRoot === p.storageHash.toLowerCase() && acct.codeHash === p.codeHash.toLowerCase() && acct.nonce === Number(BigInt(p.nonce))) : !exists, `${what}: account fields`);
    lies(p.accountProof, (alt) => P.accountAt(c.stateRoot, c.address, alt), what);
    // The same proof against another address or another state root.
    check(refused(() => P.accountAt(c.stateRoot, '0x' + 'cd'.repeat(20), p.accountProof)), `${what}: the proof served another address`);
    check(refused(() => P.accountAt('0x' + '11'.repeat(32), c.address, p.accountProof)), `${what}: the proof served another state root`);
    if (!acct) continue;
    for (const [i, sp] of p.storageProof.entries()) {
      let got;
      try { got = P.storageAt(acct.storageRoot, c.slots[i], sp.proof); } catch (e) { check(false, `${what} slot ${c.slots[i]}: refused: ${e.message}`); continue; }
      check(BigInt(got) === BigInt(sp.value), `${what} slot ${c.slots[i]}: ${got}, recorded ${sp.value}`);
      if (!sp.proof.length) { check(refused(() => P.storageAt(acct.storageRoot, c.slots[i], [p.accountProof[0]])), `${what}: a proof for empty storage was accepted`); continue; }
      lies(sp.proof, (alt) => P.storageAt(acct.storageRoot, c.slots[i], alt), `${what} slot ${i}`);
      if (BigInt(got) !== 0n) {
        let leaked = false; try { leaked = P.storageAt(acct.storageRoot, '0x' + '5a'.repeat(32), sp.proof) === got; } catch { /* refused */ }
        check(!leaked, `${what}: one slot's proof gave its value for another slot`);
        check(refused(() => P.storageAt(acct.storageRoot, c.slots[i], [])), `${what}: a stored word with no proof was accepted`);
      }
    }
  }
}
console.log(failed ? `${failed} of ${done} FAILED` : `ok: ${done} checks`);
process.exit(failed ? 1 : 0);
