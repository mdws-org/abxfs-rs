// A token's own page, for contracts that keep their artwork in tokenURI and have no ABX FS root.
//
// tokenURI is computed by the contract, so no storage proof covers it. What is shown here rests on agreement
// (the check page also runs the call itself over proved state, site/evm-state.js, and says what that gives):
// every endpoint is asked at one block, at least two must answer, and all that answer must return the same bytes.
// The reply is then read as the metadata it claims to be: a data: URI holding JSON, whose animation_url (an HTML
// page) or image is itself a data: URI. Anything that points off the chain is reported, not fetched.

import { keccak256 } from './keccak-lookup.js';
import { CALL_GAS, ProvedError, call } from './proved.js';

const toHex = (u) => '0x' + Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const GAS = '0x' + CALL_GAS.toString(16);
// One endpoint for each host name, so that one host is not counted as two.
const byHost = (urls) => [...new Map(urls.map((url) => [new URL(url).host, url])).values()];
const selector = (sig) => toHex(keccak256(new TextEncoder().encode(sig))).slice(0, 10);
const TOKEN_URI = selector('tokenURI(uint256)'), URI = selector('uri(uint256)'); // ERC-721, ERC-1155
const REPLY_BYTES = 12_000_000; // a metadata reply of a few megabytes is hex-encoded at twice its size
const refuse = (message) => { throw new ProvedError('check', message); };

// An ABI-encoded string reply -> its bytes.
function abiString(hex) {
  if (typeof hex !== 'string' || !/^0x([0-9a-f]{2})*$/i.test(hex) || hex.length < 2 + 128) refuse('the reply is not a string');
  const at = (i) => BigInt('0x' + hex.slice(2 + 64 * i, 2 + 64 * (i + 1)));
  if (at(0) !== 32n) refuse('the reply is not a single string');
  const length = at(1);
  if (length > BigInt((hex.length - 130) / 2)) refuse('the string runs past the reply');
  const out = new Uint8Array(Number(length));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(130 + 2 * i, 2), 16);
  return out;
}

// data:<mime>[;charset=…][;base64|;utf8],<payload> -> { mime, bytes }, or null when it is not a data: URI.
function dataUri(text) {
  if (typeof text !== 'string' || !text.startsWith('data:')) return null;
  const comma = text.indexOf(',');
  if (comma < 0) return null;
  const params = text.slice(5, comma).split(';'), payload = text.slice(comma + 1);
  const mime = (params[0] || 'text/plain').toLowerCase();
  if (!/^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*$/.test(mime)) return null;
  if (params.slice(1).some((p) => p.trim().toLowerCase() === 'base64')) {
    let bin;
    try { bin = atob(payload); } catch { return null; }
    return { mime, bytes: Uint8Array.from(bin, (c) => c.charCodeAt(0)) };
  }
  // Not base64: each %XX is one byte, whatever the bytes spell, and a % that is not followed by two hex digits is
  // itself. Other characters are their UTF-8 bytes.
  const raw = new TextEncoder().encode(payload), bytes = new Uint8Array(raw.length);
  const digit = (c) => (c >= 48 && c <= 57 ? c - 48 : (c | 32) >= 97 && (c | 32) <= 102 ? (c | 32) - 87 : -1);
  let n = 0;
  for (let i = 0; i < raw.length; i++) {
    const hi = raw[i] === 37 && i + 2 < raw.length ? digit(raw[i + 1]) : -1, lo = hi >= 0 ? digit(raw[i + 2]) : -1;
    if (lo >= 0) { bytes[n++] = hi * 16 + lo; i += 2; } else bytes[n++] = raw[i];
  }
  return { mime, bytes: bytes.subarray(0, n) };
}

