// The check page. It runs on its own hostname (check.<host>), where no project's script can reach it, and
// states what can be said about a project's current root: read by proof, read from the endpoints, and compared.
import { CHAINS, quantity, rpc } from './chain.js';
import { hostLabel, parseHost, viewUrl } from './target.js';
import { BEACONS, CHECKPOINTS } from './checkpoint.js';
import { PROOF_ENDPOINTS, finalizedBlock, provedTokenParam, tokenParamAt } from './proved.js';
import { judge } from './verdict.js';
import { BUILD } from './files.js';

const $ = (s) => document.querySelector(s);
const ZERO = '0x' + '0'.repeat(64);
const MAX_LAG = { 1: 10, 11155111: 10 };
const ago = (seconds) => (seconds < 90 ? `${Math.round(seconds)} seconds` : seconds < 5400 ? `${Math.round(seconds / 60)} minutes` : seconds < 172800 ? `${Math.round(seconds / 3600)} hours` : `${Math.round(seconds / 86400)} days`);
const count = (n) => n.toLocaleString('en-US');

function fact(name, value, mono) {
  const dt = document.createElement('dt'), dd = document.createElement('dd');
  dt.textContent = name;
  dd.textContent = value;
  if (mono) dd.className = 'mono';
  $('#facts').append(dt, dd);
  $('#facts').hidden = false;
}
function say(state, text, reason = '') {
  $('#verdict').dataset.state = state;
  $('#verdict').textContent = text;
  $('#reason').textContent = reason;
}

// The root at least two endpoints agree on now: the same rule the reader uses for what it shows (view/sw.js).
async function agreedHead(chain, target) {
  const ctx = (url) => ({ chain, url, requests: 0, ethCalls: 0, block: 'latest' });
  const settled = (list) => list.filter((a) => a.status === 'fulfilled').map((a) => a.value);
  const up = settled(await Promise.allSettled(chain.rpcs.map(async (url) => {
    if (quantity(await rpc(ctx(url), 'eth_chainId', []), 'the chain id') !== chain.id) throw new Error('another chain');
    return { url, block: quantity(await rpc(ctx(url), 'eth_blockNumber', []), 'the block number') };
  })));
  const sorted = up.map((u) => u.block).sort((x, y) => x - y);
  const middle = sorted[(sorted.length - 1) >> 1];
  const near = up.filter((u) => Math.abs(u.block - middle) <= (MAX_LAG[chain.id] ?? 10));
  if (near.length < 2) throw new Error(`fewer than two endpoints for ${chain.name} are at the same height`);
  const block = Math.min(...near.map((u) => u.block));
  const got = await tokenParamAt({ urls: near.map((u) => u.url), org: target.org, token: target.token, block });
  if (got.length < 2) throw new Error(`fewer than two endpoints answered at block ${block}`);
  if (new Set(got.map(([, root]) => root)).size > 1) throw new Error(`the endpoints disagree about this project's current version at block ${block}: ${got.map(([h, r]) => `${h} gives ${r}`).join(', ')}`);
  return { root: got[0][1], block, sources: got.map(([h]) => h) };
}

async function proofSwitch() {
  try { const r = await fetch('/_abxfs/switch.json', { cache: 'no-store' }); return !r.ok || (await r.json()).proof !== false; } catch { return true; }
}

