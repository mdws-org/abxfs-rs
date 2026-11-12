// Record every reply bamfs.js needs to read one root, for bamfs-replay.
// usage: node tests/bamfs-record.mjs <chain key> <root> <out.json>
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { CHAINS } from '../site/chain.js';
import { readFile, walk } from '../site/bamfs.js';
const [key, root, out] = process.argv.slice(2);
const chain = CHAINS[key], url = chain.rpcs[chain.rpcs.length - 1];
const real = globalThis.fetch, replies = {};
globalThis.fetch = async (u, init) => { const r = await real(u, init); const text = await r.text(); replies[init.body] = text; return new Response(text, { status: r.status }); };
const ctx = () => ({ chain, url, requests: 0, ethCalls: 0, block: 'latest' });
const tree = await walk(ctx(), root);
const files = {};
for (const f of tree.kind === 'file' ? [{ path: '', cid: root, info: tree.info }] : tree.items.filter((x) => !x.isDir && !x.invalid)) files[f.path] = createHash('sha256').update(await readFile(ctx(), f.cid, f.info)).digest('hex');
await writeFile(out, JSON.stringify({ chain: key, url, root, files, replies }));
console.log(`recorded ${Object.keys(replies).length} replies for ${Object.keys(files).length} files under ${root}`);
