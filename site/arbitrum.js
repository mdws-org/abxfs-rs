// The state of an Arbitrum-family rollup (Arbitrum One, Robinhood Chain) as confirmed on Ethereum, read with no
// server believed.
//
// The rollup contract on Ethereum keeps the hash of the newest confirmed assertion. An assertion's hash is
//   keccak(parent assertion hash . keccak(abi.encode(state after it)) . inbox accumulator)
// and the state after it holds the hash of the rollup's block at that point. The hash is read by proof at a
// finalized Ethereum block (site/proved.js). What it was made from is taken from the AssertionCreated log an
// endpoint gives and must hash to it. The rollup block's header, from any rollup endpoint, must hash to the block
// hash inside, which gives that block's state root.
//
// The rollup contract is a proxy with two implementations. Both addresses are proved and must be the ones whose
// storage layout was read from verified source; after an upgrade nothing is claimed.

import { keccak256 } from './keccak-lookup.js';
import { executionHeader } from './proof.js';
import { ProvedError, call, collectionParamAt, provedAccount } from './proved.js';

const toHex = (u) => '0x' + Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/../g)?.map((x) => parseInt(x, 16)) ?? []);
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const hash = (...hex) => toHex(keccak256(fromHex(hex.map((h) => h.replace(/^0x/, '')).join(''))));
const addressOf = (w) => '0x' + w.slice(-40);
const refuse = (message) => { throw new ProvedError('check', message); };

const PRIMARY_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'; // EIP-1967: the admin logic
const SECONDARY_SLOT = '0x2b1dbce74324248c222f0ec2d5ed7bd323cfc425b336f0253c5ccfda7265546d'; // the user logic
const LATEST_CONFIRMED = '0x' + word(116), ASSERTIONS = 117; // RollupCore storage (Sourcify, 2026-11-11)
const CONFIRMED = 2;

// Rollups by chain id. `endpoints` serve eth_getProof with CORS; the first keeps state for the days a confirmed
// block is behind. No public endpoint was found that does so for Robinhood Chain.
const ROLLUPS = {
  42161: {
    name: 'Arbitrum One', rollup: '0x4dceb440657f21083db8add07665f8ddbe1dcfc0',
    primary: '0x7fc126ff51183a78c5e0437467f325f661d8df17', secondary: '0x6490ba0a60cc7d3a59c9eee135d9eed24553a60d',
    endpoints: ['https://arbitrum-one.public.blastapi.io', 'https://arbitrum.drpc.org'],
  },
  4663: {
    name: 'Robinhood Chain', rollup: '0x23a19d23e89166adedbdcb432518ab01e4272d94',
    primary: '0xab7a44ce7e66963d2116dce74ab63eef88266c82', secondary: '0xedc23dfc7d1e57ec07ea5ff7419634dbae08ed2c',
    endpoints: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood.drpc.org'],
  },
};

// The newest confirmed assertion of a rollup, proved at the Ethereum block `fin` names, and the rollup block
// hash it commits to. `urls` are Ethereum endpoints. `deps` lets tests supply a made-up Ethereum.
async function confirmed({ fin, urls, chainId, deps = { provedAccount, logs } }) {
  const r = ROLLUPS[chainId] || refuse(`no rollup contract is known for chain ${chainId}`);
  const top = await deps.provedAccount({ fin, urls, address: r.rollup, slots: [PRIMARY_SLOT, SECONDARY_SLOT, LATEST_CONFIRMED] });
  if (!top.exists) refuse(`${r.name}'s rollup contract does not exist at the finalized block`);
  if (addressOf(top.words[0]) !== r.primary || addressOf(top.words[1]) !== r.secondary) refuse(`${r.name}'s rollup contract has been upgraded since this viewer was written, so its storage is not read`);
  const assertion = top.words[2];
  if (BigInt(assertion) === 0n) refuse(`${r.name} has no confirmed assertion`);
  const node = BigInt((await deps.provedAccount({ fin, urls, address: r.rollup, slots: [hash(assertion, word(ASSERTIONS))] })).words[0]);
  const createdAtBlock = Number((node >> 128n) & 0xffffffffffffffffn);
  if (Number((node >> 200n) & 0xffn) !== CONFIRMED) refuse(`${r.name}'s newest confirmed assertion is not marked confirmed`);
  if (!createdAtBlock || createdAtBlock > top.block.number) refuse(`${r.name}'s newest confirmed assertion names an Ethereum block that cannot be right`);
  // The log is only a place to find what the hash was made from: whatever an endpoint gives must hash to it.
  for (const log of await deps.logs({ urls, address: r.rollup, block: createdAtBlock, assertion })) {
    const d = typeof log.data === 'string' && /^0x([0-9a-f]{64}){20,40}$/i.test(log.data) ? log.data.slice(2).match(/.{64}/g) : null;
    const parent = Array.isArray(log.topics) && typeof log.topics[2] === 'string' && /^0x[0-9a-f]{64}$/i.test(log.topics[2]) ? log.topics[2] : null;
    if (!d || !parent) continue;
    // data: seven words about the state before, the state before (6), the state after (6), the inbox accumulator.
    const after = d.slice(13, 19);
    if (hash(parent, hash(...after), d[19]) !== assertion) continue;
    return { name: r.name, assertion, createdAtBlock, l1Block: top.block, blockHash: '0x' + after[0], sendRoot: '0x' + after[1] };
  }
  throw new ProvedError('rpc', `no endpoint gave what ${r.name}'s confirmed assertion was made from`);
}

// The AssertionCreated logs for one assertion in one Ethereum block, from the first endpoint that answers.
async function logs({ urls, address, block, assertion }) {
  let last = new ProvedError('rpc', 'no endpoint to ask for the log');
  for (const url of urls) {
    try {
      const at = '0x' + block.toString(16);
      const list = await call(url, 'eth_getLogs', [{ address, fromBlock: at, toBlock: at, topics: [null, assertion] }]);
      if (Array.isArray(list) && list.length && list.length <= 16) return list;
      last = new ProvedError('rpc', `${new URL(url).host} has no such log`);
    } catch (e) { last = e; }
  }
  throw last;
}

// A token parameter on the rollup at the block a confirmed assertion commits to.
async function rollupTokenParam({ claim, chainId, urls = ROLLUPS[chainId].endpoints, org, token, key }) {
  let last = new ProvedError('rpc', 'no endpoint to ask for a proof');
  for (const url of urls) {
    try {
      const block = await call(url, 'eth_getBlockByHash', [claim.blockHash, false]);
      const header = executionHeader(claim.blockHash, block);
      const l2 = { number: header.number, hash: claim.blockHash, timestamp: header.timestamp };
      return { ...await collectionParamAt({ url, stateRoot: header.stateRoot, at: '0x' + header.number.toString(16), org, token, key }), block: l2, via: new URL(url).host };
    } catch (e) { last = e; }
  }
  throw last;
}

export { ROLLUPS, confirmed, rollupTokenParam };