async function run() {
  $('#build').textContent = BUILD;
  const label = decodeURIComponent(location.hash.slice(1));
  const target = label && parseHost(label + '.x');
  if (!target) return say('none', 'No project named.', 'Add a project after the # in this address, as "<chain id>-<org address>-<project number>".');
  const chain = Object.values(CHAINS).find((c) => c.id === target.chainId);
  const openUrl = viewUrl(target);
  if (openUrl) { $('#open-link').href = openUrl; }
  if (target.kind === 'root') {
    $('#title').textContent = `Root ${target.root}`;
    $('#open-link').textContent = 'Open this root';
    $('#open').hidden = !openUrl;
    return say('fixed', 'This address names its root.', 'A root never changes, so there is no current version to establish. Every file shown under it is checked against it.');
  }
  $('#title').textContent = `Project ${target.token} of ${target.org}`;
  if (!chain) return say('none', `This viewer does not read chain ${target.chainId}.`);
  fact('Chain', `${chain.name} (${chain.id})`);
  say('working', `Asking the endpoints for ${chain.name}…`);

  let head;
  try { head = await agreedHead(chain, target); } catch (e) { return say('unreachable', 'The endpoints could not be read.', e.message); }
  fact('Root from the endpoints, now', head.root, true);
  fact('Agreed by', `${head.sources.join(', ')} at block ${count(head.block)}`);
  if (head.root === ZERO) { $('#open').hidden = true; return say('none', 'This project has nothing published.'); }
  $('#open').hidden = !openUrl;

  const cp = CHECKPOINTS[chain.id];
  if (!cp || !PROOF_ENDPOINTS[chain.id]) return say('agreed', 'Agreed by the endpoints. Not proved.', `This viewer has no light client for ${chain.name}. The root above is what ${head.sources.length} public endpoints agree on, and that is all that stands behind it.`);
  if (!await proofSwitch()) return say('agreed', 'Agreed by the endpoints. Proving is switched off.', 'The operator of this host has switched proving off, which is done when a fault is found in it. The root above is what the endpoints agree on.');

  say('working', 'Following the sync committee to the newest finalized block…');
  let found;
  try {
    const fin = await finalizedBlock({ chainId: chain.id, checkpoint: cp.root, beacons: BEACONS[chain.id] });
    say('working', 'Reading the project\'s root by proof…');
    const proved = await provedTokenParam({ fin, urls: PROOF_ENDPOINTS[chain.id], org: target.org, token: target.token });
    const atFinalized = proved.known ? await tokenParamAt({ urls: PROOF_ENDPOINTS[chain.id], org: target.org, token: target.token, block: proved.block.number }) : [];
    found = { proved, atFinalized };
  } catch (e) {
    fact('Starting block', `slot ${count(cp.slot)}, ${cp.date}`);
    return say('agreed', 'Agreed by the endpoints. Not proved.', `The proof could not be made: ${e.message || e}`);
  }
  const { proved, atFinalized } = found;
  const v = judge({ proved, atFinalized, agreedHead: head });
  if (proved.known) {
    const age = Date.now() / 1000 - proved.block.timestamp;
    fact('Root by proof', proved.root, true);
    fact('Proved at', `block ${count(proved.block.number)}, finalized, ${ago(age)} old`);
    fact('Block hash', proved.block.hash, true);
    fact('Signed by', `${proved.participants} of 512 sync committee members (beacon slot ${count(proved.finalizedSlot)})`);
    fact('Proof served by', `${proved.via} (checked here; it is not trusted)`);
    fact('Endpoints at that block', atFinalized.length ? atFinalized.map(([h, r]) => `${h}: ${r === proved.root ? 'the same root' : r}`).join('; ') : 'none answered');
  }
  fact('Starting block', `slot ${count(cp.slot)}, ${cp.date}; trusted for 14 days`);
  const texts = {
    proved: 'Proved: this is the project\'s root in the newest finalized block, and the endpoints give the same one.',
    newer: 'Agreed by the endpoints, not yet provable: this version was published in the last few minutes.',
    mismatch: 'The proof and the endpoints disagree. One of them is wrong.',
    agreed: 'Agreed by the endpoints. Not proved.',
  };
  if (v.state === 'mismatch') $('#open').hidden = true;
  say(v.state, texts[v.state], v.reason.charAt(0).toUpperCase() + v.reason.slice(1) + '.');
}

addEventListener('hashchange', () => location.reload());
run().catch((e) => say('failed', 'The check failed.', e.message || String(e)));
