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

export { judge };
