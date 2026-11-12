// What may be said about a project's current root, given what was proved and what the endpoints agree on.
// One function, used by the service worker (to stop on a mismatch) and by the check page (to state the verdict).
//
//   proved            { known: true, root, block: { number } }   read by proof at the finalized block
//                     { known: false, why }                      no proof: the reason is shown
//   atFinalized       [[host, root], ...]: what each endpoint that answered gives AT THAT SAME BLOCK
//   agreedHead        the root at least two endpoints agree on now
//
// A proof and the endpoints can only be compared at one block. At the finalized block they must give the same
// root; if they do not, one of them is wrong and nothing can tell which, so nothing is shown. The head is
// about a quarter of an hour ahead of the finalized block, so a root that differs there is a version published
// since, which no proof can cover yet.
function judge({ proved, atFinalized = [], agreedHead }) {
  if (!proved || !proved.known) return { state: 'agreed', reason: (proved && proved.why) || 'no proof was attempted' };
  const against = atFinalized.filter(([, root]) => root !== proved.root);
  if (against.length) return { state: 'mismatch', reason: `at block ${proved.block.number} the proof gives ${proved.root}, and ${against.map(([host, root]) => `${host} gives ${root}`).join(', ')}` };
  const compared = atFinalized.length >= 2;
  if (agreedHead.root === proved.root) return { state: 'proved', reason: compared ? 'the proof and the endpoints give the same root at the finalized block, and it is still the current one' : 'the proved root is the one the endpoints give now' };
  if (!compared) return { state: 'agreed', reason: `the endpoints give a root that differs from the one proved at block ${proved.block.number}, and too few of them answered at that block to compare` };
  return { state: 'newer', reason: `this version was published after block ${proved.block.number}, the newest finalized block; the version before it is proved` };
}

export { judge };
