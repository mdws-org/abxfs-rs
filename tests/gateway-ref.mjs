// Save the fs.abx.io gateway's copy of a root as a reference folder for tests/view-check.mjs, for chains or
// machines where the Rust reader is not built. The file list comes from the chain; the bytes from the gateway.
// usage: node tests/gateway-ref.mjs <chain key> <root> <out dir>
import { CHAINS, walk } from '../site/chain.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const [key, root, out] = process.argv.slice(2);
const chain = CHAINS[key];
const tree = await walk({ chain, url: chain.rpcs[0], requests: 0, ethCalls: 0, block: 'latest' }, root);
for (const f of tree.items.filter((x) => !x.isDir && !x.invalid)) {
  const r = await fetch(`https://fs.abx.io/g/cid/${chain.id}/${root}/${f.path.split('/').map(encodeURIComponent).join('/')}`);
  if (!r.ok) throw new Error(`${f.path}: the gateway answered ${r.status}`);
  const b = new Uint8Array(await r.arrayBuffer());
  await mkdir(dirname(join(out, f.path)), { recursive: true });
  await writeFile(join(out, f.path), b);
  console.log(f.path, b.length);
}
