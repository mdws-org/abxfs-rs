// The start page of a viewer hostname: shown until the service worker controls this origin, then replaced by
// the project itself on reload.
import { CHAINS } from './chain.js';
import { parseHost } from './target.js';

const status = document.getElementById('status');
const say = (text) => { status.textContent = text; };
const target = parseHost(location.hostname);
const chain = target && Object.values(CHAINS).find((c) => c.id === target.chainId);
const RELOADS = 'abxfs-view-reloads';
const START_MS = 20_000;

// A reload that still lands on this page means the worker is not answering. Two reloads within half a minute
// is the limit; older ones (an earlier forced reload of a working page) do not count.
let reloading = false;
function reloadOnce() {
  if (reloading) return;
  let recent = [];
  try { recent = JSON.parse(sessionStorage.getItem(RELOADS) || '[]').filter((t) => Date.now() - t < 30_000); } catch { /* start over */ }
  if (recent.length >= 2) return say('The reader started but is not answering for this page. Open "What it read and checked" below and reset the viewer for this address.');
  reloading = true;
  sessionStorage.setItem(RELOADS, JSON.stringify([...recent, Date.now()]));
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
    // `ready` never settles when the worker fails to install, so it gets a deadline.
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, no) => setTimeout(() => no(new Error(`it did not become ready within ${START_MS / 1000} seconds; this browser may not run module service workers`)), START_MS)),
    ]);
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
