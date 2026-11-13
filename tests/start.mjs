// site/start.js and site/published.js: which starting block a proof rests on, and what a copy of the check page
// says about itself against the build published on chain.
// usage: node tests/start.mjs [path to start.js] [path to published.js]
const S = await import(process.argv[2] || '../site/start.js');
const P = await import(process.argv[3] || '../site/published.js');
const BUILT = { 1: { root: '0x' + 'aa'.repeat(32), slot: 100, date: '2026-11-12' } };
const MINE = '0x' + 'bb'.repeat(32);
let bad = 0;
const check = (ok, name, got) => { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ': ' + JSON.stringify(got)}`); };
const start = (own, chain = 1) => S.startingBlock(chain, own, BUILT);
// [name, what the reader gave, chain, check]
for (const [name, own, chain, ok] of [
  ['nothing given: the built-in block', null, 1, (r) => r.root === BUILT[1].root && r.own === false && r.slot === 100],
  ['a root given: the reader\'s block', MINE, 1, (r) => r.root === MINE && r.own === true && r.built.root === BUILT[1].root],
  ['a root in capitals with spaces around it', `  ${MINE.toUpperCase().replace('0X', '0x')}\n`, 1, (r) => r.root === MINE && r.own === true],
  ['the built-in root given back', BUILT[1].root, 1, (r) => r.own === false],
  ['a root one digit short', MINE.slice(0, -1), 1, (r) => r.own === false && r.root === BUILT[1].root],
  ['a root one digit long', MINE + '0', 1, (r) => r.own === false],
  ['a root with no 0x', MINE.slice(2), 1, (r) => r.own === false],
  ['a root with words before it', 'root: ' + MINE, 1, (r) => r.own === false],
  ['a root with a letter that is not hex', MINE.slice(0, -1) + 'g', 1, (r) => r.own === false],
  ['an empty string', '', 1, (r) => r.own === false],
  ['a number', 7, 1, (r) => r.own === false],
  ['an object', { root: MINE }, 1, (r) => r.own === false],
  ['a root for a chain with no light client', MINE, 8453, (r) => r === null],
  ['nothing for a chain with no light client', null, 8453, (r) => r === null],
]) { const r = start(own, chain); check(ok(r), `starting block: ${name}`, r); }
const count = (n) => String(n);
check(S.startingText(start(null), count) === 'slot 100, 2026-11-12', 'the built-in block is named by its slot and date', S.startingText(start(null), count));
check(S.startingText(start(null), count, 'Ethereum') === 'Ethereum slot 100, 2026-11-12', 'with the chain named');
const text = S.startingText(start(MINE), count);
check(text.startsWith('yours, ' + MINE) && text.includes('slot 100, 2026-11-12'), 'a reader\'s block is said to be theirs, with the built-in one beside it', text);

// A reader's block must be shown to be final: the light client falling back to its starting block is not enough.
const builtIn = start(null), readers = start(MINE);
check(S.unusable(builtIn, { shipped: true }) === null, 'the built-in block may stand as the newest finalized block');
check(S.unusable(builtIn, { shipped: false }) === null, 'the built-in block with a newer finalized block');
check(S.unusable(readers, { shipped: false }) === null, 'a reader\'s block with a newer finalized block reached from it');
check(/nothing here shows that your block is final/.test(S.unusable(readers, { shipped: true }) || ''), 'a reader\'s block with no newer finalized block proves nothing', S.unusable(readers, { shipped: true }));

// The build published on chain.
const A = 'a1'.repeat(32), B = 'b2'.repeat(32);
const TXT = (build, sha) => `build ${build}\nsha256 ${sha}  abxfs-check.html\n`;
const file = (s) => async (path) => { if (path !== 'build.txt') throw new Error('asked for ' + path); return new TextEncoder().encode(s); };
const read = async (s) => { try { const r = await P.publishedBuild(file(s)); return `${r.build} ${r.sha256}`; } catch (e) { return 'refused: ' + e.message; } };
check(await read(TXT(A, B)) === `${A} ${B}`, 'build.txt with a build hash and a file hash is read');
check(await read(TXT(A, B).trimEnd()) === `${A} ${B}`, 'build.txt with no last line end is read');
for (const [name, s] of [['one hash alone', A + '\n'], ['the two lines the other way round', `sha256 ${B}  abxfs-check.html\nbuild ${A}\n`], ['a short build hash', TXT(A.slice(2), B)], ['a short file hash', TXT(A, B.slice(2))], ['capitals', TXT(A.toUpperCase(), B)], ['nothing', ''],
  ['another file named', TXT(A, B).replace('abxfs-check.html', 'other.html')], ['a third line', TXT(A, B) + 'more\n'], ['words before', 'x' + TXT(A, B)]]) check((await read(s)).startsWith('refused'), `build.txt with ${name} is refused`, await read(s));
check((await (async () => { try { return await P.publishedBuild(async () => { throw new Error('not in this project'); }); } catch (e) { return 'refused: ' + e.message; } })()).includes('not in this project'), 'a missing build.txt is refused with the reason');
for (const [name, mine, published, why, want, says] of [
  ['the same build', A, A, '', 'same', /is the build in the published project/],
  ['another build', A, B, '', 'different', new RegExp('is not the build in the published project.*' + B)],
  ['the published build could not be read', A, null, 'the endpoints were down', 'unknown', /could not be read.*endpoints were down/],
  ['what is published is not a hash', A, 'hello', '', 'unknown', /not a build hash/],
  ['what is published is a hash with more after it', A, A + 'ff', '', 'unknown', /not a build hash/],
  ['this copy has no build hash', '', A, '', 'unknown', /does not know its own build/],
  ['this copy has no build hash and the published one is the same empty value', '', '', '', 'unknown', /does not know/],
]) { const r = P.compareBuild(mine, published, why); check(r.state === want && says.test(r.text), `comparison: ${name}`, r); }
console.log(bad ? `${bad} FAILED` : 'ok: every starting-block and published-build case');
process.exit(bad ? 1 : 0);
