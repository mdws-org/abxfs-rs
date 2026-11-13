// Test vectors for archive/ARCHIVE.md, written from the spec and not from the Rust code:
//   synthetic bundles that exercise the content rules (with an `agreed` proof, which needs no chain), each with
//   the listing this file computes from what it put in; and `bad-` bundles, each one rule broken, made from the
//   synthetic ones and from real bundles passed on the command line.
//
// usage: node tools/archive/vectors.mjs <out dir> [real bundle ...]
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { keccak256 } from '../../site/keccak-lookup.js';

const enc = new TextEncoder();
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let a = 0; for (const x of p) { o.set(x, a); a += x.length; } return o; };
const hex = (u) => '0x' + Buffer.from(u).toString('hex');
const unhex = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const K = (...p) => keccak256(cat(...p));
const sha = (u) => new Uint8Array(createHash('sha256').update(u).digest());
const u = (n, w) => { const o = new Uint8Array(w); let v = BigInt(n); for (let i = w - 1; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
const Z32 = new Uint8Array(32);

/* ── container (section 1) ── */
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function cidText(c) { let s = 'b', acc = 0, bits = 0; for (const b of c) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; s += B32[(acc >> bits) & 31]; } acc &= (1 << bits) - 1; } if (bits) s += B32[(acc << (5 - bits)) & 31]; return s; }
function cidBytes(t) { let acc = 0, bits = 0; const o = []; for (const ch of t.slice(1)) { acc = (acc << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { bits -= 8; o.push((acc >> bits) & 255); } acc &= (1 << bits) - 1; } return Uint8Array.from(o); }
const rawCid = (d) => cat(Uint8Array.of(1, 0x55, 0x12, 0x20), sha(d));
const indexCid = (d) => cat(Uint8Array.of(1, 0xa9, 2, 0x12, 0x20), sha(d));
const varint = (n) => { const o = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; o.push(b); } while (n); return Uint8Array.from(o); };
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function linkOrder(v, out) {
  if (Array.isArray(v)) v.forEach((x) => linkOrder(x, out));
  else if (v && typeof v === 'object') {
    if (Object.keys(v).length === 1 && typeof v['/'] === 'string') out.push(v['/']);
    else Object.keys(v).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).forEach((k) => linkOrder(v[k], out));
  }
}
// The bundle bytes for an index object and its blocks (keyed by CID text). `opts` breaks container rules on purpose.
function car(index, blocks, opts = {}) {
  const ib = enc.encode(opts.indexText ?? canonical(index));
  const ic = indexCid(ib);
  const header = cat(Uint8Array.of(0xa2, 0x65), enc.encode('roots'), Uint8Array.of(0x81, 0xd8, 0x2a, 0x58, 0x26, 0x00), ic, Uint8Array.of(0x67), enc.encode('version'), Uint8Array.of(opts.version ?? 1));
  const order = [];
  linkOrder(index, order);
  let seq = [...new Set(order)].map((t) => [cidBytes(t), blocks.get(t)]);
  if (opts.extra) seq.push([rawCid(opts.extra), opts.extra]);
  if (opts.swap && seq.length > 1) seq = [seq[1], seq[0], ...seq.slice(2)];
  if (opts.corrupt && seq.length) { const d = Uint8Array.from(seq[0][1]); d[0] ^= 1; seq[0] = [seq[0][0], d]; }
  const parts = [varint(header.length), header, varint(ic.length + ib.length), ic, ib];
  for (const [c, d] of seq) parts.push(varint(c.length + d.length), c, d);
  if (opts.trailing) parts.push(Uint8Array.of(0));
  return cat(...parts);
}
// A byte string (section 1): hex up to 1,024 bytes, else blocks of 1 MiB.
function bstr(b, blocks) {
  if (b.length <= 1024) return hex(b);
  const links = [];
  for (let i = 0; i < b.length; i += 1048576) { const p = b.subarray(i, i + 1048576); const t = cidText(rawCid(p)); blocks.set(t, p); links.push({ '/': t }); }
  return links;
}

