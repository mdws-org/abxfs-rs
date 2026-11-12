// site/base.js baseTokenParam against recorded Base replies (tests/fixtures/base-param.json), offline: as recorded
// it must give the recorded root; with any string in any reply changed by one digit it must refuse or give the
// same root, never another; and against a claim that differs it must refuse.
// usage: node tests/base-replay.mjs [path to base.js]
import { readFile } from 'node:fs/promises';
const { baseTokenParam } = await import(process.argv[2] || '../site/base.js');
const fx = JSON.parse(await readFile(new URL('./fixtures/base-param.json', import.meta.url), 'utf8'));
const serve = (replies) => { globalThis.fetch = async (url, init) => (init.body in replies ? new Response(replies[init.body]) : new Response('{"error":{"message":"not recorded"}}')); };
const run = (claim = fx.claim) => baseTokenParam({ claim, urls: [fx.url], org: fx.org, token: '0' });
let bad = 0, done = 0;
const check = (ok, text) => { done++; if (!ok) { bad++; console.log('FAIL ' + text); } };
const outcome = async (claim) => { try { const g = await run(claim); return g.known ? g.root : 'unknown: ' + g.why; } catch (e) { return e.constructor.name === 'ProvedError' || e.kind === 'check' ? 'refused' : `crash: ${e.message}`; } };

serve(fx.replies);
check(await outcome() === fx.expect.root, 'as recorded: not the recorded root');
// A contract that is not an ABX collection is reported as unknown, not read.
{ let got; try { got = await baseTokenParam({ claim: fx.claim, urls: [fx.url], org: fx.other, token: '0' }); } catch (e) { got = { error: e.message }; }
  check(got.known === false && /not an ABX collection/.test(got.why || ''), `a contract that is not a collection: ${JSON.stringify(got).slice(0, 120)}`); }
// Each claim field changed.
check(await outcome({ ...fx.claim, rootClaim: fx.claim.rootClaim.slice(0, 20) + (fx.claim.rootClaim[20] === '0' ? '1' : '0') + fx.claim.rootClaim.slice(21) }) === 'refused', 'another claimed output root was accepted');
check(await outcome({ ...fx.claim, l2Block: fx.claim.l2Block + 1 }) === 'refused', 'another L2 block was accepted');
// One digit changed in each hex string of each reply, at a spread of positions.
for (const [body, text] of Object.entries(fx.replies)) {
  const strings = [...text.matchAll(/"(0x[0-9a-f]{2,})"/g)];
  for (const m of strings) for (const k of [0, 1, 2]) {
    const at = m.index + 3 + Math.floor(((m[1].length - 3) * k) / 2);
    const alt = text.slice(0, at) + (text[at] === 'f' ? '0' : 'f') + text.slice(at + 1);
    if (alt === text) continue;
    serve({ ...fx.replies, [body]: alt });
    const got = await outcome();
    check(got === 'refused' || got === fx.expect.root, `a reply to ${JSON.parse(body).method} changed at ${at} gave ${got}`);
  }
}
// Code an endpoint gives is believed only when it hashes to the proved code hash (site/proved.js provedCode).
{
  const { provedCode } = await import('../site/proved.js');
  const { keccak256 } = await import('../site/keccak-lookup.js');
  const code = '0x6001600155', other = '0x6001600255';
  const h = '0x' + Array.from(keccak256(Uint8Array.of(0x60, 1, 0x60, 1, 0x55)), (b) => b.toString(16).padStart(2, '0')).join('');
  const give = (result) => { globalThis.fetch = async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result })); };
  const ask = async () => { try { return await provedCode({ urls: ['https://one.example'], address: '0x' + '11'.repeat(20), codeHash: h, blockNumber: 5 }); } catch (e) { return e.kind === 'check' ? 'refused' : `crash: ${e.message}`; } };
  give(code); check(await ask() === code, 'code that hashes to the proved code hash was refused');
  give(other); check(await ask() === 'refused', 'code that does not hash to the proved code hash was accepted');
  give('0x' + '00'.repeat(24577)); check(await ask() === 'refused', 'code larger than any contract was accepted');
  give(null); check(await ask() !== code, 'no code was accepted');
}
console.log(bad ? `${bad} of ${done} FAILED` : `ok: ${done} checks`);
process.exit(bad ? 1 : 0);
