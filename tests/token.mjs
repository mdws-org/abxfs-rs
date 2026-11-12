// site/token.js: reading a tokenURI reply, case by case, and the agreement rule against made-up endpoints.
// usage: node tests/token.mjs [path to token.js]
const T = await import(process.argv[2] || '../site/token.js');
const enc = (s) => new TextEncoder().encode(s);
const b64 = (s) => Buffer.from(s).toString('base64');
const meta = (o) => enc('data:application/json;base64,' + b64(JSON.stringify(o)));
const HTML = '<!doctype html><title>t</title><script>1</script>', SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';
let bad = 0;
const check = (ok, name, got) => { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ': ' + JSON.stringify(got, (k, v) => (v instanceof Uint8Array ? `<${v.length} bytes>` : v)).slice(0, 160)}`); };
const text = (r) => (r.bytes ? new TextDecoder().decode(r.bytes) : '');

// [name, the tokenURI bytes, check]
const CASES = [
  ['an HTML animation and an SVG image: the animation is the page', meta({ name: 'One', animation_url: 'data:text/html;base64,' + b64(HTML), image: 'data:image/svg+xml;base64,' + b64(SVG) }), (r) => r.kind === 'page' && r.mime === 'text/html' && text(r) === HTML && r.name === 'One'],
  ['an SVG image only', meta({ image: 'data:image/svg+xml;base64,' + b64(SVG) }), (r) => r.kind === 'page' && r.mime === 'image/svg+xml' && text(r) === SVG],
  ['an SVG image as plain text in the URI', meta({ image: 'data:image/svg+xml;utf8,' + SVG }), (r) => r.kind === 'page' && text(r) === SVG],
  ['a percent-encoded SVG image', meta({ image: 'data:image/svg+xml,' + encodeURIComponent(SVG) }), (r) => r.kind === 'page' && text(r) === SVG],
  ['a PNG image', meta({ image: 'data:image/png;base64,' + b64('\x89PNG') }), (r) => r.kind === 'page' && r.mime === 'image/png' && r.bytes.length === 5],
  ['metadata as plain JSON in the URI', enc('data:application/json;utf8,' + JSON.stringify({ image: 'data:image/svg+xml;base64,' + b64(SVG) })), (r) => r.kind === 'page' && r.mime === 'image/svg+xml'],
  ['metadata at an https address', enc('https://resolver.example/t/1/0xabc/0'), (r) => r.kind === 'offchain' && r.where === 'resolver.example' && r.what === 'metadata'],
  ['metadata at an ipfs address', enc('ipfs://bafyabc/1.json'), (r) => r.kind === 'offchain'],
  ['an image at an https address', meta({ image: 'https://arweave.example/x' }), (r) => r.kind === 'offchain' && r.where === 'arweave.example' && r.what === 'image'],
  ['an on-chain image beside an off-chain animation: the animation is the work, and it is off chain', meta({ animation_url: 'https://host.example/a', image: 'data:image/svg+xml;base64,' + b64(SVG) }), (r) => r.kind === 'offchain' && r.what === 'animation'],
  ['an animation that is a script, not a page', meta({ animation_url: 'data:text/javascript;base64,' + b64('alert(1)') }), (r) => r.kind === 'none'],
  ['an image that is HTML', meta({ image: 'data:text/html;base64,' + b64(HTML) }), (r) => r.kind === 'none'],
  ['an animation with a javascript: address', meta({ animation_url: 'javascript:alert(1)' }), (r) => r.kind === 'none'],
  ['metadata that is not JSON', enc('data:application/json;base64,' + b64('{not json')), (r) => r.kind === 'none'],
  ['metadata that is an array', meta([1, 2]), (r) => r.kind === 'none'],
  ['a tokenURI that is HTML itself', enc('data:text/html;base64,' + b64(HTML)), (r) => r.kind === 'none'],
  ['an empty tokenURI', enc(''), (r) => r.kind === 'none'],
  ['bad base64 in the image', meta({ image: 'data:image/png;base64,@@@' }), (r) => r.kind === 'none'],
];
for (const [name, bytes, ok] of CASES) { const r = T.readTokenUri(bytes); check(ok(r), name, r); }

// abiString.
const abi = (s) => '0x' + (32n).toString(16).padStart(64, '0') + BigInt(s.length).toString(16).padStart(64, '0') + Buffer.from(s).toString('hex').padEnd(Math.ceil(s.length / 32) * 64, '0');
check(new TextDecoder().decode(T.abiString(abi('hello'))) === 'hello', 'a string reply is read');
for (const [name, hex] of [['a length past the reply', '0x' + (32n).toString(16).padStart(64, '0') + (99n).toString(16).padStart(64, '0') + '00'.repeat(32)], ['another offset', abi('hello').replace('20', '40')], ['too short', '0x1234'], ['not hex', 'hello']]) {
  let refused = false; try { T.abiString(hex); } catch (e) { refused = e.kind === 'check'; }
  check(refused, `a string reply with ${name} is refused`);
}

// Agreement.
const reply = (s) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: abi(s) }));
const world = (behave) => { globalThis.fetch = async (url, init) => { const b = behave[new URL(url).host]; const { params } = JSON.parse(init.body); if (b === 'down') throw new TypeError('down'); return typeof b === 'function' ? b(params) : reply(b); }; };
const urls = ['https://a.example', 'https://b.example', 'https://c.example'];
const agree = async () => { try { const r = await T.agreedTokenUri({ urls, org: '0x' + '11'.repeat(20), token: '7', block: 100 }); return new TextDecoder().decode(r.bytes) + ' from ' + r.sources.length; } catch (e) { return e.kind; } };
for (const [name, behave, want] of [
  ['three agree', { 'a.example': 'X', 'b.example': 'X', 'c.example': 'X' }, 'X from 3'],
  ['one down, two agree', { 'a.example': 'down', 'b.example': 'X', 'c.example': 'X' }, 'X from 2'],
  ['two down', { 'a.example': 'down', 'b.example': 'down', 'c.example': 'X' }, 'rpc'],
  ['one of three differs', { 'a.example': 'Y', 'b.example': 'X', 'c.example': 'X' }, 'check'],
  ['a 1155 contract: tokenURI reverts everywhere, uri answers', Object.fromEntries(urls.map((u) => [new URL(u).host, (params) => (params[0].data.startsWith('0x0e89341c') ? reply('U') : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'execution reverted' } })))])), 'U from 3'],
]) { world(behave); const got = await agree(); check(got === want, `agreement: ${name}`, got); }
// The generator contract's document, against made-up endpoints.
{
  const { keccak256 } = await import('../site/keccak-lookup.js');
  const sel = (sig) => '0x' + Buffer.from(keccak256(new TextEncoder().encode(sig)).slice(0, 4)).toString('hex');
  const STATUS = sel('onChainStatus(address)'), DOC = sel('document(address,uint256)');
  const w = (n) => BigInt(n).toString(16).padStart(64, '0');
  const status = (branch, complete, unresolved) => '0x' + w(branch) + w(complete) + w(128) + w(0) + w(unresolved);
  const ok = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  const down = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'out of gas' } }));
  // behave: host -> { status, doc } where doc may be 'down'
  const serve = (behave) => { globalThis.fetch = async (url, init) => { const b = behave[new URL(url).host]; const data = JSON.parse(init.body).params[0].data; if (!b) return down(); if (data.startsWith(STATUS)) return ok(b.status); if (data.startsWith(DOC)) return b.doc === 'down' ? down() : ok(abi(b.doc)); return down(); }; };
  const page = async (more = []) => { try { const r = await T.generatorPage({ chainId: 1, urls: ['https://a.example', 'https://b.example'], more, org: '0x' + '11'.repeat(20), token: '0', block: 9 }); return r.kind === 'page' ? `page ${new TextDecoder().decode(r.bytes)} complete ${r.complete} from ${r.sources.length}` : `${r.kind}${r.where ? ' ' + r.where : ''}`; } catch (e) { return e.kind; } };
  const T1 = status(1, 1, 0), HTML2 = '<!doctype html><p>doc</p>';
  for (const [name, behave, more, want] of [
    ['a script project, all on chain', { 'a.example': { status: T1, doc: HTML2 }, 'b.example': { status: T1, doc: HTML2 } }, [], `page ${HTML2} complete true from 2`],
    ['a script project with a library kept elsewhere', { 'a.example': { status: status(1, 0, 1), doc: HTML2 }, 'b.example': { status: status(1, 0, 1), doc: HTML2 } }, [], `page ${HTML2} complete false from 2`],
    ['a build kept at an address', { 'a.example': { status: status(2, 0, 0), doc: 'https://arweave.example/abc/' }, 'b.example': { status: status(2, 0, 0), doc: 'https://arweave.example/abc/' } }, [], 'offchain arweave.example'],
    ['a contract with no code', { 'a.example': { status: status(0, 0, 0), doc: '' }, 'b.example': { status: status(0, 0, 0), doc: '' } }, [], 'none'],
    ['the endpoints give different documents', { 'a.example': { status: T1, doc: HTML2 }, 'b.example': { status: T1, doc: HTML2 + '!' } }, [], 'check'],
    ['the endpoints give different statuses', { 'a.example': { status: T1, doc: HTML2 }, 'b.example': { status: status(2, 0, 0), doc: HTML2 } }, [], 'check'],
    ['one endpoint will not compute the document; a further endpoint will', { 'a.example': { status: T1, doc: HTML2 }, 'b.example': { status: T1, doc: 'down' }, 'c.example': { status: T1, doc: HTML2 } }, ['https://c.example'], `page ${HTML2} complete true from 2`],
    ['too few endpoints will compute the document', { 'a.example': { status: T1, doc: HTML2 }, 'b.example': { status: T1, doc: 'down' } }, [], 'unread'],
  ]) { serve(behave); const got = await page(more); check(got === want, `generator: ${name}`, got); }
}
console.log(bad ? `${bad} FAILED` : 'ok: all token cases');
process.exit(bad ? 1 : 0);