/* ── listing (section 11) ── */
const SAFE = /[A-Za-z0-9\-._~]/;
const escName = (n) => Array.from(n, (b) => (SAFE.test(String.fromCharCode(b)) && b < 128 ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0'))).join('');
function listing(head, items) {
  const lines = items.map(({ path, body }) => {
    const p = path.map(escName).join('/');
    return body === undefined ? [p + '/', `d ${p}/`] : [p, `f ${p} ${body.length} ${Buffer.from(sha(body)).toString('hex')}`];
  }).sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  const files = items.filter((i) => i.body !== undefined);
  return [...head, ...lines.map((l) => l[1]), `end ${files.length} ${files.reduce((n, f) => n + f.body.length, 0)}`].join('\n') + '\n';
}

/* ── ABX FS (section 7) ── */
const RAW_BACKEND = unhex('3c3ae36f5d8aff2dd60c37ca9103d93803c4c844');
function abxfs() {
  const st = { dirs: [], files: [], nodes: {}, chunks: {}, blocks: new Map(), seenFile: new Set(), seenDir: new Set() };
  const node = (prefix, blob) => { const id = K(Uint8Array.of(prefix), blob); st.nodes[hex(id)] = blob; return id; };
  // A tree over leaf ids: a level-1 branch when there is more than one.
  const tree = (prefix, leaves, stride) => {
    if (leaves.length === 1) return leaves[0].id;
    const blob = cat(Uint8Array.of(1), u(leaves.length, 2), ...leaves.map((l) => cat(l.id, u(l.count, 4), stride === 42 ? u(l.bytes, 6) : new Uint8Array(0))));
    return node(prefix, blob);
  };
  st.file = (body, { mime = 'text/plain', codec = null, chunkSize = 64, leafChunks = 4 } = {}) => {
    const m = enc.encode(mime);
    let root = Z32, cd = Z32, oh = Z32;
    const f = {};
    if (codec) {
      cd = cat(enc.encode(codec), new Uint8Array(32 - codec.length)); oh = K(body); root = K(enc.encode('opaque root'), body);
      f.content = bstr(body, st.blocks);
    } else if (body.length) {
      const chunks = [];
      for (let i = 0; i < body.length; i += chunkSize) {
        const d = body.subarray(i, i + chunkSize);
        const ih = K(d);
        const id = K(Uint8Array.of(0x30), RAW_BACKEND, ih, K(d), u(d.length, 6));
        st.chunks[hex(id)] = { backend: hex(RAW_BACKEND), inputHash: hex(ih), data: bstr(d, st.blocks) };
        chunks.push({ id, size: d.length });
      }
      const leaves = [];
      let cum = 0, cumB = 0;
      for (let i = 0; i < chunks.length; i += leafChunks) {
        const part = chunks.slice(i, i + leafChunks);
        const id = node(0x41, cat(Uint8Array.of(0), ...part.map((c) => cat(c.id, u(c.size, 6)))));
        cum += part.length; cumB += part.reduce((n, c) => n + c.size, 0);
        leaves.push({ id, count: cum, bytes: cumB });
      }
      root = tree(0x41, leaves, 42);
    }
    const cid = K(Uint8Array.of(0x31), root, K(m), cd, oh);
    if (!st.seenFile.has(hex(cid))) { st.seenFile.add(hex(cid)); st.files.push({ cid: hex(cid), root: hex(root), mime: bstr(m, st.blocks), codec: hex(cd), outputHash: hex(oh), ...f }); }
    return cid;
  };
  st.dir = (entries, { perLeaf = 8 } = {}) => {
    if (!entries.length) { const cid = K(Uint8Array.of(0x32), Z32); if (!st.seenDir.has(hex(cid))) { st.seenDir.add(hex(cid)); st.dirs.push({ cid: hex(cid), root: hex(Z32) }); } return cid; }
    const leaves = [];
    let cum = 0;
    for (let i = 0; i < entries.length; i += perLeaf) {
      const part = entries.slice(i, i + perLeaf);
      const recs = part.map((e) => cat(Uint8Array.of(e.name.length), e.name, Uint8Array.of(e.dir ? 1 : 0), e.cid));
      const offs = []; let o = 0; for (const r of recs) { offs.push(u(o, 2)); o += r.length; }
      cum += part.length;
      leaves.push({ id: node(0x42, cat(Uint8Array.of(0), u(part.length, 2), ...offs, ...recs)), count: cum });
    }
    const root = tree(0x42, leaves, 36);
    const cid = K(Uint8Array.of(0x32), root);
    if (!st.seenDir.has(hex(cid))) { st.seenDir.add(hex(cid)); st.dirs.push({ cid: hex(cid), root: hex(root) }); }
    return cid;
  };
  st.content = () => ({ store: 'abxfs', dirs: st.dirs, files: st.files, nodes: Object.fromEntries(Object.entries(st.nodes).map(([k, v]) => [k, bstr(v, st.blocks)])), chunks: st.chunks });
  return st;
}

/* ── BAMFS (sections 8, 9) ── */
const BACKEND = unhex('91520cdaaab44267e99d08fea7730d7a7c60e9c2');
function bamfs1() {
  const st = { dirs: [], files: [], chunks: {}, blocks: new Map() };
  st.file = (body, { mime = 'text/plain', compression = 0, chunkSize = 50 } = {}) => {
    const m = enc.encode(mime);
    const ids = [], f = {};
    let oh = Z32;
    if (compression) { oh = K(body); f.content = bstr(body, st.blocks); } else {
      for (let i = 0; i < body.length; i += chunkSize) { const d = body.subarray(i, i + chunkSize); const id = K(BACKEND, d); st.chunks[hex(id)] = bstr(d, st.blocks); ids.push(id); }
    }
    const cid = K(Uint8Array.of(0x01), K(...ids), K(m), Uint8Array.of(compression), oh);
    st.files.push({ cid: hex(cid), chunks: ids.map(hex), mime: bstr(m, st.blocks), compression, outputHash: hex(oh), ...f });
    return cid;
  };
  st.dir = (entries) => {
    const hashes = entries.map((e) => K(K(e.name), e.cid, Uint8Array.of(e.dir ? 1 : 0)));
    const cid = K(Uint8Array.of(0x02), K(...hashes));
    st.dirs.push({ cid: hex(cid), entries: entries.map((e) => ({ name: bstr(e.name, st.blocks), cid: hex(e.cid), isDir: !!e.dir })) });
    return cid;
  };
  st.content = () => ({ store: 'bamfs1', dirs: st.dirs, files: st.files, chunks: st.chunks });
  return st;
}
function bamfs2() {
  const st = { dirs: [], files: [], nodes: {}, chunks: {}, blocks: new Map() };
  const node = (prefix, blob) => { const id = K(Uint8Array.of(prefix), blob); st.nodes[hex(id)] = blob; return id; };
  const tree = (prefix, ids, pad) => (ids.length === 1 ? ids[0] : node(prefix, cat(Uint8Array.of(1), u(ids.length, 2), ...ids.map((id) => cat(id, new Uint8Array(pad))))));
  st.file = (body, { mime = 'text/plain', compression = 0, chunkSize = 40, leafChunks = 3, zeroRoot = false } = {}) => {
    const m = enc.encode(mime), f = {};
    let oh = Z32, root = Z32;
    if (compression) { oh = K(body); f.content = bstr(body, st.blocks); root = zeroRoot ? Z32 : K(enc.encode('opaque'), body); } else {
      const cs = [];
      for (let i = 0; i < body.length; i += chunkSize) { const d = body.subarray(i, i + chunkSize); const id = K(BACKEND, d); st.chunks[hex(id)] = bstr(d, st.blocks); cs.push(cat(id, u(d.length, 2))); }
      const leaves = [];
      for (let i = 0; i < cs.length; i += leafChunks) leaves.push(node(0x21, cat(Uint8Array.of(0), ...cs.slice(i, i + leafChunks))));
      root = tree(0x21, leaves, 10);
    }
    const cid = K(Uint8Array.of(0x11), root, K(m), Uint8Array.of(compression), oh);
    // For a compressed file the store records its compressed length; this stands in for that with half the length.
    st.files.push({ cid: hex(cid), root: hex(root), mime: bstr(m, st.blocks), compression, outputHash: hex(oh), size: compression ? Math.ceil(body.length / 2) : body.length, ...f });
    return cid;
  };
  st.dir = (entries, { perLeaf = 2 } = {}) => {
    const leaves = [];
    for (let i = 0; i < entries.length; i += perLeaf) {
      const part = entries.slice(i, i + perLeaf);
      const recs = part.map((e) => cat(Uint8Array.of(e.name.length), e.name, Uint8Array.of(e.dir ? 1 : 0), e.cid));
      const offs = []; let o = 0; for (const r of recs) { offs.push(u(o, 2)); o += r.length; }
      leaves.push(node(0x22, cat(Uint8Array.of(0), u(part.length, 2), ...offs, ...recs)));
    }
    const root = tree(0x22, leaves, 4);
    const cid = K(Uint8Array.of(0x12), root);
    st.dirs.push({ cid: hex(cid), root: hex(root) });
    return cid;
  };
  st.content = () => ({ store: 'bamfs2', dirs: st.dirs, files: st.files, nodes: Object.fromEntries(Object.entries(st.nodes).map(([k, v]) => [k, bstr(v, st.blocks)])), chunks: st.chunks });
  return st;
}

const AGREED = { kind: 'agreed', block: 1000, endpoints: ['one.example', 'two.example'] };
const PROJECT = (key) => ({ chain: 8453, org: '0x' + '11'.repeat(20), token: '7', key });
const head = (root, key, store, proof = AGREED) => ['abx-archive/1', `project 8453 0x${'11'.repeat(20)} 7 ${key}`, `root ${hex(root)}`, proof.kind === 'agreed' ? 'not proved agreed 1000 one.example,two.example' : `not proved logged ${proof.block} ${proof.tx}`, `store ${store}`];
const bytes = (n, seed) => { const o = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; o[i] = x >>> 24; } return o; };

const vectors = []; // [name, bundle bytes, expected .out]
const accept = (name, key, store, root, content, blocks, items, proof = AGREED) => {
  const index = { format: 'abx-archive/1', project: PROJECT(key), root: hex(root), proof, content };
  vectors.push([name, car(index, blocks), listing(head(root, key, store, proof), items), { index, blocks }]);
};
const reject = (name, cls, b) => vectors.push([name, b, `reject ${cls}\n`]);

// An ABX FS tree: codec files (one over 1 MiB, so its content is two blocks), an empty file, an empty directory,
// a file of many chunks in several leaves under a branch, a directory of enough entries for a branch, names that
// need escaping, the same file under two names, and the same directory under two parents.
{
  const s = abxfs();
  const big = bytes(1_200_000, 1), small = enc.encode('<p>hello</p>\n'), many = bytes(1000, 2), same = enc.encode('same bytes');
  const fBig = s.file(big, { codec: 'gzip', mime: 'application/octet-stream' });
  const fSmall = s.file(small, { codec: 'br', mime: 'text/html' });
  const fEmpty = s.file(new Uint8Array(0));
  const fMany = s.file(many, { chunkSize: 37, leafChunks: 5 });
  const fSame = s.file(same);
  const dEmpty = s.dir([]);
  const shared = s.dir([{ name: enc.encode('inner.txt'), cid: fSame }]);
  const wide = s.dir(Array.from({ length: 11 }, (_, i) => ({ name: enc.encode(`n${String(i).padStart(2, '0')}`), cid: fSame })), { perLeaf: 4 });
  const names = [
    { name: enc.encode('big.bin'), cid: fBig }, { name: enc.encode('index.html'), cid: fSmall }, { name: enc.encode('empty'), cid: fEmpty },
    { name: enc.encode('many.dat'), cid: fMany }, { name: enc.encode('a b%c.txt'), cid: fSame }, { name: enc.encode('ünï'), cid: fSame },
    { name: enc.encode('again.txt'), cid: fSame }, { name: enc.encode('nothing'), cid: dEmpty, dir: true }, { name: enc.encode('one'), cid: shared, dir: true },
    { name: enc.encode('two'), cid: shared, dir: true }, { name: enc.encode('wide'), cid: wide, dir: true },
  ];
  const root = s.dir(names, { perLeaf: 3 });
  const items = [
    { path: ['big.bin'], body: big }, { path: ['index.html'], body: small }, { path: ['empty'], body: new Uint8Array(0) }, { path: ['many.dat'], body: many },
    { path: ['a b%c.txt'], body: same }, { path: ['ünï'], body: same }, { path: ['again.txt'], body: same }, { path: ['nothing'] },
    { path: ['one'] }, { path: ['one', 'inner.txt'], body: same }, { path: ['two'] }, { path: ['two', 'inner.txt'], body: same }, { path: ['wide'] },
    ...Array.from({ length: 11 }, (_, i) => ({ path: ['wide', `n${String(i).padStart(2, '0')}`], body: same })),
  ].map((i) => ({ ...i, path: i.path.map((p) => enc.encode(p)) }));
  accept('synthetic-abxfs-tree', 'abxfs.cid', 'abxfs', root, s.content(), s.blocks, items);
}
// A small tree for the rejected vectors to break: two codec files of more than 1,024 bytes (so two raw blocks), a
// chunked file and a subdirectory.
{
  const s = abxfs();
  const a = bytes(1500, 11), b = bytes(1600, 12), c = bytes(150, 13);
  const sub = s.dir([{ name: enc.encode('c.dat'), cid: s.file(c, { chunkSize: 50, leafChunks: 2 }) }]);
  const root = s.dir([{ name: enc.encode('a.bin'), cid: s.file(a, { codec: 'zstd' }) }, { name: enc.encode('b.bin'), cid: s.file(b, { codec: 'deflate' }) }, { name: enc.encode('sub'), cid: sub, dir: true }]);
  accept('synthetic-abxfs-small', 'abxfs.cid', 'abxfs', root, s.content(), s.blocks,
    [{ path: [enc.encode('a.bin')], body: a }, { path: [enc.encode('b.bin')], body: b }, { path: [enc.encode('sub')] }, { path: [enc.encode('sub'), enc.encode('c.dat')], body: c }]);
}
// A file at the root.
{
  const s = abxfs();
  const body = bytes(300, 3);
  const root = s.file(body, { chunkSize: 100 });
  accept('synthetic-abxfs-file-root', 'abxfs.cid', 'abxfs', root, s.content(), s.blocks, [{ path: [], body }], { kind: 'logged', block: 56682501, tx: '0x' + 'ab'.repeat(32) });
}
// BAMFS first generation: a name with a byte-order mark, compressed and chunked files, a subdirectory.
{
  const s = bamfs1();
  const a = enc.encode('first generation\n'), z = bytes(200, 4);
  const fa = s.file(a), fz = s.file(z, { compression: 6, mime: 'image/png' });
  const sub = s.dir([{ name: enc.encode('z.png'), cid: fz }]);
  const root = s.dir([{ name: cat(Uint8Array.of(0xef, 0xbb, 0xbf), enc.encode('bom.txt')), cid: fa }, { name: enc.encode('sub'), cid: sub, dir: true }]);
  accept('synthetic-bamfs1', 'bamfs.cid', 'bamfs1', root, s.content(), s.blocks,
    [{ path: [enc.encode('bom.txt')], body: a }, { path: [enc.encode('sub')] }, { path: [enc.encode('sub'), enc.encode('z.png')], body: z }]);
}
// BAMFS second generation: branches in both trees.
{
  const s = bamfs2();
  const a = bytes(500, 5), b = enc.encode('second');
  const fa = s.file(a), fb = s.file(b, { compression: 1, mime: 'text/plain' });
  // A compressed file whose root is zero: its root is never walked.
  const d = enc.encode('zero root'), fd = s.file(d, { compression: 6, zeroRoot: true });
  const root = s.dir([{ name: enc.encode('a.bin'), cid: fa }, { name: enc.encode('b.txt'), cid: fb }, { name: enc.encode('c.txt'), cid: fb }, { name: enc.encode('d.txt'), cid: fd }]);
  accept('synthetic-bamfs2', 'bamfs.cid', 'bamfs2', root, s.content(), s.blocks,
    [{ path: [enc.encode('a.bin')], body: a }, { path: [enc.encode('b.txt')], body: b }, { path: [enc.encode('c.txt')], body: b }, { path: [enc.encode('d.txt')], body: d }]);
}

/* ── rejected vectors ── */
const clone = (v) => JSON.parse(JSON.stringify(v));
const tree = vectors.find((v) => v[0] === 'synthetic-abxfs-small')[3];
const rebuild = (index, blocks = tree.blocks, opts) => car(index, blocks, opts);
// container
reject('bad-container-block', 'container', rebuild(tree.index, tree.blocks, { corrupt: true }));
reject('bad-container-order', 'container', rebuild(tree.index, tree.blocks, { swap: true }));
reject('bad-container-unlinked', 'container', rebuild(tree.index, tree.blocks, { extra: enc.encode('nobody links me') }));
reject('bad-container-trailing', 'container', rebuild(tree.index, tree.blocks, { trailing: true }));
reject('bad-container-version', 'container', rebuild(tree.index, tree.blocks, { version: 2 }));
// index
{ const i = clone(tree.index); i.extra = 1; reject('bad-index-unknown-key', 'index', rebuild(i)); }
{ const i = clone(tree.index); i.proof.kind = 'ethereum'; reject('bad-index-kind-for-chain', 'index', rebuild(i)); }
{ const i = clone(tree.index); i.root = hex(Z32); reject('bad-index-zero-root', 'index', rebuild(i)); }
{ const i = clone(tree.index); i.content.store = 'bamfs2'; reject('bad-index-store-for-key', 'index', rebuild(i)); }
{ const i = clone(tree.index); i.proof.endpoints = ['only.example']; reject('bad-index-one-endpoint', 'index', rebuild(i)); }
// content
{ const i = clone(tree.index); i.content.files[0].outputHash = hex(K(enc.encode('x'))); reject('bad-content-file-record', 'content', rebuild(i)); }
{
  const i = clone(tree.index);
  const id = Object.keys(i.content.chunks)[0];
  const d = unhex(i.content.chunks[id].data); d[0] ^= 1; i.content.chunks[id].data = hex(d);
  reject('bad-content-chunk', 'content', rebuild(i));
}
{ const i = clone(tree.index); const k = Object.keys(i.content.nodes)[0]; delete i.content.nodes[k]; reject('bad-content-missing-node', 'content', rebuild(i)); }
{
  // A node kept under its id with one byte of its blob changed: it no longer hashes to that id.
  const i = clone(tree.index);
  const k = Object.keys(i.content.nodes).find((x) => typeof i.content.nodes[x] === 'string' && i.content.nodes[x].length > 8);
  const b = unhex(i.content.nodes[k]); b[b.length - 1] ^= 1; i.content.nodes[k] = hex(b);
  reject('bad-content-node-blob', 'content', rebuild(i));
}
{ const i = clone(tree.index); i.content.nodes[hex(K(Uint8Array.of(0x41), Uint8Array.of(0, 1)))] = '0x0001'; reject('bad-content-unreached-node', 'content', rebuild(i)); }
{
  // Two entries named alike: a new root directory over a doubled name.
  const s = abxfs();
  const f = s.file(enc.encode('x'));
  const root = s.dir([{ name: enc.encode('dup'), cid: f }, { name: enc.encode('dup'), cid: f }]);
  const index = { format: 'abx-archive/1', project: PROJECT('abxfs.cid'), root: hex(root), proof: AGREED, content: s.content() };
  reject('bad-content-duplicate-name', 'content', car(index, s.blocks));
}
{
  // A codec file whose content does not hash to its output hash: the block is consistent, the record is not.
  const s = abxfs();
  const root = s.file(bytes(2000, 9), { codec: 'gzip' });
  const c = s.content();
  const other = bytes(2000, 10); const blocks = new Map(); c.files[0].content = bstr(other, blocks);
  reject('bad-content-codec-output', 'content', car({ format: 'abx-archive/1', project: PROJECT('abxfs.cid'), root: hex(root), proof: AGREED, content: c }, blocks));
}
{
  // BAMFS: "a" and the same name after a byte-order mark are one name.
  const s = bamfs1();
  const f = s.file(enc.encode('y'));
  const root = s.dir([{ name: enc.encode('a'), cid: f }, { name: cat(Uint8Array.of(0xef, 0xbb, 0xbf), enc.encode('a')), cid: f }]);
  reject('bad-content-bom-duplicate', 'content', car({ format: 'abx-archive/1', project: PROJECT('bamfs.cid'), root: hex(root), proof: AGREED, content: s.content() }, s.blocks));
}
{
  // BAMFS second generation: a directory whose root is all zeros is not an empty directory; it names a node that
  // cannot be found.
  const s = bamfs2();
  const empty = K(Uint8Array.of(0x12), Z32);
  const root = s.dir([{ name: enc.encode('hollow'), cid: empty, dir: true }]);
  s.dirs.push({ cid: hex(empty), root: hex(Z32) });
  reject('bad-content-bamfs2-zero-root', 'content', car({ format: 'abx-archive/1', project: PROJECT('bamfs.cid'), root: hex(root), proof: AGREED, content: s.content() }, s.blocks));
}
{
  const s = bamfs1();
  const f = s.file(enc.encode('y'));
  const root = s.dir([{ name: Uint8Array.of(0xff, 0x41), cid: f }]);
  reject('bad-content-name-not-utf8', 'content', car({ format: 'abx-archive/1', project: PROJECT('bamfs.cid'), root: hex(root), proof: AGREED, content: s.content() }, s.blocks));
}

// From real bundles: break the binding proof in each way the classes name.
function parseCar(b) {
  let at = 0;
  const rv = () => { let v = 0, s = 1; for (;;) { const x = b[at++]; v += (x & 0x7f) * s; s *= 128; if (!(x & 0x80)) return v; } };
  const hl = rv(); at += hl;
  const blocks = new Map(); let index = null;
  while (at < b.length) {
    const len = rv(); const blk = b.subarray(at, at + len); at += len;
    if (!index) index = JSON.parse(Buffer.from(blk.subarray(37)).toString()); else blocks.set(cidText(blk.subarray(0, 36)), blk.subarray(36));
  }
  return { index, blocks };
}
for (const file of process.argv.slice(3)) {
  const name = basename(file).replace(/\.car$/, '');
  const real = readFileSync(file);
  const { index, blocks } = parseCar(new Uint8Array(real));
  const kind = index.proof.kind;
  const evid = kind === 'ethereum' ? index.proof : index.proof.l1;
  if (!evid) continue;
  const accounts = kind === 'ethereum' ? index.proof.accounts : index.proof.l2.accounts;
  {
    const i = clone(index); const ev = kind === 'ethereum' ? i.proof : i.proof.l1;
    const n = unhex(ev.accounts[0].proof[0]); n[n.length - 1] ^= 1; ev.accounts[0].proof[0] = hex(n);
    reject(`bad-proof-node-${name}`, 'proof', car(i, blocks));
  }
  {
    const i = clone(index); const ev = kind === 'ethereum' ? i.proof : i.proof.l1;
    // The state root's first byte: after the list's length, parentHash (33), sha3Uncles (33), miner (21) and the
    // state root's own 0xa0. (A change elsewhere in the header only changes the anchor hash, which is printed.)
    const h = unhex(ev.header); h[1 + (h[0] - 0xf7) + 33 + 33 + 21 + 1] ^= 1; ev.header = hex(h);
    reject(`bad-proof-state-root-${name}`, 'proof', car(i, blocks));
  }
  {
    const i = clone(index); const acc = kind === 'ethereum' ? i.proof.accounts : i.proof.l2.accounts;
    const org = acc.find((a) => a.address === index.project.org); org.storage.pop();
    reject(`bad-proof-missing-slot-${name}`, 'proof', car(i, blocks));
  }
  {
    const i = clone(index); i.root = hex(K(enc.encode('another root')));
    reject(`bad-param-root-${name}`, 'param', car(i, blocks));
  }
  if (kind === 'base' && !index.proof.final) {
    const i = clone(index); i.proof.final = true;
    reject(`bad-binding-final-${name}`, 'binding', car(i, blocks));
  }
  if (kind === 'base') {
    // The project named as a contract the proofs do cover but that is not an ABX collection: the message passer.
    const i = clone(index); i.project.org = '0x4200000000000000000000000000000000000016';
    reject(`bad-param-not-a-collection-${name}`, 'param', car(i, blocks));
  }
  if (kind === 'base' || kind === 'arbitrum') {
    // An L2 header changed outside its state root: the proofs under it still hold, the claim does not.
    const i = clone(index); const h = unhex(i.proof.l2.header); h[h.length - 1] ^= 1; i.proof.l2.header = hex(h);
    reject(`bad-binding-l2-header-${name}`, 'binding', car(i, blocks));
  }
  if (kind === 'arbitrum') {
    const i = clone(index); const d = unhex(i.proof.log.data); d[13 * 32 + 5] ^= 1; i.proof.log.data = hex(d);
    reject(`bad-binding-log-${name}`, 'binding', car(i, blocks));
  }
  void accounts;
}

const out = process.argv[2];
mkdirSync(out, { recursive: true });
for (const [name, b, expect] of vectors) { writeFileSync(`${out}/${name}.car`, b); writeFileSync(`${out}/${name}.out`, expect); }
console.log(`${vectors.length} vectors in ${out}`);
