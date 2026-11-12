// The read-only EVM over proved state, live: tokenURI (or the generator's document) run here at the light
// client's finalized block must equal, byte for byte, what an endpoint's own eth_call returns at that block.
// usage: node tests/evm-live.mjs [filter]
import { BEACONS, CHECKPOINTS } from '../site/checkpoint.js';
import { CALL_GAS, PROOF_ENDPOINTS, call, finalizedBlock } from '../site/proved.js';
import { executionHeader } from '../site/proof.js';
import { provedCall } from '../site/evm-state.js';
import { GENERATORS } from '../site/token.js';
const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const TOKEN_URI = '0xc87b56dd', DOCUMENT = '0x3ee8ffd5';
const { keccak256 } = await import('../site/keccak-lookup.js');
const sel = (sig) => '0x' + Buffer.from(keccak256(new TextEncoder().encode(sig)).slice(0, 4)).toString('hex');
// [name, to, calldata]
const CASES = [
  ['an SVG image token: tokenURI', '0xff75c6d3d76fea5fa19f9a14422a87ee88717b5f', TOKEN_URI + w(0)],
  ['a script project with 100 dependencies (Under the Influence): tokenURI', '0x2425e1d43b522c118710a011722707aaed1f3180', TOKEN_URI + w(0)],
  ['hollerith: tokenURI', '0x50c54a89186a855e68a9d7ca2afe0803a532e1f3', TOKEN_URI + w(1)],
  ['HODL (a custom renderer): tokenURI', '0x75aae533d370bdd710de5659a1771ac52a296cbe', TOKEN_URI + w(0)],
  ['an ABX FS project: tokenURI', '0xe8978b5d18980fa16494fb83167c84cbbe9a6816', TOKEN_URI + w(0)],
  ['cc0py ABX site (286 KB): the generator\'s document', GENERATORS[1], sel('document(address,uint256)') + w('0x36a34158ad7ead3b8502585136e7add92e4fb8d3') + w(0)],
  ['Marfa Light (1 MB): the generator\'s document', GENERATORS[1], sel('document(address,uint256)') + w('0x4504570d25b710942bee78b7ff5720950c1fc02d') + w(0)],
  ['the generator\'s status for a collection', GENERATORS[1], sel('onChainStatus(address)') + w('0x4504570d25b710942bee78b7ff5720950c1fc02d')],
].filter(([name]) => !process.argv[2] || name.includes(process.argv[2]));
const fin = await finalizedBlock({ chainId: 1, checkpoint: CHECKPOINTS[1].root, beacons: BEACONS[1] });
const urls = PROOF_ENDPOINTS[1];
let header;
for (const url of urls) { try { header = executionHeader(fin.executionBlockHash, await call(url, 'eth_getBlockByHash', [fin.executionBlockHash, false])); break; } catch { /* next */ } }
console.log(`finalized block ${header.number}, state root ${header.stateRoot}`);
let bad = 0;
for (const [name, to, data] of CASES) {
  const t = Date.now();
  let ours;
  try { ours = await provedCall({ chainId: 1, header, urls, to, data }); } catch (e) { bad++; console.log(`FAIL ${name}: ${e.kind || ''} ${e.message}`); continue; }
  let theirs = null;
  for (const url of urls) { try { theirs = await call(url, 'eth_call', [{ to, data, gas: '0x' + CALL_GAS.toString(16) }, { blockHash: fin.executionBlockHash }], 30_000, 12_000_000); break; } catch { /* next */ } }
  const hex = '0x' + Buffer.from(ours.output).toString('hex');
  const same = ours.success && theirs !== null && hex === theirs.toLowerCase();
  bad += !same;
  console.log(`${same ? 'ok  ' : 'FAIL'} ${name}: ${ours.output.length} bytes ${same ? 'equal to eth_call' : ours.success ? 'DIFFERENT from eth_call' : 'reverted here'}; ${ours.gasUsed} gas, ${ours.stats.accounts} accounts, ${ours.stats.words} storage words, ${Math.round(ours.stats.codeBytes / 1024)} KB of code, ${ours.stats.requests} requests via ${ours.via}; ${Date.now() - t} ms`);
}
process.exit(bad ? 1 : 0);
