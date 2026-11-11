// site/proof.js against live endpoints and a reference trie library.
//   1. A recent block's header, as the endpoint gives it, must hash to that block's hash.
//   2. eth_getProof for accounts and slots that exist and that do not: our result must equal the reference
//      library's (@ethereumjs/mpt, test-only, from the directory in MPT_DIR) and the endpoint's own value.
//   3. Every proof with one digit changed in any node, a node dropped, or a node added must be refused.
// usage: MPT_DIR=<dir with node_modules/@ethereumjs> node tests/proof-live.mjs <mainnet|sepolia|base|...> [record.json]
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { accountAt, executionHeader, storageAt, EMPTY_TRIE } from '../site/proof.js';
import { keccak256 } from '../site/keccak-lookup.js';

const RPCS = {
  mainnet: 'https://rpc.mevblocker.io', sepolia: 'https://0xrpc.io/sep',
  base: 'https://base.drpc.org', arbitrum: 'https://arbitrum.drpc.org',
};
// [address, slots]: contracts with large and small storage, an account with no storage, an address nobody used.
const ABX_SLOT = '0xcf53182b08e96a80a3594b8136d4fd6393838c5f6f5d0679d5178dcb9e2abb6a', ABX_SLOT1 = '0xcf53182b08e96a80a3594b8136d4fd6393838c5f6f5d0679d5178dcb9e2abb6b';
const NOWHERE = '0x' + 'ab'.repeat(32), ZERO_SLOT = '0x' + '0'.repeat(64), ONE = '0x' + '0'.repeat(63) + '1';
const TARGETS = {
  mainnet: [['0xe8978b5d18980fa16494fb83167c84cbbe9a6816', [ABX_SLOT, ABX_SLOT1, NOWHERE, ZERO_SLOT]], ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', [ZERO_SLOT, ONE, '0x' + '0'.repeat(63) + '3', NOWHERE]], ['0x43edB88C4B80fDD2AdFF2412A7BebF9dF42cB40e', [ZERO_SLOT, '0x' + '0'.repeat(62) + '68', NOWHERE]], ['0x00000000219ab540356cBB839Cbe05303d7705Fa', [ZERO_SLOT, '0x' + '0'.repeat(62) + '20']], ['0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', [ZERO_SLOT]], ['0x1234567890abcdef1234567890abcdef12345678', []], ['0x00000000000000000000000000000000deadbeef', [ZERO_SLOT]]],
  sepolia: [['0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', [ZERO_SLOT, ONE, NOWHERE]], ['0x7f02C3E3c98b133055B8B348B2Ac625669Ed295D', [ZERO_SLOT, NOWHERE]], ['0x1234567890abcdef1234567890abcdef12345678', [ZERO_SLOT]]],
  base: [['0xab025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6', [ABX_SLOT, ABX_SLOT1, NOWHERE]], ['0x4200000000000000000000000000000000000006', [ZERO_SLOT, ONE, NOWHERE]], ['0x1234567890abcdef1234567890abcdef12345678', []]],
  arbitrum: [['0x4338cd826b34ccf3bd6b09c3c8d1a1794eb1400a', [ABX_SLOT, ABX_SLOT1, NOWHERE]], ['0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', [ZERO_SLOT, ONE, NOWHERE]]],
};
const [which = 'mainnet', record] = process.argv.slice(2);
const url = RPCS[which];
const rpc = async (method, params) => { const r = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`); return r.result; };
const fb = (h) => Uint8Array.from(h.slice(2).match(/../g)?.map((x) => parseInt(x, 16)) ?? []);
const hx = (u) => '0x' + Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const require = createRequire((process.env.MPT_DIR || '/Users/bemeadows/Projects/.lanes/abxfs-p3-spike') + '/');
const { verifyMerkleProof } = await import(require.resolve('@ethereumjs/mpt'));
const { RLP } = await import(require.resolve('@ethereumjs/rlp'));

let failed = 0;
const check = (ok, text) => { if (!ok) { failed++; console.log('FAIL ' + text); } return ok; };

// 1. Header.
const head = parseInt(await rpc('eth_blockNumber', []), 16);
const tag = '0x' + (head - 2).toString(16);
const block = await rpc('eth_getBlockByNumber', [tag, false]);
let header;
try { header = executionHeader(block.hash, block); console.log(`ok   ${which} block ${header.number}: the header hashes to its block hash; state root ${header.stateRoot}`); }
catch (e) { check(false, `header: ${e.message}`); process.exit(1); }
for (const [name, edit] of [['state root changed', (b) => { b.stateRoot = b.stateRoot.slice(0, 10) + (b.stateRoot[10] === '0' ? '1' : '0') + b.stateRoot.slice(11); }], ['number changed', (b) => { b.number = '0x' + (parseInt(b.number, 16) + 1).toString(16); }], ['a field removed', (b) => { delete b.baseFeePerGas; }], ['a number given a leading zero', (b) => { b.gasUsed = '0x0' + b.gasUsed.slice(2); }]]) {
  const b = structuredClone(block); edit(b);
  let refused = false; try { executionHeader(block.hash, b); } catch { refused = true; }
  check(refused, `header with ${name} was accepted`);
}

// 2 and 3. Proofs.
const cases = [];
let proofs = 0, tampered = 0;
for (const [address, slots] of TARGETS[which]) {
  const p = await rpc('eth_getProof', [address, slots, tag]);
  cases.push({ address, slots, tag, stateRoot: header.stateRoot, proof: p });
  const ours = accountAt(header.stateRoot, address, p.accountProof);
  const refLeaf = await verifyMerkleProof(fb(address), p.accountProof.map(fb), { root: fb(header.stateRoot), useKeyHashing: true });
  const ref = refLeaf ? { storageRoot: hx(RLP.decode(refLeaf)[2]), codeHash: hx(RLP.decode(refLeaf)[3]) } : null;
  proofs++;
  if (!check((ours === null) === (ref === null) && (!ours || (ours.storageRoot === ref.storageRoot && ours.codeHash === ref.codeHash)), `${address}: account differs from the reference`)) continue;
  check(!ours || (ours.storageRoot === p.storageHash.toLowerCase() && ours.codeHash === p.codeHash.toLowerCase()), `${address}: account differs from the endpoint's own fields`);
  const lies = (nodes, verify) => { // one digit changed at a spread of positions in every node; a node dropped; a node added
    for (let n = 0; n < nodes.length; n++) for (let k = 0; k < 12; k++) {
      const at = 2 + Math.floor(((nodes[n].length - 3) * k) / 11), alt = nodes.slice();
      alt[n] = nodes[n].slice(0, at) + (nodes[n][at] === 'f' ? '0' : 'f') + nodes[n].slice(at + 1);
      if (alt[n] === nodes[n]) continue;
      tampered++; let refused = false; try { verify(alt); } catch { refused = true; }
      check(refused, `${address}: a proof with node ${n} changed at ${at} was accepted`);
    }
    for (const alt of [nodes.slice(0, -1), [...nodes, nodes[nodes.length - 1] ?? '0x80'], nodes.slice(1)]) {
      if (alt.length === nodes.length || (!alt.length && !nodes.length)) continue;
      tampered++; let refused = false; try { verify(alt); } catch { refused = true; }
      check(refused, `${address}: a proof with a node dropped or added was accepted`);
    }
  };
  lies(p.accountProof, (alt) => accountAt(header.stateRoot, address, alt));
  if (!ours) { console.log(`ok   ${address}: no such account, as the reference says`); continue; }
  for (const [i, sp] of p.storageProof.entries()) {
    const slot = slots[i];
    const got = storageAt(ours.storageRoot, slot, sp.proof);
    let refValue = '0x' + '0'.repeat(64);
    if (ours.storageRoot !== EMPTY_TRIE) { const v = await verifyMerkleProof(fb(slot), sp.proof.map(fb), { root: fb(ours.storageRoot), useKeyHashing: true }); if (v) refValue = '0x' + hx(RLP.decode(v)).slice(2).padStart(64, '0'); }
    const direct = await rpc('eth_getStorageAt', [address, slot, tag]);
    proofs++;
    check(got === refValue && got === direct.toLowerCase(), `${address} slot ${slot}: ours ${got}, reference ${refValue}, endpoint ${direct}`);
    if (sp.proof.length) lies(sp.proof, (alt) => storageAt(ours.storageRoot, slot, alt));
    // The proof for this slot offered for another slot must not yield this slot's value.
    const other = hx(keccak256(fb(slot)));
    let leaked = false; try { leaked = sp.proof.length > 0 && storageAt(ours.storageRoot, other, sp.proof) === got && BigInt(got) !== 0n; } catch { /* refused */ }
    check(!leaked, `${address}: slot ${slot}'s proof gave its value for another slot`);
  }
  console.log(`ok   ${address}: account and ${slots.length} slot(s) equal the reference and the endpoint (storage root ${ours.storageRoot.slice(0, 12)}…)`);
}
if (record) await writeFile(record, JSON.stringify({ network: which, block, cases }));
console.log(failed ? `${failed} FAILED` : `ok: ${proofs} proofs equal the reference; ${tampered} altered proofs, all refused`);
process.exit(failed ? 1 : 0);
