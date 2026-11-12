// Base's state as Base has committed it on Ethereum, read with no server believed.
//
// Base posts a claim about its state every 6,000 L2 blocks as a contract on Ethereum (a "dispute game"). Three
// Ethereum contracts say which claims count: OptimismPortal2 names the AnchorStateRegistry; the registry names
// the DisputeGameFactory, the game type it respects, a time before which games are retired, a blacklist, and the
// newest game whose claim has become final (the anchor); the factory records every game it created.
//
// Every fact below is read by Merkle proof against a finalized Ethereum block (site/proved.js). The three
// contracts are upgradeable proxies, so each one's implementation address is proved first and must be the one
// whose storage layout was read from verified source; after an upgrade nothing is claimed until this file is
// brought up to date. A game is a small clone whose claim sits in its code, so its code hash is proved and the
// code an endpoint gives must hash to it.

import { keccak256 } from './keccak-lookup.js';
import { accountAt, executionHeader } from './proof.js';
import { ProvedError, call, collectionParamAt, provedAccount, provedCode } from './proved.js';

const toHex = (u) => '0x' + Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/../g)?.map((x) => parseInt(x, 16)) ?? []);
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const hash = (...hex) => toHex(keccak256(fromHex(hex.map((h) => h.replace(/^0x/, '')).join(''))));
const addressOf = (w) => '0x' + w.slice(-40);
const refuse = (message) => { throw new ProvedError('check', message); };

// Ethereum mainnet. Addresses from docs.base.org; implementations and layouts from Sourcify (2026-11-11).
const PORTAL = '0x49048044d57e1c92a77f79988d21fa8faf74e97e', PORTAL_IMPL = '0x03863ab7f64b733cff85c8ff44a86601c568ca70';
const REGISTRY = '0x909f6cf47ed12f010a796527f562bfc26c7f4e72', REGISTRY_IMPL = '0x4483f964f6711cb55f633820ed174e780369b99d';
const FACTORY = '0x43edb88c4b80fdd2adff2412a7bebf9df42cb40e', FACTORY_IMPL = '0x94eab8f73fd83407d26c006d159923760d483029';
const GAME_TYPE = 621, GAME_IMPL = 'c08b8ffaf04abb1d7013b74a0e57eccbd7fa5a70'; // AggregateVerifier
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'; // EIP-1967
const SLOT = (n) => '0x' + word(n);
// A game is this 98-byte clone of the implementation, then its arguments, then two bytes giving their length.
const CLONE_HEAD = '36602c57343d527f9e4ac34f21c619cefc926c8bd93b54bf5a39c7ab2127a895af1cc0691d7e3dff593da1005b363d3d373d3d3d3d61030a806062363936013d73' + GAME_IMPL + '5af43d3d93803e606057fd5bf3';
const STATUS = { inProgress: 0, challengerWins: 1, defenderWins: 2 };

// Base (L2).
const MESSAGE_PASSER = '0x4200000000000000000000000000000000000016';
// Endpoints that serve eth_getProof on Base with CORS. The first keeps state for days, which the anchor needs.
const BASE_PROOF_ENDPOINTS = ['https://base-mainnet.public.blastapi.io', 'https://base.drpc.org'];

// One game, proved: that it is a clone of the pinned implementation, what it claims, that the factory created
// it, that the registry has not blacklisted or retired it, and where it stands.
async function game({ fin, urls, proxy, retirementTimestamp, deps }) {
  const { provedAccount, provedCode } = deps;
  const own = await provedAccount({ fin, urls, address: proxy, slots: [SLOT(0), SLOT(7)] });
  if (!own.exists) refuse(`there is no game at ${proxy}`);
  const code = (await provedCode({ urls, address: proxy, codeHash: own.codeHash, blockNumber: own.block.number })).slice(2);
  // The code is bound by its proved hash, and what is read from it is bound again by the factory's record below.
  if (!code.startsWith(CLONE_HEAD) || code.length < CLONE_HEAD.length + 2 * 136 + 4) refuse(`the game at ${proxy} is not a clone of the implementation this viewer knows`);
  const args = code.slice(CLONE_HEAD.length, -4);
  // creator (20 bytes), root claim (32), L1 parent hash (32), then the extra data: L2 block (32), parent game (20), intermediate roots.
  const rootClaim = '0x' + args.slice(40, 104), extra = args.slice(168), l2Block = BigInt('0x' + extra.slice(0, 64));
  if (l2Block > BigInt(Number.MAX_SAFE_INTEGER)) refuse('the game names an L2 block too large to be one');
  // The factory's record: keccak(abi.encode(gameType, rootClaim, extraData)) -> type, creation time, proxy.
  const padded = extra + '0'.repeat((64 - (extra.length % 64)) % 64);
  const uuid = hash(word(GAME_TYPE), rootClaim, word(96), word(extra.length / 2), padded);
  const record = BigInt((await provedAccount({ fin, urls, address: FACTORY, slots: [hash(uuid, word(103))] })).words[0]);
  if (addressOf(word(record)) !== proxy || Number(record >> 224n) !== GAME_TYPE) refuse(`the factory has no record of the game at ${proxy} under what it claims`);
  const blacklisted = BigInt((await provedAccount({ fin, urls, address: REGISTRY, slots: [hash(word(proxy), word(5))] })).words[0]);
  if (blacklisted) refuse(`the game at ${proxy} is blacklisted`);
  const s0 = BigInt(own.words[0]), s7 = BigInt(own.words[1]);
  const createdAt = Number(s0 & 0xffffffffffffffffn), resolvedAt = Number((s0 >> 64n) & 0xffffffffffffffffn);
  if (!((s0 >> 144n) & 0xffn)) refuse(`the game at ${proxy} was not of the respected type when it was created`);
  if (createdAt <= retirementTimestamp) refuse(`the game at ${proxy} is retired`);
  return { proxy, rootClaim, l2Block: Number(l2Block), createdAt, resolvedAt, status: Number((s0 >> 128n) & 0xffn), proofCount: Number((s7 >> 64n) & 0xffn) };
}

