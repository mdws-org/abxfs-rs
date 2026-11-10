// The start page of a viewer hostname: shown until the service worker controls this origin, then replaced by
// the project itself on reload.
import { CHAINS } from './chain.js';
import { parseHost } from './target.js';

const status = document.getElementById('status');
const say = (text) => { status.textContent = text; };
const target = parseHost(location.hostname);
const chain = target && Object.values(CHAINS).find((c) => c.id === target.chainId);
const RELOADS = 'abxfs-view-reloads';

// A reload that still lands on this page means the worker is not answering; stop after two.
function reloadOnce() {
  const n = Number(sessionStorage.getItem(RELOADS) || 0);
  if (n >= 2) return say('The reader started but is not answering for this page. Close every tab of this address and open it again.');
  sessionStorage.setItem(RELOADS, String(n + 1));
  location.reload();
}

async function start() {
  if (!target) return say('This address does not name a project or a root. The first part of the hostname is "<chain id>-<org address>-<project number>" for a project, or "r<chain id>-<root in base32>" for a root.');
  if (!chain) return say(`This viewer does not read chain ${target.chainId}.`);
  document.getElementById('title').textContent = target.kind === 'project' ? `Project ${target.token} of ${target.org}` : `Root ${target.root}`;
  if (!('serviceWorker' in navigator)) return say('This browser has no service workers (or blocks them here, as private windows in some browsers do), so it cannot run the reader.');
  say(`Starting the reader for ${chain.name}…`);
  try {
    await navigator.serviceWorker.register('/_abxfs/sw.js', { type: 'module', scope: '/', updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
  } catch (e) {
    return say(`The reader did not start: ${e.message}`);
  }
  say(`Reading from ${chain.name} and checking each file…`);
  if (navigator.serviceWorker.controller) return reloadOnce();
  navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true });
  // A forced reload leaves the page uncontrolled even with an active worker: a plain reload fixes that.
  setTimeout(() => { if (!navigator.serviceWorker.controller) reloadOnce(); }, 3000);
}

start();
