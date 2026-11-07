// Reference outputs for an ABX FS reimplementation, produced by Art Blocks' own code:
// the official CLI's folder scanner (file selection + MIME types) and the SDK's offline planner.
// usage: node golden.mjs <folder> <out.json> [--no-fastlz]
import { writeFileSync } from 'node:fs';
const NM = '/Users/bemeadows/Projects/.lanes/abxfs-cli/node_modules/@artblocks';
const sdk = await import(`${NM}/abxfs-sdk/dist/index.js`);
const { scanDirectory } = await import(`${NM}/abxfs-cli/dist/fsscan.js`);

const [folder, outPath, flag] = process.argv.slice(2);
const fastLz = flag !== '--no-fastlz';
const hex = (b) => '0x' + Buffer.from(b).toString('hex');
const { addresses } = sdk.requireCanonicalDeployment(8453);
const backends = sdk.planBackendsFor(addresses);

const scan = scanDirectory(folder);
const files = scan.files ?? scan;
const plan = await sdk.planUploadOffline(files, { backends, fastLz, ipfsCids: true });

// PackedTree: root id, root level, item count, every node children-first (nodes.ts).
const tree = (t) => t && ({
  kind: t.kind, root: t.root, rootLevel: t.rootLevel, count: t.count,
  nodes: t.nodes.map((n) => ({ id: n.id, level: n.level, count: n.count, size: n.size, childIds: n.childIds, blob: hex(n.blob) })),
});
const out = {
  generator: { sdk: '@artblocks/abxfs-sdk@0.2.0', cli: '@artblocks/abxfs-cli@0.1.2', chain: 8453, fastLz, backends },
  rootCid: plan.rootCid, uniqueChunks: plan.uniqueChunks, storedBytes: plan.storedBytes, logicalBytes: plan.logicalBytes,
  files: plan.files.map((f) => ({
    path: f.path, cid: f.cid, mimeType: f.mimeType, codec: f.codec, outputHash: f.outputHash,
    logicalSize: f.logicalSize, dataSize: f.dataSize, storedSize: f.storedSize, ipfsCid: plan.ipfsCids?.[f.path],
    chunks: f.chunks.map((c) => ({ id: c.id, backend: c.backend, inputHash: c.inputHash, dataHash: c.dataHash, size: c.size, inputLen: c.input.length })),
    tree: tree(f.tree),
  })),
  directories: plan.directories.map((d) => ({
    path: d.path, cid: d.cid, height: d.height,
    entries: d.entries.map((e) => ({ name: e.name, kind: e.kind ?? (e.isDirectory ? 'directory' : 'file'), cid: e.cid })),
    tree: tree(d.tree),
  })),
};
writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ folder, root: out.rootCid, files: out.files.length, dirs: out.directories.length, uniqueChunks: out.uniqueChunks, storedBytes: out.storedBytes }));
