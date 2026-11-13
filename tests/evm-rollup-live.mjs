// Calls run by site/evm.js over a rollup's state at a block one of its claims on Ethereum commits to, against
// live chains: the block is reached by proof from Ethereum (the light client, the rollup's contracts there, the
// claim), every account and storage word is proved against that block's state root, and the result must equal
// what an endpoint's own eth_call returns at that block. An endpoint that keeps the block is needed for the
// comparison; when none does, the case is reported as not compared and fails.
// usage: node tests/evm-rollup-live.mjs [a word from a case's name]
import { BEACONS, CHECKPOINTS } from '../site/checkpoint.js';
import { CALL_GAS, PROOF_ENDPOINTS, call, finalizedBlock } from '../site/proved.js';
import { BASE_PROOF_ENDPOINTS, baseClaims, baseTokenParam } from '../site/base.js';
import { ROLLUPS, confirmed } from '../site/arbitrum.js';
import { computedAt } from '../site/evm-state.js';
import { GENERATORS, TOKEN_URI } from '../site/token.js';
import { CHAINS } from '../site/chain.js';
const { keccak256 } = await import('../site/keccak-lookup.js');
const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const sel = (sig) => '0x' + Buffer.from(keccak256(new TextEncoder().encode(sig)).slice(0, 4)).toString('hex');
const rpcs = (id) => Object.values(CHAINS).find((c) => c.id === id).rpcs;
const KEY = '61627866732e636964'.padEnd(64, '0');

const fin = await finalizedBlock({ chainId: 1, checkpoint: CHECKPOINTS[1].root, beacons: BEACONS[1] });
const l1 = PROOF_ENDPOINTS[1];
// Each rollup's block: Base's newest claim that counts (or its final one), Arbitrum One's confirmed assertion.
const claims = await baseClaims({ fin, urls: l1 });
const baseClaim = claims.latest || claims.anchor;
const base = (await baseTokenParam({ claim: baseClaim, org: '0x' + '00'.repeat(20), token: 0, key: KEY })).block;
const arb = await confirmed({ fin, urls: l1, chainId: 42161 });
console.log(`Base block ${base.number} (${claims.latest ? 'newest claim' : 'final claim'}), Arbitrum One block ${arb.blockHash.slice(0, 12)}…`);
const AT = { 8453: { hash: base.hash, urls: BASE_PROOF_ENDPOINTS }, 42161: { hash: arb.blockHash, urls: ROLLUPS[42161].endpoints } };
const CASES = [
  ['Base: an on-chain script page (Desert Syntax): tokenURI', 8453, '0xc4b6048ee69d445dcb63795b89121b40f085738a', TOKEN_URI + w(0)],
  ['Base: a PNG image token: tokenURI', 8453, '0x68ad94208485ae803b5924eb73c241976f48dfd6', TOKEN_URI + w(0)],
  ['Base: a code project behind a resolver (GAF Donor Tiles 2026): the generator\'s document', 8453, GENERATORS[8453], sel('document(address,uint256)') + w('0x5ba6130666276b837e17344c73d89b4e45918d2a') + w(0)],
  ['Base: the generator\'s status for that collection', 8453, GENERATORS[8453], sel('onChainStatus(address)') + w('0x5ba6130666276b837e17344c73d89b4e45918d2a')],
  ['Arbitrum One: a code project (Position Cards): tokenURI', 42161, '0x6dd8e2d3ea605d6cc61f84896f967de476294b2e', TOKEN_URI + w(0)],
  ['Arbitrum One: a code project (Bird Sightings): tokenURI', 42161, '0x73903c55c814e33762acf53dac72f75a82c83724', TOKEN_URI + w(0)],
  ['Arbitrum One: an image token: tokenURI', 42161, '0x56d13c4039f8cadb77e762f3b603501328cfdad1', TOKEN_URI + w(0)],
].filter(([name]) => !process.argv[2] || name.includes(process.argv[2]));
let bad = 0;
for (const [name, chainId, to, data] of CASES) {
  const { hash, urls } = AT[chainId];
  const t = Date.now();
  const ours = await computedAt({ chainId, fin: { executionBlockHash: hash }, urls, to, data });
  let theirs = null;
  for (const url of [...urls, ...rpcs(chainId)]) { try { theirs = (await call(url, 'eth_call', [{ to, data, gas: '0x' + CALL_GAS.toString(16) }, { blockHash: hash }], 30_000, 12_000_000)).toLowerCase(); break; } catch { /* next */ } }
  const same = ours.done && ours.success && theirs !== null && ours.output === theirs;
  bad += !same;
  console.log(`${same ? 'ok  ' : 'FAIL'} ${name}: ${!ours.done ? 'not run: ' + ours.why : !ours.success ? 'the call fails here' : theirs === null ? `${(ours.output.length - 2) / 2} bytes, not compared: no endpoint keeps the block` : `${(ours.output.length - 2) / 2} bytes ${same ? 'equal to eth_call' : 'DIFFERENT from eth_call'}`}${ours.done ? `; ${ours.stats.accounts} accounts, ${ours.stats.words} storage words, ${ours.stats.requests} requests via ${ours.via}` : ''}; ${Date.now() - t} ms`);
}
process.exit(bad ? 1 : 0);
