// What may be said about a project's current root, given what was proved and what the endpoints agree on.
// One function, used by the service worker (to stop on a mismatch) and by the check page (to state the verdict).
//
//   proved            { known: true, root, block: { number } }   read by proof at the finalized block
//                     { known: false, why }                      no proof: the reason is shown
//   atFinalized       [[host, root], ...]: what each endpoint that answered gives AT THAT SAME BLOCK
//   agreedHead        { root, block }: the root at least two endpoints agree on now, and the block they are at
//
// A proof and the endpoints can only be compared at one block. At the finalized block every endpoint that answers
// must give the proved root, and at least two must answer; if one gives another root, one side is wrong and
// nothing can tell which, so nothing is shown. The head is about a quarter of an hour ahead of the finalized
// block, so a root that differs there is a version published since, which no proof can cover yet.
//
// The light client decides what is "newest" by this device's clock. The endpoints' head block is a second
// reading of the time: a proved block far behind it is an old block, whatever the clock says.
const MAX_BLOCKS_BEHIND_HEAD = 400; // finality is normally 64 to 96 blocks back; the light client allows 256 slots
function judge({ proved, atFinalized = [], agreedHead }) {
  if (!proved || !proved.known) return { state: 'agreed', reason: (proved && proved.why) || 'no proof was attempted' };
  const against = atFinalized.filter(([, root]) => root !== proved.root);
  if (against.length) return { state: 'mismatch', reason: `at block ${proved.block.number} the proof gives ${proved.root}, and ${against.map(([host, root]) => `${host} gives ${root}`).join(', ')}` };
  if (atFinalized.length < 2) return { state: 'agreed', reason: `a root was proved at block ${proved.block.number}, but fewer than two endpoints answered at that block, so the proof could not be compared with them` };
  const behind = agreedHead.block - proved.block.number;
  // The endpoints' own block is the proved block: this is one more comparison at that block.
  if (behind === 0 && agreedHead.root !== proved.root) return { state: 'mismatch', reason: `at block ${proved.block.number} the proof gives ${proved.root}, and the endpoints asked for the current root give ${agreedHead.root} at that same block` };
  if (!(behind >= 0 && behind <= MAX_BLOCKS_BEHIND_HEAD)) return { state: 'agreed', reason: `the proved block ${proved.block.number} is ${behind} blocks from the block the endpoints are at, which is not where the newest finalized block is` };
  if (agreedHead.root === proved.root) return { state: 'proved', reason: 'the proof and the endpoints give the same root at the finalized block, and it is still the current one' };
  return { state: 'newer', reason: proved.isSet === false ? `this version was published after block ${proved.block.number}, the finalized block that was proved; at that block the project had nothing published` : `this version was published after block ${proved.block.number}, the finalized block that was proved; the version before it is proved` };
}

// A rollup's verdict. Its state reaches Ethereum as claims, days apart from being final, so a proof here says
// which claim the current root matches, and never stops a page:
//   settled   the current root is the root at the L2 block of the newest claim that has become final
//   claimed   it is the root at the L2 block of the rollup's newest claim, which is not final
//   agreed    neither: published since the newest claim, or no proof could be made (the reason says which)
// `anchor` and `latest` are { known: true, root, block } read by proof at those claims, { known: false, why }, or null.
function judgeRollup({ anchor, latest, agreedHead }) {
  if (anchor && anchor.known && anchor.root === agreedHead.root) return { state: 'settled', reason: `this is the project's root at block ${anchor.block.number}, the newest block whose state has become final on Ethereum` };
  if (latest && latest.known && latest.root === agreedHead.root) return { state: 'claimed', reason: `this is the project's root at block ${latest.block.number}, the block of the newest claim posted to Ethereum; the claim is not final` };
  const newest = (latest && latest.known && latest) || (anchor && anchor.known && anchor);
  // A claim that could not be read may be the one that covers this root: say so, and do not say it was published since.
  const unread = [latest, anchor].find((c) => c && !c.known);
  if (newest && unread) return { state: 'agreed', reason: `this is not the project's root at block ${newest.block.number}, and the other claim could not be read: ${unread.why}` };
  if (newest) return { state: 'agreed', reason: `this version was published after block ${newest.block.number}, the newest block a claim on Ethereum covers` };
  return { state: 'agreed', reason: ((latest || anchor) && (latest || anchor).why) || 'no proof was attempted' };
}