// The claims that count, proved at the Ethereum block `fin` names:
//   anchor  the newest claim that has become final under Base's rules (a game that resolved in the claimant's favour)
//   latest  the newest claim posted, if a proof was accepted for it and nobody has won a challenge to it; else null
// `urls` are Ethereum proof endpoints. `deps` lets tests/base-rules.mjs supply a made-up Ethereum state.
async function baseClaims({ fin, urls, deps = { provedAccount, provedCode } }) {
  const read = (address, slots) => deps.provedAccount({ fin, urls, address, slots });
  const implementation = async (address, want, name, slots) => {
    const a = await read(address, [IMPLEMENTATION_SLOT, ...slots]);
    if (!a.exists) refuse(`${name} does not exist at the finalized block`);
    if (addressOf(a.words[0]) !== want) refuse(`${name} has been upgraded since this viewer was written, so its storage is not read`);
    return { words: a.words.slice(1), block: a.block };
  };
  const portal = await implementation(PORTAL, PORTAL_IMPL, 'OptimismPortal2', [SLOT(62)]);
  if (addressOf(portal.words[0]) !== REGISTRY) refuse('the portal names another anchor state registry');
  const registry = await implementation(REGISTRY, REGISTRY_IMPL, 'AnchorStateRegistry', [SLOT(1), SLOT(2), SLOT(6)]);
  if (addressOf(registry.words[0]) !== FACTORY) refuse('the registry names another dispute game factory');
  const packed = BigInt(registry.words[2]);
  if (Number(packed & 0xffffffffn) !== GAME_TYPE) refuse('the registry respects a game type this viewer does not read');
  const retirementTimestamp = Number((packed >> 32n) & 0xffffffffffffffffn);
  const factory = await implementation(FACTORY, FACTORY_IMPL, 'DisputeGameFactory', [hash(word(GAME_TYPE), word(101)), SLOT(104)]);
  if (addressOf(factory.words[0]) !== '0x' + GAME_IMPL) refuse('the factory creates games from another implementation');
  const count = BigInt(factory.words[1]);
  if (count === 0n) refuse('the factory has created no games');

  const anchor = await game({ fin, urls, proxy: addressOf(registry.words[1]), retirementTimestamp, deps });
  if (anchor.status !== STATUS.defenderWins) refuse('the anchor game did not resolve in the claimant\'s favour');

  // The newest game in the factory's list. It counts only while unresolved with a proof accepted, or resolved
  // in the claimant's favour.
  let latest = null;
  const newest = BigInt((await read(FACTORY, ['0x' + word(BigInt(hash(word(104))) + count - 1n)])).words[0]);
  if (Number(newest >> 224n) === GAME_TYPE) {
    try {
      const g = await game({ fin, urls, proxy: addressOf(word(newest)), retirementTimestamp, deps });
      if (g.status !== STATUS.challengerWins && g.proofCount >= 1 && g.l2Block >= anchor.l2Block) latest = g;
    } catch (e) { if (e.kind !== 'check') throw e; }
  }
  return { l1Block: portal.block, anchor, latest };
}

// A token parameter on Base at the L2 block a claim names. The claim is an output root:
//   keccak(version 0 . L2 state root . storage root of the L2-to-L1 message passer . L2 block hash)
// Its parts come from an untrusted Base endpoint and must hash to the claim, which also settles which block it is. `urls` are Base proof endpoints.
async function baseTokenParam({ claim, urls = BASE_PROOF_ENDPOINTS, org, token, key }) {
  const at = '0x' + claim.l2Block.toString(16);
  let last = new ProvedError('rpc', 'no endpoint to ask for a proof');
  for (const url of urls) {
    try {
      const block = await call(url, 'eth_getBlockByNumber', [at, false]);
      if (!block || typeof block.hash !== 'string') throw new ProvedError('rpc', 'the endpoint has no such block');
      const header = executionHeader(block.hash, block);
      const passer = await call(url, 'eth_getProof', [MESSAGE_PASSER, [], at]);
      const passerAccount = accountAt(header.stateRoot, MESSAGE_PASSER, passer.accountProof) || refuse('the message passer does not exist in that state');
      const outputRoot = hash(word(0), header.stateRoot, passerAccount.storageRoot, block.hash);
      if (outputRoot !== claim.rootClaim) throw new ProvedError('check', `the block the endpoint gave makes the output root ${outputRoot}, not the claim ${claim.rootClaim}`);
      const l2 = { number: header.number, hash: block.hash.toLowerCase(), timestamp: header.timestamp };
      return { ...await collectionParamAt({ url, stateRoot: header.stateRoot, at, org, token, key }), block: l2, via: new URL(url).host };
    } catch (e) { last = e; }
  }
  throw last;
}

export { BASE_PROOF_ENDPOINTS, baseClaims, baseTokenParam };
