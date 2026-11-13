// The block root the light client starts from. One is built into the viewer (site/checkpoint.js). A reader may
// give one of their own, from any source they trust, and then nothing rests on the one this viewer shipped
// with or on how often it is refreshed. It is still subject to the light client's own rules: the block must be
// one a beacon node can start a light client from, and no older than 14 days.

import { CHECKPOINTS } from './checkpoint.js';

const ROOT = /^0x[0-9a-f]{64}$/;
const cleaned = (text) => (typeof text === 'string' ? text.trim().toLowerCase() : '');
const isRoot = (text) => ROOT.test(cleaned(text));

// The starting block for a chain: the reader's own when one is given and well formed, else the built-in one.
//   { root, own: true, built }               the reader's; `built` is the built-in one, for showing beside it
//   { root, slot, date, own: false, built }  the built-in one
//   null                                     this viewer has no light client for the chain
// A reader's root for a chain with no built-in one is not used: there is no light client to start from it.
function startingBlock(chainId, own, checkpoints = CHECKPOINTS) {
  const built = checkpoints[chainId] || null;
  if (!built) return null;
  if (isRoot(own) && cleaned(own) !== built.root) return { root: cleaned(own), own: true, built };
  return { ...built, own: false, built };
}

// One line that says which starting block a proof rests on. `chain` is put before "slot" when given.
function startingText(start, count, chain = '') {
  const slot = (b) => `${chain ? `${chain} slot` : 'slot'} ${count(b.slot)}, ${b.date}`;
  return start.own ? `yours, ${start.root} (in place of the built-in one, ${slot(start.built)})` : slot(start);
}

// Why a light client run from this starting block proves nothing, or null when it does. The built-in block is
// one two beacon nodes reported as finalized when the viewer was built, so the light client may fall back to it
// when no newer finalized block is offered (`fin.shipped`). A reader's block has no such standing here: it counts
// only when the sync committee's signatures carried the client from it to a newer finalized block.
function unusable(start, fin) {
  if (start.own && fin.shipped) return 'no finalized block newer than the block root you gave was offered, so nothing here shows that your block is final';
  return null;
}

export { cleaned, isRoot, startingBlock, startingText, unusable };
