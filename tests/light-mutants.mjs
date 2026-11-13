// Do the light-client tests have teeth? Each mutant is site/light.js with one check removed. tests/light-replay.mjs and
// tests/light-synth.mjs are run against it and at least one must FAIL; a mutant the cases let through means a check nothing tests.
// usage: node tests/light-mutants.mjs
import { readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(new URL('.', import.meta.url).pathname, '..');
const src = await readFile(join(root, 'site/light.js'), 'utf8');
// [what is removed, text to find, replacement]
const MUTANTS = [
  ['the BLS signature check', 'if (!eth_fast_aggregate_verify(committee, bits, signingRoot, signature))', 'if (false)'],
  ['an unknown fork being said', "if (!listed) throw new LightError('fork',", "if (false) throw new LightError('fork',"],
  ['a listed fork from another epoch being said', "if (since !== null && since !== listed[1]) throw", "if (false) throw"],
  ['the finalized root to start from next', 'finalizedRoot: shipped ? toHex(root) : toHex(beaconBlockHeaderRoot(u.finalized.beacon)),', 'finalizedRoot: toHex(root),'],
  ['the two-thirds participation rule', 'if (participants * 3 < SYNC_COMMITTEE_SIZE * 2)', 'if (false)'],
  ['the base fee fitting in 256 bits', "if (base >> 256n) refuse(`${what} base fee does not fit in 256 bits`);", ''],
  ['signature slot after the signed header', 'if (signatureSlot <= attested.beacon.slot)', 'if (false)'],
  ['the finality branch', "if (!is_valid_normalized_merkle_branch(beaconBlockHeaderRoot(finalized.beacon), branchOf(raw.finality_branch, 'finality branch'), form.finalizedRoot, attested.beacon.stateRoot))", 'if (false)'],
  ['the execution payload branch', 'if (!is_valid_normalized_merkle_branch(executionPayloadHeaderRoot(header.execution), header.executionBranch, EXECUTION_PAYLOAD_GINDEX, header.beacon.bodyRoot))', 'if (false)'],
  ['the execution block hash branch (Gloas form)', 'if (!is_valid_normalized_merkle_branch(header.executionBlockHash, header.executionBranch, gindex, header.beacon.bodyRoot))', 'if (false)'],
  ['bootstrap header equals the shipped root', 'if (!equal(beaconBlockHeaderRoot(header.beacon), root))', 'if (false)'],
  ['the bootstrap committee branch', "if (!is_valid_normalized_merkle_branch(syncCommitteeRoot(first), branchOf(boot.current_sync_committee_branch, 'bootstrap sync committee branch'), bootForm.currentSyncCommittee, header.beacon.stateRoot))", 'if (false)'],
  ['the next committee branch', "if (!is_valid_normalized_merkle_branch(syncCommitteeRoot(next), branchOf(raw.next_sync_committee_branch, 'next sync committee branch'), form.nextSyncCommittee, attested.beacon.stateRoot))", 'if (false)'],
  ['the maximum age of the shipped block', 'if (wallSlot - checkpointSlot > MAX_CHECKPOINT_AGE_SLOTS)', 'if (false)'],
  ['the maximum age of the finalized block', 'if (wall() - finalizedSlot > MAX_FINALIZED_AGE_SLOTS)', 'if (false)'],
  ['the shipped block standing in for an older finalized block', 'const shipped = u.finalized.beacon.slot < checkpointSlot;', 'const shipped = false;'],
  ['signature not in the future', 'if (u.signatureSlot > wall() + 1)', 'if (false)'],
  ['extra data length inside the hash', 'hash(extra, uintChunk(e.extraData.length))', 'hash(extra, uintChunk(0))'],
  ['the fork version in the signing domain', "const domain = compute_domain(net, compute_fork_version(net, epochAt(Math.max(signatureSlot, 1) - 1)));", "const domain = compute_domain(net, bytes(net.forks[0][2], 4, 'v'));"],
  ['zero padding of a long branch', 'for (let i = 0; i < extra; i++) if (!equal(branch[i], ZERO)) return false;', ''],
];

// Checks that are a second guard: with one removed, the same forged input is still refused by another check.
// They are listed so the claim is tested: if a suite ever starts failing here, the guard is no longer redundant.
const SECOND_GUARDS = [
  // Keys that cancel to nothing need the point at infinity as their signature, and that is refused on its own.
  ['the infinity check on the aggregate key', 'if (aggregate.is0()) return false;', ''],  // A number too large to be exact changes the header's hash, so the signature over it fails as well.
  ['numbers limited to fifteen digits', "!/^(0|[1-9][0-9]{0,14})$/.test(s)", "!/^(0|[1-9][0-9]*)$/.test(s)"],
];

let bad = 0;
for (const [i, [what, find, put]] of MUTANTS.entries()) {
  if (src.split(find).length !== 2) { console.log(`FAIL mutant ${i}: "${what}" does not match the source exactly once`); bad++; continue; }
  const file = join(root, `site/.light-mutant-${i}.js`);
  await writeFile(file, src.replace(find, put));
  const runs = ['tests/light-replay.mjs', 'tests/light-synth.mjs'].map((t) => spawnSync(process.execPath, [join(root, t), file], { encoding: 'utf8' }));
  await rm(file);
  const caught = runs.some((r) => r.status === 1);
  const first = (runs.map((r) => r.stdout.split('\n').find((l) => l.startsWith('FAIL'))).find(Boolean) || '').slice(0, 130);
  console.log(`${caught ? 'ok  ' : 'FAIL'} without ${what}: ${caught ? 'caught: ' + first : 'NOT CAUGHT by either suite'}`);
  if (!caught) bad++;
}
for (const [what, find, put] of SECOND_GUARDS) {
  if (src.split(find).length !== 2) { console.log(`FAIL second guard "${what}" does not match the source exactly once`); bad++; continue; }
  const file = join(root, 'site/.light-mutant-guard.js');
  await writeFile(file, src.replace(find, put));
  const runs = ['tests/light-replay.mjs', 'tests/light-synth.mjs'].map((t) => spawnSync(process.execPath, [join(root, t), file], { encoding: 'utf8' }));
  await rm(file);
  const still = runs.every((r) => r.status === 0);
  console.log(`${still ? 'ok  ' : 'FAIL'} without ${what}: ${still ? 'still refused by another check, as expected' : 'a suite now fails; this guard is no longer redundant, move it to MUTANTS'}`);
  if (!still) bad++;
}
console.log(bad ? `${bad} problem(s)` : `ok: all ${MUTANTS.length} mutants caught, ${SECOND_GUARDS.length} second guards confirmed`);
process.exit(bad ? 1 : 0);
