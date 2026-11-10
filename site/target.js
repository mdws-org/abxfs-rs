// What a viewer hostname names, and the viewer address for a project or a root.
//
// The viewer gives every project and every root its own hostname, so each one is its own web origin:
//   <chain id>-<org address, 40 hex>-<token id>   a project; the viewer shows its current version
//   r<chain id>-<root, 52 base32 characters>      one root, which never changes
// Only the first DNS label is read.

// Where the viewer is hosted: every subdomain of this name serves it. An empty value hides the "Open from
// chain" links. On localhost the links point at the local viewer (tools/view-serve.py).
const VIEW_BASE = 'fromchain.dynv6.net';
const LOCAL_VIEW = 'localhost:8853';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

// 32 bytes as 0x-hex -> 52 lowercase base32 characters (RFC 4648, no padding).
function rootToBase32(root) {
  let bits = BigInt(root) << 4n; // 256 bits padded to 260 = 52 * 5
  let out = '';
  for (let i = 0; i < 52; i++) { out = B32[Number(bits & 31n)] + out; bits >>= 5n; }
  return out;
}

function base32ToRoot(s) {
  let bits = 0n;
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    bits = (bits << 5n) | BigInt(v);
  }
  if (s.length !== 52 || (bits & 15n) !== 0n) return null; // the 4 padding bits are zero in the one valid spelling
  return '0x' + (bits >> 4n).toString(16).padStart(64, '0');
}

function parseHost(hostname) {
  const label = hostname.split('.')[0];
  if (label.length > 63) return null; // longer than a DNS label, so it can never be reached
  let m = /^([1-9]\d{0,9})-([0-9a-f]{40})-(0|[1-9]\d{0,19})$/.exec(label);
  if (m) return { kind: 'project', chainId: Number(m[1]), org: '0x' + m[2], token: m[3], label };
  m = /^r([1-9]\d{0,9})-([a-z2-7]{52})$/.exec(label);
  const root = m && base32ToRoot(m[2]);
  return root ? { kind: 'root', chainId: Number(m[1]), root, label } : null;
}

function hostLabel(t) {
  return t.kind === 'project' ? `${t.chainId}-${t.org.slice(2).toLowerCase()}-${t.token}` : `r${t.chainId}-${rootToBase32(t.root)}`;
}

// The viewer address for a target, or null where no viewer is configured.
function viewUrl(t, here = globalThis.location) {
  const local = here && /^(localhost|127\.0\.0\.1|.*\.localhost)$/.test(here.hostname);
  if (local) return `http://${hostLabel(t)}.${LOCAL_VIEW}/`;
  return VIEW_BASE ? `https://${hostLabel(t)}.${VIEW_BASE}/` : null;
}

// The same project on ABX FS's own gateway, which names hosts the same way. A bare root has no address there.
const gatewayUrl = (t) => (t && t.kind === 'project' ? `https://${hostLabel(t)}.abxfs.app/` : null);

export { base32ToRoot, gatewayUrl, hostLabel, parseHost, rootToBase32, viewUrl };
