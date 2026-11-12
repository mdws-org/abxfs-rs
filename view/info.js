// The info page: asks the service worker what it is showing and lists it.
const $ = (s) => document.querySelector(s);
const short = (h) => h.slice(0, 10) + '…' + h.slice(-6);
const bytes = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KiB' : (n / 1048576).toFixed(2) + ' MiB');

function fact(dl, name, value, mono) {
  const dt = document.createElement('dt'), dd = document.createElement('dd');
  dt.textContent = name;
  dd.textContent = value;
  if (mono) dd.className = 'mono';
  dl.append(dt, dd);
}

function show(info) {
  const dl = $('#facts');
  if (!info.target || !info.chain) {
    $('#status').textContent = 'This address does not name a project or a root this viewer reads.';
    return;
  }
  fact(dl, 'Chain', `${info.chain.name} (${info.chain.id})`);
  if (info.target.kind === 'project') {
    fact(dl, 'Project', `${info.target.token} of ${info.target.org}`, true);
    if (info.head) fact(dl, 'Current root', `agreed by ${info.head.sources.join(', ')} at block ${info.head.block.toLocaleString('en-US')}${info.head.stale ? '; read earlier, the endpoints cannot be reached now' : ''}`);
  }
  if (info.root) fact(dl, 'Root', info.root, true);
  fact(dl, 'Endpoints', info.chain.endpoints.join(', '));
  if (info.custom) fact(dl, 'Your endpoint', `${info.custom}, asked first for every checked read`);
  if (info.check) { $('#check-link').href = info.check; $('#check').hidden = false; }
  showViewer(info);
  dl.hidden = false;
  if (info.error) {
    $('#status').textContent = `The reader could not read this: ${info.error}`;
    return;
  }
  const done = info.project.filter((f) => f.checked).length;
  $('#status').textContent = `${info.project.length} ${info.project.length === 1 ? 'file' : 'files'} under this root; ${done} checked and in memory now. A file is read and checked when a page asks for it.` +
    (info.unnamed ? ` ${info.unnamed} ${info.unnamed === 1 ? 'entry has a name' : 'entries have names'} that cannot be a path, and cannot be opened here.` : '');
  const rows = info.project.map((f) => {
    const tr = document.createElement('tr');
    const cells = [[f.path || '(the root is one file)'], [bytes(f.size), 'n'], [f.codec ? `${f.mime}, ${f.codec}` : f.mime], [short(f.cid), 'mono', f.cid], [f.checked ? 'checked' : 'not yet']];
    for (const [text, cls, title] of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      if (title) td.title = title;
      tr.append(td);
    }
    return tr;
  });
  $('#files tbody').replaceChildren(...rows);
  $('#files').hidden = false;
}

// The viewer's own files, as this worker was built: one hash for the whole build and one per file.
function showViewer(info) {
  $('#build').textContent = info.build;
  const rows = Object.entries(info.files).map(([path, sum]) => {
    const tr = document.createElement('tr');
    for (const [text, cls] of [[path], [sum, 'mono']]) {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      tr.append(td);
    }
    return tr;
  });
  $('#viewer-files tbody').replaceChildren(...rows);
  const differs = (info.host || []).filter(([, state]) => state === 'differs').map(([path]) => path);
  const down = (info.host || []).filter(([, state]) => state === 'unreachable').length;
  $('#host-match').textContent = differs.length ? `This host now serves different files from this build: ${differs.join(', ')}.`
    : down ? 'The host cannot be reached now. These pages are the copies kept in this browser, and they match this build.'
      : 'Checked just now: this host serves exactly these files.';
}

async function worker() {
  const reg = 'serviceWorker' in navigator && await navigator.serviceWorker.getRegistration('/');
  return reg && (reg.active || reg.waiting || reg.installing);
}

// Save or clear the reader's own endpoint. The worker checks that it answers for this chain before keeping it.
async function setEndpoint(value) {
  const out = $('#endpoint-status');
  const w = await worker();
  if (!w) { out.textContent = 'The reader is not running for this address yet. Open the project first.'; return; }
  out.textContent = value ? 'Asking that endpoint…' : 'Clearing…';
  const channel = new MessageChannel();
  channel.port1.onmessage = (e) => {
    out.textContent = e.data.error ? `Not saved: ${e.data.error}` : value ? 'Saved.' : 'Cleared.';
    if (!e.data.error) location.reload();
  };
  w.postMessage({ type: 'abxfs-endpoint', value }, [channel.port2]);
}

async function ask() {
  const w = await worker();
  if (!w) {
    $('#status').textContent = 'The reader is not running for this address yet. Open the project first.';
    return;
  }
  const channel = new MessageChannel();
  const late = setTimeout(() => { $('#status').textContent = 'The reader did not answer. Reset the viewer for this address below, then open the project again.'; }, 60_000);
  channel.port1.onmessage = (e) => { clearTimeout(late); show(e.data); };
  w.postMessage({ type: 'abxfs-info' }, [channel.port2]);
}

// Remove the reader and everything it stored for this address. The next visit starts from nothing.
async function reset() {
  const out = $('#reset-status');
  try {
    for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
    for (const name of await caches.keys()) if (name.startsWith('abxfs-view-')) await caches.delete(name);
    sessionStorage.clear();
    out.textContent = 'Reset. Opening the project again…';
    location.href = '/';
  } catch (e) {
    out.textContent = `Could not reset: ${e.message}`;
  }
}

$('#reset').addEventListener('click', reset);
$('#endpoint-save').addEventListener('click', () => setEndpoint($('#endpoint-url').value.trim()));
$('#endpoint-clear').addEventListener('click', () => setEndpoint(null));

ask();
