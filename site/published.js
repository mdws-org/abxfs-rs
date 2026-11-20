// Where a build of this viewer's check page is published on chain, and how a copy compares itself with it.
//
// The check page is also made as one self-contained file (tools/build-check-file.py) and published through ABX FS
// beside a file, build.txt, that holds the build's hash. A copy of the check page, wherever it was loaded from,
// reads build.txt from chain, every byte checked against the project's root, and says whether the build it is
// is the one published. That does not make a copy that was tampered with honest: such a copy can say anything.
// It tells a reader who has an honest copy whether it is the current one, and it gives anyone a value on chain
// to compare a copy with by other means (the file's SHA-256, or abxfs-rs reading the same project).

// The project that holds the published check page: { chainId, org, token }, or null while none is published.
// Base, org "TheBenMeadows", project 2 ("from-chain check page"), first published 2026-11-13. Each change to
// the viewer's code is published there as the project's next version, with its build.txt.
const PUBLISHED = { chainId: 8453, org: '0x6cb8206e55cf52e069fd3ed3d75b5d391934693c', token: '2' };
const BUILD_FILE = 'build.txt', CHECK_FILE = 'abxfs-check.html';
const HASH = /^[0-9a-f]{64}$/;
// build.txt is two lines: the code hash of the viewer (what a copy knows about itself: the hash over its files
// without the light client's starting block, which is replaced every week), and the SHA-256 of the one file as
// published (what a reader can compute from the file they hold). A third line may follow: the IPFS CID of the
// whole viewer as built (a CIDv1 in base32), from which any IPFS node gives the files of that build.
// The first line reads "code <hash>". The first version published reads "build <hash>" and names a hash over
// every file, starting block included; it is read, and no copy made since equals it.
const LINES = /^(?:code|build) ([0-9a-f]{64})\nsha256 ([0-9a-f]{64})  abxfs-check\.html(?:\nipfs (b[a-z2-7]{20,100}))?\n?$/;

// What a published project holds: { code, sha256, ipfs } (ipfs is null when build.txt has no third line). `read(path)` returns the bytes of one file under the
// project's current root, already checked against it. Throws when the file is missing or is not those two lines.
async function publishedBuild(read) {
  const m = LINES.exec(new TextDecoder().decode(await read(BUILD_FILE)));
  if (!m) throw new Error(`${BUILD_FILE} on chain is not a code hash and a file hash`);
  return { code: m[1], sha256: m[2], ipfs: m[3] || null };
}

// What a copy says about itself. `mine` is this copy's code hash; `published` is the one on chain, or null
// with `why` when it could not be read.
function compareBuild(mine, published, why = '') {
  if (!HASH.test(String(mine))) return { state: 'unknown', text: 'this copy does not know its own code hash' };
  if (published === null || published === undefined) return { state: 'unknown', text: `the published code hash could not be read from chain: ${why || 'no reason given'}` };
  if (!HASH.test(String(published))) return { state: 'unknown', text: 'what is published on chain is not a code hash' };
  return published === mine ? { state: 'same', text: 'this copy runs the code in the published project' } : { state: 'different', text: `this copy does not run the code in the published project, which is ${published}` };
}

export { BUILD_FILE, CHECK_FILE, PUBLISHED, compareBuild, publishedBuild };
