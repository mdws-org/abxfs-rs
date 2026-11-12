// The WebAssembly build must reproduce the reference outputs exactly, like the native build.
// usage: node tests/wasm-golden.mjs   (from any directory; paths are taken from this file's place in the repository)
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
const R = join(new URL('.', import.meta.url).pathname, '..').replace(/\/$/, '');
const { initSync, plan_files_json } = await import(`${R}/site/pkg/abxfs.js`);
initSync({ module: readFileSync(`${R}/site/pkg/abxfs_bg.wasm`) });

// Every regular file under root, as a browser folder picker would hand them over (no symlinks, no empty dirs).
function walk(root, rel = '', out = []) {
  for (const name of readdirSync(join(root, rel))) {
    const p = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(root, p));
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(root, p, out);
    else if (st.isFile()) out.push(p);
  }
  return out;
}

function firstDiff(a, b, path = '$') {
  if (typeof a !== typeof b) return `${path}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`;
  if (a && typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) { const d = firstDiff(a[k], b[k], `${path}.${k}`); if (d) return d; }
    return null;
  }
  return a === b ? null : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

let bad = 0;
for (const set of ['abx-site', 'find3r', 'edge']) {
  for (const fastlz of [true, false]) {
    const root = `${R}/oracle/corpus-${set}`;
    const paths = walk(root);
    const bufs = paths.map((p) => readFileSync(join(root, p)));
    const data = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const b of bufs) { data.set(b, at); at += b.length; }
    const t0 = performance.now();
    const got = JSON.parse(plan_files_json(paths, Float64Array.from(bufs.map((b) => b.length)), data, fastlz, false, []));
    const ms = performance.now() - t0;
    const want = JSON.parse(readFileSync(`${R}/oracle/golden/${set}${fastlz ? '' : '.nofastlz'}.json`, 'utf8'));
    delete got.generator; delete want.generator;
    const d = firstDiff(got, want);
    bad += !!d;
    console.log(d ? 'FAIL' : 'ok  ', `${set}${fastlz ? '' : ' (no fastlz)'}`.padEnd(22), `${ms.toFixed(0)} ms`, d || got.rootCid);
  }
}
// Empty directories, as a dropped folder reports them: the root must equal the official CLI's dry run, which plans
// `empty`, `nested/empty2` and `hiddenonly` (its only file is hidden) as empty and skips `node_modules`.
{
  const root = `${R}/oracle/corpus-emptydirs`;
  const dirs = [];
  (function dirsUnder(rel) {
    for (const name of readdirSync(join(root, rel))) {
      const p = rel ? `${rel}/${name}` : name;
      if (lstatSync(join(root, p)).isDirectory()) { dirs.push(p); dirsUnder(p); }
    }
  })('');
  const paths = walk(root);
  const bufs = paths.map((p) => readFileSync(join(root, p)));
  const data = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of bufs) { data.set(b, at); at += b.length; }
  const official = '0x3b4266f6d6abf6de86d50f1013b27f84aecb1a7ab585a1b07441f56d8946277d';
  const got = JSON.parse(plan_files_json(paths, Float64Array.from(bufs.map((b) => b.length)), data, true, false, dirs)).rootCid;
  const ok = got === official;
  bad += !ok;
  console.log(ok ? 'ok  ' : 'FAIL', 'empty dirs (official)', got);
}
process.exit(bad ? 1 : 0);