// Media types a token's page may be served as. Anything else is offered as bytes to download, never run.
const PAGE = new Set(['text/html']);
const IMAGE = new Set(['image/svg+xml', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

// What a tokenURI reply holds.
//   { kind: 'page', mime, bytes, name }     an HTML page or an image, all of it on chain
//   { kind: 'offchain', where, name }       the metadata, or the art it names, is at an address off the chain
//   { kind: 'none', why }                   nothing that can be shown
function readTokenUri(uriBytes) {
  const uri = new TextDecoder('utf-8', { fatal: false }).decode(uriBytes).trim();
  if (!uri) return { kind: 'none', why: 'the contract returns an empty tokenURI' };
  const host = (u) => { try { const x = new URL(u); return /^(https?|ipfs|ar):$/.test(x.protocol) ? (x.host || x.protocol + x.pathname.slice(0, 24)) : null; } catch { return null; } };
  const meta = dataUri(uri);
  if (!meta) return host(uri) ? { kind: 'offchain', where: host(uri), what: 'metadata' } : { kind: 'none', why: 'the tokenURI is neither a data: URI nor an address' };
  if (!/json/.test(meta.mime)) return { kind: 'none', why: `the tokenURI holds ${meta.mime}, not metadata` };
  let json;
  try { json = JSON.parse(new TextDecoder().decode(meta.bytes)); } catch { return { kind: 'none', why: 'the metadata is not valid JSON' }; }
  if (!json || typeof json !== 'object') return { kind: 'none', why: 'the metadata is not an object' };
  const name = typeof json.name === 'string' ? json.name.slice(0, 200) : '';
  // The animation is the work when there is one; the image is its still.
  for (const [field, allowed] of [['animation_url', PAGE], ['image', IMAGE]]) {
    const value = json[field];
    if (typeof value !== 'string' || !value) continue;
    const data = dataUri(value);
    if (data && allowed.has(data.mime)) return { kind: 'page', mime: data.mime, bytes: data.bytes, name, field };
    if (data) continue;
    if (host(value)) return { kind: 'offchain', where: host(value), what: field === 'image' ? 'image' : 'animation', name };
    // With no scheme it is an address relative to wherever the metadata is read from: off the chain all the same.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return { kind: 'offchain', where: 'a relative address', what: field === 'image' ? 'image' : 'animation', name };
  }
  return { kind: 'none', why: 'the metadata names no page or image this viewer shows', name };
}

// One call as the endpoints agree on it at one block: `urls` are asked at once, each host once, with the same gas
// named to each; at least two must answer, and all that answer must return the same bytes. Returns { reply, sources } or throws 'rpc' / 'check'.
// `more` endpoints are asked as well only when fewer than two of `urls` answer; what the first ones answered still counts.
// An empty reply ("0x") is an answer like any other: it is compared, and when it is what they agree on, nothing was returned.
async function agreedCall({ urls, more = [], to, data, block, what }) {
  const at = '0x' + block.toString(16);
  const ask = async (list) => (await Promise.allSettled(list.map(async (url) => [new URL(url).host, await call(url, 'eth_call', [{ to, data, gas: GAS }, at], 30_000, REPLY_BYTES)])))
    .filter((a) => a.status === 'fulfilled' && typeof a.value[1] === 'string' && /^0x([0-9a-f]{2})*$/i.test(a.value[1])).map((a) => a.value);
  const first = byHost(urls);
  let got = await ask(first);
  if (got.length < 2 && more.length) { const hosts = new Set(first.map((u) => new URL(u).host)); got = [...got, ...await ask(byHost(more).filter((u) => !hosts.has(new URL(u).host)))]; }
  if (got.length < 2) throw new ProvedError('rpc', `fewer than two endpoints returned ${what} at block ${block}`);
  const hashes = got.map(([host, reply]) => [host, toHex(keccak256(new TextEncoder().encode(reply.toLowerCase())))]);
  if (new Set(hashes.map(([, h]) => h)).size > 1) throw new ProvedError('check', `the endpoints return different replies for ${what} at block ${block}: ${hashes.map(([host, h]) => `${host} ${h.slice(0, 12)}…`).join(', ')}`);
  if (got[0][1].length <= 2) throw new ProvedError('rpc', `the endpoints return nothing for ${what} at block ${block}`);
  return { reply: got[0][1].toLowerCase(), sources: got.map(([host]) => host), hash: hashes[0][1], call: { to, data } };
}

// What each endpoint returns for a call at the block with this hash (EIP-1898): [[host, reply], ...] for those
// that answered. One that does not know the hash, or whose call fails, gives an error and is left out.
async function repliesAt({ urls, to, data, blockHash }) {
  const all = await Promise.allSettled(byHost(urls).map(async (url) => [new URL(url).host, await call(url, 'eth_call', [{ to, data, gas: GAS }, { blockHash }], 30_000, REPLY_BYTES)]));
  return all.filter((a) => a.status === 'fulfilled' && typeof a.value[1] === 'string' && /^0x[0-9a-f]*$/i.test(a.value[1])).map((a) => [a.value[0], a.value[1].toLowerCase()]);
}

// tokenURI(token) as the endpoints agree on it at one block. `block` is a number.
// Returns { bytes, sources, block, hash }.
async function agreedTokenUri({ urls, org, token, block }) {
  let got;
  try { got = await agreedCall({ urls, to: org, data: TOKEN_URI + word(token), block, what: 'a tokenURI' }); } catch (e) {
    if (e.kind !== 'rpc') throw e;
    got = await agreedCall({ urls, to: org, data: URI + word(token), block, what: 'a tokenURI' }); // ERC-1155
  }
  if (got.reply.length <= 2 + 128) throw new ProvedError('rpc', `fewer than two endpoints returned a tokenURI at block ${block}`);
  return { bytes: abiString(got.reply), sources: got.sources, block, hash: got.hash, reply: got.reply, call: got.call };
}

// ABX's generator contract, per chain (from @artblocks/abx-sdk 0.7.0, deployments). For a code project it
// returns the page the project's script, its libraries and the token's data make: the same document the
// project's resolver serves, built on chain from what the collection stores.
const GENERATORS = {
  1: '0xe55e694e2ef7d15d2e59d1778b911f27aaab99f9', 8453: '0x4f74de4835b51414a4da83527589aedc41a26fae', 42161: '0x53818b5d272e24be03358350fbe67fbee59ce239',
  4663: '0x4f74de4835b51414a4da83527589aedc41a26fae', 11155111: '0x7fcf8118d400ff004ff0772a37c24196d9aa7b17', 84532: '0x05823fac69865f8a6c15c69d1cb8f10db87014e2', 421614: '0x53818b5d272e24be03358350fbe67fbee59ce239',
};
const ON_CHAIN_STATUS = selector('onChainStatus(address)'), DOCUMENT = selector('document(address,uint256)');
const TEMPLATE = 1, DIRECTORY = 2; // the generator's branches: a script stored on chain, or a build kept at an address

// A code project's page from the generator, as the endpoints agree on it.
//   { kind: 'page', mime: 'text/html', bytes, complete, unresolved, sources, hash }   the document
//   { kind: 'offchain', where, what: 'code' }       the project's code is a build at an address off the chain
//   { kind: 'none', why }                            the contract is not a code project
//   { kind: 'unread', why }                          a page exists on chain and too few endpoints returned it
// `complete` false means the document names a library by address (a CDN) that the chain does not hold.
async function generatorPage({ chainId, urls, more = [], org, token, block }) {
  const generator = GENERATORS[chainId];
  if (!generator) return { kind: 'none', why: 'no generator contract is known for this chain' };
  const status = await agreedCall({ urls, to: generator, data: ON_CHAIN_STATUS + word(org), block, what: 'the generator\'s status' });
  if (!/^0x([0-9a-f]{64}){5,}$/i.test(status.reply)) refuse('the generator\'s status is not what its interface says');
  const at = (i) => BigInt('0x' + status.reply.slice(2 + 64 * i, 66 + 64 * i));
  const branch = Number(at(0)), unresolved = Number(at(4));
  if (branch !== TEMPLATE && branch !== DIRECTORY) return { kind: 'none', why: 'the contract holds no code' };
  // A large document is more than some endpoints will compute in one call. `more` endpoints are asked only when
  // fewer than two of the first answer.
  let doc;
  try { doc = await agreedCall({ urls, more, to: generator, data: DOCUMENT + word(org) + word(token), block, what: 'the generator\'s document' }); } catch (e) {
    if (e.kind !== 'rpc') throw e;
    return { kind: 'unread', why: 'the project\'s page is built on chain, but fewer than two endpoints returned it; it may be larger than they will compute in one call' };
  }
  const bytes = abiString(doc.reply);
  if (branch === DIRECTORY) {
    let where = 'an address off the chain';
    try { where = new URL(new TextDecoder().decode(bytes).trim()).host || where; } catch { /* not an address this viewer can name */ }
    return { kind: 'offchain', where, what: 'code' };
  }
  return { kind: 'page', mime: 'text/html', bytes, field: 'generator', complete: at(1) === 1n, unresolved, sources: doc.sources, hash: doc.hash, reply: doc.reply, call: doc.call, status: { reply: status.reply, call: status.call } };
}

export { GENERATORS, TOKEN_URI, abiString, agreedCall, agreedTokenUri, dataUri, generatorPage, readTokenUri, repliesAt };