// What may be said about a page a contract computes (a tokenURI, the generator's document), which no storage
// proof covers. This viewer runs the contract's code itself over state it has proved at the finalized block.
//
//   computed      { done: true, success, output, block: { number } }   the call run here; `output` is 0x-hex
//                 { done: false, why }                                 not run: the reason is shown
//   atFinalized   [[host, reply], ...]: what each endpoint that answered returns for the call AT THAT SAME BLOCK
//   headReply     what at least two endpoints return now: the bytes the page shown is made from
//   headBlock     the block those endpoints were at
//   supporting    [{ ok, why }, ...]: other calls the choice of this page rested on, each recomputed the same way
//
// Running a contract here is new code beside the nodes' own. So "proved" needs every endpoint that answers at the
// finalized block to return what was computed here, at least two of them, and the same reply now. An endpoint
// that returns something else is said so, in the open: either it or this viewer's own EVM is wrong.
function judgeComputed({ computed, atFinalized, headReply, headBlock, supporting = [] }) {
  if (!computed || !computed.done) return { state: 'agreed', reason: (computed && computed.why) || 'the page was not recomputed' };
  const at = `block ${computed.block.number}`;
  if (!computed.success && atFinalized.length) return { state: 'differs', reason: `at ${at} the call fails when this viewer runs it and ${atFinalized.map(([host]) => host).join(', ')} return${atFinalized.length === 1 ? 's' : ''} a reply` };
  if (!computed.success) return { state: 'agreed', reason: `run here over the proved state of ${at}, the finalized block, the contract's call fails, and no endpoint returned a reply at that block` };
  const dissent = atFinalized.filter(([, reply]) => reply !== computed.output);
  if (dissent.length) return { state: 'differs', reason: `at ${at} this viewer computes one reply and ${dissent.map(([host]) => host).join(', ')} return${dissent.length === 1 ? 's' : ''} another` };
  if (atFinalized.length < 2) return { state: 'agreed', reason: `the page was recomputed here at ${at}, but fewer than two endpoints answered at that block to compare it with` };
  const behind = headBlock - computed.block.number, near = behind >= 0 && behind <= MAX_BLOCKS_BEHIND_HEAD;
  if (!near) return { state: 'agreed', reason: `the finalized block this viewer reached (${at}) is not within ${MAX_BLOCKS_BEHIND_HEAD} blocks of the block the endpoints are at (${headBlock})` };
  if (headReply !== computed.output) return behind === 0 ? { state: 'differs', reason: `at ${at} this viewer computes one reply and the endpoints agreed on another` } : { state: 'newer', reason: `what the contract returns has changed since ${at}, the last finalized block` };
  const unsure = supporting.find((s) => !s.ok);
  if (unsure) return { state: 'agreed', reason: `the page itself was recomputed here at ${at} and the endpoints return the same, but ${unsure.why}` };
  return { state: 'proved', reason: `${atFinalized.length} endpoints return the same at ${at}, and the same now` };
}

// A page a contract computes on a rollup, run here over the rollup's state at a block one of its claims on
// Ethereum commits to. Endpoints seldom keep that block, so there may be nothing to compare with, and without a
// comparison nothing catches a fault in this viewer's own EVM. So this never says "proved":
//   recomputed   the reply computed here is the reply the page is made from, and no endpoint that answered at
//                that block returned another (the reason says how many answered)
//   differs      an endpoint returned another reply at that block
//   agreed       not run, the call fails there, a supporting call did not come out the same, or the reply now is
//                another: the page changed since, or this viewer computes it differently
//   computed, supporting   as for judgeComputed;   atClaim   [[host, reply], ...] at the claim's block
function judgeRollupComputed({ computed, atClaim, headReply, supporting = [] }) {
  if (!computed?.done) return { state: 'agreed', reason: computed?.why || 'the page was not recomputed' };
  const at = `block ${computed.block.number}`;
  const other = atClaim.filter(([, reply]) => !computed.success || reply !== computed.output);
  if (other.length) return { state: 'differs', reason: `at ${at} this viewer computes one reply and ${other.map(([host]) => host).join(', ')} return${other.length === 1 ? 's' : ''} another` };
  if (computed.success === false) return { state: 'agreed', reason: `run here over the state of ${at}, the contract's call fails` };
  if (headReply !== computed.output) return { state: 'agreed', reason: atClaim.length ? `the reply computed here at ${at}, which ${atClaim.length} endpoint${atClaim.length === 1 ? '' : 's'} also returned there, is not the reply the endpoints return now: the page changed since that block` : `the reply computed here at ${at} is not the reply the endpoints return now: the page changed since that block, or this viewer computes it differently, and no endpoint keeps that block to tell which` };
  const shaky = supporting.find((s) => !s.ok);
  if (shaky) return { state: 'agreed', reason: `the page itself was recomputed here at ${at}, but ${shaky.why}` };
  return { state: 'recomputed', reason: atClaim.length ? `${atClaim.length} endpoint${atClaim.length === 1 ? '' : 's'} returned the same at ${at}` : `no endpoint answered at ${at}, so the result was not compared with any` };
}

export { judge, judgeComputed, judgeRollup, judgeRollupComputed };
