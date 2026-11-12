// site/bamfs.js against recorded replies (tests/fixtures/bamfs-*.json), offline. As recorded, every file must
// hash as recorded. Then, for every reply, one digit is changed at several places in its result: the read must
// be refused or give the same bytes, never other bytes. Also the FastLZ decoder against hand-made streams.
// usage: node tests/bamfs-replay.mjs [path to bamfs.js]
import { createHash } from 'node:crypto';
import { readFile as fsRead, readdir } from 'node:fs/promises';
const B = await import(process.argv[2] || '../site/bamfs.js');
const { CHAINS } = await import('../site/chain.js');
const dir = new URL('./fixtures/', import.meta.url);
let bad = 0, done = 0;
const check = (ok, text) => { done++; if (!ok) { bad++; if (bad < 12) console.log('FAIL ' + text); } };
const sha = (b) => createHash('sha256').update(b).digest('hex');

async function readAll(fx) {
  const chain = CHAINS[fx.chain], ctx = () => ({ chain, url: fx.url, requests: 0, ethCalls: 0, block: 'latest' });
  const tree = await B.walk(ctx(), fx.root), out = {};
  for (const f of tree.kind === 'file' ? [{ path: '', cid: fx.root, info: tree.info }] : tree.items.filter((x) => !x.isDir && !x.invalid)) out[f.path] = `${f.info.mime} ${sha(await B.readFile(ctx(), f.cid, f.info))}`;
  return out;
}
const outcome = async (fx) => { try { return JSON.stringify(await readAll(fx)); } catch (e) { return e.constructor.name === 'LookupError' ? 'refused' : `crash: ${e.message}`; } };

for (const file of (await readdir(dir)).filter((f) => /^bamfs-.*\.json$/.test(f)).sort()) {
  const fx = JSON.parse(await fsRead(new URL(file, dir), 'utf8'));
  const serve = (replies) => { globalThis.fetch = async (u, init) => (init.body in replies ? new Response(replies[init.body]) : new Response('{"jsonrpc":"2.0","id":1,"error":{"message":"not recorded"}}')); };
  serve(fx.replies);
  const first = await readAll(fx), want = JSON.stringify(first);
  check(Object.keys(fx.files).every((p) => first[p] && first[p].endsWith(' ' + fx.files[p])) && Object.keys(first).length === Object.keys(fx.files).length, `${file}: as recorded, the files do not hash as recorded`);
  let lies = 0;
  for (const [body, text] of Object.entries(fx.replies)) {
    const m = /"result":"(0x[0-9a-f]+)"/.exec(text);
    if (!m) continue;
    const start = m.index + 10, len = m[1].length;
    for (let k = 0; k < 10; k++) {
      const at = start + 2 + Math.floor(((len - 3) * k) / 9);
      const alt = text.slice(0, at) + (text[at] === 'f' ? '0' : 'f') + text.slice(at + 1);
      if (alt === text) continue;
      serve({ ...fx.replies, [body]: alt });
      const got = await outcome(fx);
      lies++;
      check(got === 'refused' || got === want, `${file}: a reply changed at ${at - start} gave ${got.slice(0, 80)}`);
    }
  }
  // Targeted lies: a reply that is well formed and says something else.
  const { keccak256 } = await import('../site/keccak-lookup.js');
  const hx = (str) => Buffer.from(str).toString('hex');
  const selOf = (sig) => Buffer.from(keccak256(new TextEncoder().encode(sig)).slice(0, 4)).toString('hex');
  const withSel = (sig) => Object.entries(fx.replies).filter(([body]) => JSON.parse(body).params[0].data.startsWith('0x' + selOf(sig)));
  const swapIn = (text, from, to) => (text.includes(from) ? text.replace(from, to) : null);
  const name = Object.keys(fx.files).map((p) => p.split('/').pop()).find((n) => n.length > 3), other = 'j' + name.slice(1);
  const mime = Object.values(first)[0].split(' ')[0], otherMime = mime.slice(0, -1) + (mime.endsWith('z') ? 'y' : 'z');
  const targeted = async (what, replies) => { if (!replies) return; serve(replies); const got = await outcome(fx); lies++; check(got === 'refused', `${file}: ${what}: ${got.slice(0, 90)}`); };
  // An entry renamed in the reply that lists it (a node in the second generation, a listing in the first).
  for (const sig of ['getNode(bytes32)', 'listDirectory(bytes32)']) for (const [body, text] of withSel(sig)) { const alt = swapIn(text, hx(name), hx(other)); if (alt) await targeted(`an entry renamed in a ${sig} reply`, { ...fx.replies, [body]: alt }); }
  // A file's type changed in its record.
  for (const sig of ['getFileInfo(bytes32)', 'getFile(bytes32)']) for (const [body, text] of withSel(sig)) { const alt = swapIn(text, hx(mime), hx(otherMime)); if (alt) await targeted(`a file type changed in a ${sig} reply`, { ...fx.replies, [body]: alt }); }
  // Second generation: the directory re-rooted at a node that is valid in itself (the real leaf with an entry
  // renamed, served under the id that blob hashes to).
  for (const [rootBody, rootText] of withSel('rootOf(bytes32)')) {
    const realRoot = /"result":"0x([0-9a-f]{64})"/.exec(rootText)[1];
    const nodeEntry = withSel('getNode(bytes32)').find(([body]) => JSON.parse(body).params[0].data.endsWith(realRoot));
    if (!nodeEntry) continue;
    const [nodeBody, nodeText] = nodeEntry;
    const altText = swapIn(nodeText, hx(name), hx(other));
    if (!altText) continue;
    const res = /"result":"0x([0-9a-f]+)"/.exec(altText)[1];
    const len = parseInt(res.slice(256, 320), 16), blob = Buffer.from(res.slice(320, 320 + 2 * len), 'hex');
    const fakeId = Buffer.from(keccak256(Uint8Array.from([0x22, ...blob]))).toString('hex');
    await targeted('the directory re-rooted at another valid node', { ...fx.replies, [rootBody]: rootText.replace(realRoot, fakeId), [nodeBody.replace(realRoot, fakeId)]: altText });
  }
  console.log(`     ${file}: ${Object.keys(fx.files).length} files, ${Object.keys(fx.replies).length} replies, ${lies} altered replies`);
}

// FastLZ: literal runs and back-references, and streams that are cut short or point before their start.
const hex = (u) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const flz = (bytes) => { try { return hex(B.inflate(Uint8Array.from(bytes))); } catch (e) { return e.constructor.name === 'LookupError' ? 'refused' : `crash: ${e.message}`; } };
check(flz([2, 0x61, 0x62, 0x63]) === '616263', 'FastLZ: a literal run');
check(flz([0, 0x61, 0x20, 0x00]) === '61616161', 'FastLZ: a back-reference of three over one byte');
check(flz([0, 0x61, 0xe0, 0x01, 0x00]) === '61'.repeat(11), 'FastLZ: a long back-reference');
check(flz([2, 0x61, 0x62]) === 'refused', 'FastLZ: a literal run cut short was accepted');
check(flz([0, 0x61, 0x20]) === 'refused', 'FastLZ: a back-reference cut short was accepted');
check(flz([0, 0x61, 0x20, 0x05]) === 'refused', 'FastLZ: a reference before the start was accepted');
check(flz([]) === '', 'FastLZ: an empty stream');
console.log(bad ? `${bad} of ${done} FAILED` : `ok: ${done} checks`);
process.exit(bad ? 1 : 0);
