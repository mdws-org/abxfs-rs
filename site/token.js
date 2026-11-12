// A token's own page, for contracts that keep their artwork in tokenURI and have no ABX FS root.
//
// tokenURI is computed by the contract, so no storage proof covers it. What is shown here rests on agreement:
// every endpoint is asked at one block, at least two must answer, and all that answer must return the same bytes.
// The reply is then read as the metadata it claims to be: a data: URI holding JSON, whose animation_url (an HTML
// page) or image is itself a data: URI. Anything that points off the chain is reported, not fetched.

import { keccak256 } from './keccak-lookup.js';
import { ProvedError, call } from './proved.js';

const toHex = (u) => '0x' + Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
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
  if (params.includes('base64')) {
    let bin;
    try { bin = atob(payload); } catch { return null; }
    return { mime, bytes: Uint8Array.from(bin, (c) => c.charCodeAt(0)) };
  }
  // Not base64: the payload is text, percent-encoded or raw.
  let plain = payload;
  try { plain = decodeURIComponent(payload); } catch { /* raw text with a stray % */ }
  return { mime, bytes: new TextEncoder().encode(plain) };
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
  }
  return { kind: 'none', why: 'the metadata names no page or image this viewer shows', name };
}

// tokenURI(token) as the endpoints agree on it at one block. `urls` are asked at once; `block` is a number.
// Returns { bytes, sources, block, hash } or throws: 'rpc' when fewer than two answer, 'check' when they differ.
async function agreedTokenUri({ urls, org, token, block }) {
  const at = '0x' + block.toString(16);
  const ask = async (selectorHex) => {
    const all = await Promise.allSettled([...new Set(urls)].map(async (url) => [new URL(url).host, await call(url, 'eth_call', [{ to: org, data: selectorHex + word(token) }, at], 20_000, REPLY_BYTES)]));
    return all.filter((a) => a.status === 'fulfilled' && typeof a.value[1] === 'string' && a.value[1].length > 2 + 128).map((a) => a.value);
  };
  let got = await ask(TOKEN_URI);
  if (got.length < 2) got = await ask(URI);
  if (got.length < 2) throw new ProvedError('rpc', `fewer than two endpoints returned a tokenURI at block ${block}`);
  const hashes = got.map(([host, reply]) => [host, toHex(keccak256(new TextEncoder().encode(reply.toLowerCase())))]);
  if (new Set(hashes.map(([, h]) => h)).size > 1) throw new ProvedError('check', `the endpoints return different tokenURIs at block ${block}: ${hashes.map(([host, h]) => `${host} ${h.slice(0, 12)}…`).join(', ')}`);
  return { bytes: abiString(got[0][1]), sources: got.map(([host]) => host), block, hash: hashes[0][1] };
}

export { abiString, agreedTokenUri, dataUri, readTokenUri };
