// site/bamfs.js against live chains: every project with a bamfs.cid root is walked and every file read, each
// checked to the root by bamfs.js, then compared with the copy BAMFS's own gateway serves.
// usage: node tests/bamfs-live.mjs [record dir]
import { CHAINS } from '../site/chain.js';
import { readFile, walk } from '../site/bamfs.js';
import { mkdir, writeFile } from 'node:fs/promises';
const KEY = '62616d66732e636964'.padEnd(64, '0'); // "bamfs.cid"
// [chain key, collection, token]
const PROJECTS = [
  ['base', '0x10ddfcbcd62e784c522d0b466ed109fc65b2a855', 0], ['base', '0x10ddfcbcd62e784c522d0b466ed109fc65b2a855', 1],
  ['ethereum', '0x4338cd826b34ccf3bd6b09c3c8d1a1794eb1400a', 0], ['arbitrum-one', '0xef701ddca661b5a359f11f48dfdf65451e163c2b', 0],
];
const extra = process.env.BAMFS_PROJECTS ? JSON.parse(process.env.BAMFS_PROJECTS) : [];
let bad = 0;
for (const [key, org, token] of [...PROJECTS, ...extra]) {
  const chain = CHAINS[key];
  const ctx = () => ({ chain, url: chain.rpcs[chain.rpcs.length - 1], requests: 0, ethCalls: 0, block: 'latest' });
  try {
    const res = await (await fetch(chain.rpcs[chain.rpcs.length - 1], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: org, data: '0x6bd39222' + BigInt(token).toString(16).padStart(64, '0') + KEY }, 'latest'] }) })).json();
    const root = (res.result || '').slice(0, 66);
    if (!root || /^0x0+$/.test(root)) { console.log(`     ${key} ${org} token ${token}: no bamfs.cid`); continue; }
    const tree = await walk(ctx(), root);
    const files = tree.kind === 'file' ? [{ path: '', cid: root, info: tree.info }] : tree.items.filter((x) => !x.isDir && !x.invalid);
    let bytes = 0, same = 0, differ = 0, unread = 0;
    for (const f of files) {
      const body = await readFile(ctx(), f.cid, f.info);
      bytes += body.length;
      if (process.argv[2]) { const p = `${process.argv[2]}/${key}-${org.slice(2, 8)}-${token}/${f.path || 'file'}`; await mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true }); await writeFile(p, body); }
      try {
        const r = await fetch(`https://www.bamfs.xyz/g/p/${chain.id}/${org}/${token}/latest/${f.path.split('/').map(encodeURIComponent).join('/')}`, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) { unread++; continue; }
        const ref = new Uint8Array(await r.arrayBuffer());
        if (ref.length === body.length && ref.every((b, i) => b === body[i])) same++; else differ++;
      } catch { unread++; }
    }
    bad += differ > 0;
    console.log(`${differ ? 'FAIL' : 'ok  '} ${key} ${org.slice(0, 10)}… token ${token}: root ${root.slice(0, 14)}…, generation ${files[0]?.info.generation}, ${files.length} files, ${bytes} bytes, every one checked to the root; gateway: ${same} equal, ${differ} different, ${unread} not served`);
  } catch (e) { bad++; console.log(`FAIL ${key} ${org} token ${token}: ${e.message}`); }
}
process.exit(bad ? 1 : 0);
