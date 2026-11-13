// The block root the light client starts from. One is built into the viewer (site/checkpoint.js). A reader may
// give one of their own, from any source they trust, and then nothing rests on the one this viewer shipped
// with or on how often it is refreshed. It is still subject to the light client's own rules: the block must be
// one a beacon node can start a light client from, and no older than 14 days.

import { CHECKPOINTS } from './checkpoint.js';

const ROOT = /^0x[0-9a-f]{64}$/;
const cleaned = (text) => (typeof text === 'string' ? text.trim().toLowerCase() : '');
const isRoot = (text) => ROOT.test(cleaned(text));

// The starting block for a chain, first of these that applies:
//   { root, own: true, built }                          the reader's own root, when given and well formed
//   { root, slot, date, remembered: true, own: false }  a finalized block this browser reached on an earlier visit,
//                                                       when it is newer than the built-in one
//   { root, slot, date, own: false, built }             the built-in one
//   null                                                this viewer has no light client for the chain
// A reader's root for a chain with no built-in one is not used: there is no light client to start from it.
// `remembered` is what rememberable() returned on an earlier visit; anything else there is ignored.
function startingBlock(chainId, own, checkpoints = CHECKPOINTS, remembered = null) {
  const built = checkpoints[chainId] || null;
  if (!built) return null;
  if (isRoot(own) && cleaned(own) !== built.root) return { root: cleaned(own), own: true, built };
  const r = remembered;
  if (r && isRoot(r.root) && Number.isSafeInteger(r.slot) && r.slot > built.slot && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) return { root: cleaned(r.root), slot: r.slot, date: r.date, remembered: true, own: false, built };
  return { ...built, own: false, built };
}

// What to remember after a run of the light client from `start` reached `fin`, so that the next visit starts
// from it: the finalized block's root, slot and date. Null when there is nothing newer to remember: the run fell
// back to its starting block, or the block is no newer than the built-in one or than what is remembered.
// A reader's own root, and a root the consensus servers agreed on, are never the start of something remembered:
// the next visit would carry them on unseen, with the standing of a block this browser reached on its own.
function rememberable(start, fin, genesisTime, remembered = null) {
  if (!start || start.own || start.agreed || !fin || fin.shipped || !isRoot(fin.finalizedRoot) || !Number.isSafeInteger(fin.finalizedSlot)) return null;
  const floor = Math.max(start.built ? start.built.slot : 0, remembered && Number.isSafeInteger(remembered.slot) ? remembered.slot : 0);
  if (fin.finalizedSlot <= floor) return null;
  const date = new Date((genesisTime + fin.finalizedSlot * 12) * 1000).toISOString().slice(0, 10);
  return { root: cleaned(fin.finalizedRoot), slot: fin.finalizedSlot, date };
}

// A starting block that consensus servers agree on, for when the built-in one has expired and the reader gave
// none. `answers` is [[host, { root, slot }], ...], each server's own finalized block. The newest block that at
// least two hosts report alike is taken. This rests on those servers, not on anything this viewer shipped with,
// and the page says so.
function agreedStart(answers, built) {
  const groups = new Map();
  for (const [host, a] of answers) {
    if (!a || !isRoot(a.root) || !Number.isSafeInteger(a.slot)) continue;
    const key = `${cleaned(a.root)} ${a.slot}`;
    if (!groups.has(key)) groups.set(key, { root: cleaned(a.root), slot: a.slot, hosts: new Set() });
    groups.get(key).hosts.add(host);
  }
  // An agreed block no newer than the built-in one adds nothing and may be one the servers kept from long ago.
  const ok = [...groups.values()].filter((g) => g.hosts.size >= 2 && (!built || g.slot > built.slot)).sort((x, y) => y.slot - x.slot);
  if (!ok.length) return null;
  return { root: ok[0].root, slot: ok[0].slot, agreed: [...ok[0].hosts].sort(), own: false, built };
}

// One line that says which starting block a proof rests on. `chain` is put before "slot" when given.
function startingText(start, count, chain = '') {
  const slot = (b) => `${chain ? `${chain} slot` : 'slot'} ${count(b.slot)}${b.date ? `, ${b.date}` : ''}`;
  if (start.own) return `yours, ${start.root} (in place of the built-in one, ${slot(start.built)})`;
  if (start.agreed) return `${slot(start)}, a finalized block ${start.agreed.join(' and ')} agree on, used because the built-in one (${slot(start.built)}) has expired`;
  if (start.remembered) return `${slot(start)}, a finalized block this browser reached on an earlier visit (the built-in one is ${slot(start.built)})`;
  return slot(start);
}

// Why a light client run from this starting block proves nothing, or null when it does. The built-in block is
// one two beacon nodes reported as finalized when the viewer was built, so the light client may fall back to it
// when no newer finalized block is offered (`fin.shipped`). A reader's block has no such standing here: it counts
// only when the sync committee's signatures carried the client from it to a newer finalized block.
function unusable(start, fin) {
  if (start.own && fin.shipped) return 'no finalized block newer than the block root you gave was offered, so nothing here shows that your block is final';
  if (start.agreed && fin.shipped) return `no finalized block newer than the one ${start.agreed.join(' and ')} agree on was offered, so nothing here shows that it is final`;
  return null;
}

export { agreedStart, cleaned, isRoot, rememberable, startingBlock, startingText, unusable };
