// The check page's EVM, in a worker: a contract's call is run here so that the page stays responsive while it
// runs, and so that the page can end a run outright by ending the worker.
//
// One message in, one out. In: { id, chainId, fin, urls, to, data }. Out: { id, result }, where result is what
// computedAt returns without its state. State proved at a block is kept here and used again for later calls at
// the same block, so a second call does not fetch what the first one proved.
import { computedAt } from './evm-state.js';

const states = new Map(); // finalized execution block hash -> proved state

self.onmessage = async ({ data: { id, chainId, fin, urls, to, data } }) => {
  let result;
  try {
    const { state, ...rest } = await computedAt({ chainId, fin, urls, to, data, state: states.get(fin.executionBlockHash) || null });
    if (state) { if (states.size > 2) states.clear(); states.set(fin.executionBlockHash, state); }
    result = { ...rest, stats: rest.stats && { requests: rest.stats.requests, accounts: rest.stats.accounts, words: rest.stats.words, codeBytes: rest.stats.codeBytes } };
  } catch (e) { result = { done: false, why: `the run ended with an error: ${e && e.message ? e.message : e}` }; }
  self.postMessage({ id, result });
};
