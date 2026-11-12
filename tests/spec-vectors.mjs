// The official light-client Merkle proof vectors (tests/fixtures/spec/single-merkle-proof.json, from the
// consensus-specs release named in that file) against site/light.js: each vector's generalized index must be the
// one light.js hard-codes for that fork, and the vector's leaf and branch must check against the object's root
// with light.js's own branch function. A changed leaf, the same position in the other half of the tree, and a shortened branch must not.
// usage: node tests/spec-vectors.mjs [path to light.js]
import { readFile } from 'node:fs/promises';
const L = await import(process.argv[2] || '../site/light.js');
const fx = JSON.parse(await readFile(new URL('./fixtures/spec/single-merkle-proof.json', import.meta.url), 'utf8'));
const fb = (h) => Uint8Array.from(h.slice(2).match(/../g).map((x) => parseInt(x, 16)));
const FORM = { electra: 'electra', fulu: 'electra', gloas: 'gloas' };
const OURS = {
  finality_root_merkle_proof: (f) => L.GINDEX[FORM[f]].finalizedRoot,
  current_sync_committee_merkle_proof: (f) => L.GINDEX[FORM[f]].currentSyncCommittee,
  next_sync_committee_merkle_proof: (f) => L.GINDEX[FORM[f]].nextSyncCommittee,
  execution_merkle_proof: () => L.EXECUTION_PAYLOAD_GINDEX,
  execution_block_hash_merkle_proof: () => L.EXECUTION_BLOCK_HASH_GINDEX_GLOAS,
};
let bad = 0;
for (const v of fx.vectors) {
  const ours = OURS[v.name](v.fork), leaf = fb(v.leaf), branch = v.branch.map(fb), root = fb(v.root);
  const other = Uint8Array.from(leaf); other[5] ^= 1;
  const checks = [
    ['the index light.js uses is the vector\'s', ours === v.leaf_index],
    ['the branch checks', L.is_valid_normalized_merkle_branch(leaf, branch, ours, root)],
    ['a changed leaf does not', !L.is_valid_normalized_merkle_branch(other, branch, ours, root)],
    // The other half of the tree. (The neighbouring leaf is no test: in these states it often holds the same value.)
    ['the same position in the other half of the tree does not', !L.is_valid_normalized_merkle_branch(leaf, branch, ours ^ (2 ** (Math.floor(Math.log2(ours)) - 1)), root)],
    ['a branch one node short does not', !L.is_valid_normalized_merkle_branch(leaf, branch.slice(1), ours, root)],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([what]) => what);
  bad += failed.length;
  console.log(`${failed.length ? 'FAIL' : 'ok  '} ${v.fork} ${v.object} ${v.name}: index ${v.leaf_index}${failed.length ? ' — ' + failed.join('; ') : ''}`);
}
console.log(bad ? `${bad} FAILED` : `ok: ${fx.vectors.length} vectors from ${fx.source}`);
process.exit(bad ? 1 : 0);
