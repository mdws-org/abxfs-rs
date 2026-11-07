// Build the edge-case corpus for the ABX FS reference outputs. Deterministic (seeded PRNG).
// usage: node make-corpus.mjs <out dir>
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
if (!out || existsSync(out)) { console.error('give a new output dir'); process.exit(1); }

let s = 0x9e3779b9;
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
const randomBytes = (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = rnd() & 0xff; return b; };
const text = (n) => { const words = ['alpha', 'beta', 'gamma', 'delta', 'onchain', 'file', 'store', '\n']; let t = ''; while (t.length < n) t += words[rnd() % words.length] + ' '; return t.slice(0, n); };
const put = (p, data) => { const f = join(out, p); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, data); };

put('edge/empty.txt', '');
put('edge/one.bin', new Uint8Array([0x42]));
for (const n of [24574, 24575, 24576, 49151, 262143, 262144, 262145]) put(`edge/rand-${n}.bin`, randomBytes(n));
put('edge/zeros-3MiB.bin', new Uint8Array(3 * 1024 * 1024));
put('edge/text-700KiB.txt', text(700 * 1024));
put('edge/rand-1MiB.bin', randomBytes(1024 * 1024));
put('edge/dup-a.txt', 'same bytes in two files\n');
put('edge/dup-b.txt', 'same bytes in two files\n');
put('names/café.txt', 'unicode name\n');
put('names/日本語.md', '# unicode\n');
put('names/space name.html', '<p>space</p>\n');
put('names/UPPER.JSON', '{"a":1}\n');
put('names/no-extension', 'plain\n');
put('names/a.b.c.d.css', 'a{}\n');
put('deep/a/b/c/d/e/f/g/h/leaf.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
for (let i = 0; i < 2000; i++) put(`many/f${String(i).padStart(4, '0')}.txt`, `file ${i}\n`);
put('.well-known/security.txt', 'Contact: mailto:security@example.com\n');
console.log('corpus written to', out);
