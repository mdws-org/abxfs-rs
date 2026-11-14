// What one host has chosen not to show. A host lists hostname labels (a project's, a token's or a root's, as the
// viewer's addresses name them) under "refuse" in its switch.json, the one file a host may change. The choice is
// that host's alone: the project stays on chain, and every other host, the reader on a person's own machine and
// the archive show it as before. The viewer says that it is the host's choice and names those other ways.

const MAX_LIST = 10_000;

// The labels a host's setting refuses, lowercased. Anything that is not a list of strings refuses nothing: a
// broken setting must not take a host's projects away.
function refusedLabels(setting) {
  const list = setting && typeof setting === 'object' && Array.isArray(setting.refuse) ? setting.refuse : [];
  if (list.length > MAX_LIST) return new Set();
  const out = new Set();
  for (const x of list) if (typeof x === 'string') out.add(x.trim().toLowerCase());
  return out;
}

// Whether the host refuses the page this hostname names. The label is the hostname's first part.
function refuses(setting, hostname) {
  const label = String(hostname || '').split('.')[0].toLowerCase();
  return label !== '' && refusedLabels(setting).has(label);
}

export { refusedLabels, refuses };
