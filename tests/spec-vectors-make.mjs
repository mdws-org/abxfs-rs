// Turn the official light-client Merkle proof vectors (consensus-specs release, minimal preset) into
// tests/fixtures/spec/single-merkle-proof.json. Each vector is a leaf, its generalized index and a branch inside
// a BeaconState or BeaconBlockBody; the object's root is computed here with Lodestar's SSZ types (test-only), so
// that tests/spec-vectors.mjs can run with no outside code.
// usage: LODESTAR_PRESET=minimal node tests/spec-vectors-make.mjs <dir holding tests/minimal/...> <release tag>
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const [dir, tag] = process.argv.slice(2);
if (process.env.LODESTAR_PRESET !== 'minimal') throw new Error('run with LODESTAR_PRESET=minimal');
if (!process.env.LODESTAR_DIR) { console.log('set LODESTAR_DIR to a directory where `npm install @lodestar/light-client @lodestar/api @lodestar/config` was run'); process.exit(2); }
const mods = process.env.LODESTAR_DIR + '/node_modules/@lodestar/';
const { ssz } = await import(mods + 'types/lib/index.js');

// Raw Snappy (no framing), as the spec tests store SSZ.
function unsnappy(src) {
  let p = 0, len = 0, shift = 0;
  for (;;) { const b = src[p++]; len |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
  const out = new Uint8Array(len);
  let o = 0;
  while (p < src.length) {
    const tag = src[p++], kind = tag & 3;
    if (kind === 0) {
      let n = tag >> 2;
      if (n >= 60) { const bytes = n - 59; n = 0; for (let i = 0; i < bytes; i++) n |= src[p++] << (8 * i); }
      n += 1; out.set(src.subarray(p, p + n), o); p += n; o += n;
    } else {
      let n, off;
      if (kind === 1) { n = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[p++]; }
      else if (kind === 2) { n = (tag >> 2) + 1; off = src[p] | (src[p + 1] << 8); p += 2; }
      else { n = (tag >> 2) + 1; off = src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24); p += 4; }
      for (let i = 0; i < n; i++, o++) out[o] = out[o - off];
    }
  }
  if (o !== len) throw new Error('snappy: wrong length');
  return out;
}
const hx = (u) => '0x' + Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const out = [];
for (const fork of ['electra', 'fulu', 'gloas']) {
  const base = join(dir, 'tests/minimal', fork, 'light_client/single_merkle_proof');
  for (const object of await readdir(base)) for (const name of await readdir(join(base, object))) {
    const text = await readFile(join(base, object, name, 'proof.yaml'), 'utf8');
    const leaf = /leaf: '(0x[0-9a-f]{64})'/.exec(text)[1], leaf_index = Number(/leaf_index: (\d+)/.exec(text)[1]);
    const branch = [...text.matchAll(/^- '(0x[0-9a-f]{64})'/gm)].map((m) => m[1]);
    let root = null, why = '';
    try { root = hx(ssz[fork][object].hashTreeRoot(ssz[fork][object].deserialize(unsnappy(new Uint8Array(await readFile(join(base, object, name, 'object.ssz_snappy'))))))); }
    catch (e) { why = String(e.message).slice(0, 80); }
    out.push({ fork, object, name, leaf, leaf_index, branch, root });
    console.log(fork, object, name, 'gindex', leaf_index, 'branch', branch.length, root ? 'root ' + root.slice(0, 14) : 'NO ROOT: ' + why);
  }
}
await mkdir(new URL('./fixtures/spec/', import.meta.url), { recursive: true });
await writeFile(new URL('./fixtures/spec/single-merkle-proof.json', import.meta.url), JSON.stringify({ source: `ethereum/consensus-specs ${tag}, minimal preset, light_client/single_merkle_proof`, roots: 'computed with @lodestar/types SSZ', vectors: out }, null, 1));
