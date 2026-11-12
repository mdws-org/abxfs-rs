// The rule for a project's current root (view/sw.js askHead), run against made-up endpoints: at least two must
// answer, all that answer must agree, and every endpoint is asked at the lowest block any of them reports.
// usage: tools/build-view.py && node tests/head-rule.mjs
const ORG = 'ab025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6';
globalThis.self = { location: { hostname: `8453-${ORG}-0.localhost`, origin: 'http://x' }, addEventListener() {}, clients: {} };
const { askHead } = await import('../view-dist/_abxfs/sw.js');
const { CHAINS } = await import('../view-dist/_abxfs/chain.js');
const [A, B, C] = CHAINS.base.rpcs;
const GOOD = '0x' + '11'.repeat(32), EVIL = '0x' + '22'.repeat(32);
const OLD = '0x' + '33'.repeat(32);
const AT = (block) => (block >= 5000 ? GOOD : OLD);

// behave: url -> { block, root } | 'down'. A root may be a function of the block it is read at.
function endpoints(behave, asked) {
  globalThis.fetch = async (url, init) => {
    const b = behave[url];
    const { method, params } = JSON.parse(init.body);
    if (b === 'down') throw new TypeError('connection refused');
    const reply = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    if (method === 'eth_chainId') return reply('0x2105');
    if (method === 'eth_blockNumber') return reply('0x' + b.block.toString(16));
    if (b.root === 'revert') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }));
    asked.push(parseInt(params[1], 16));
    const root = typeof b.root === 'function' ? b.root(parseInt(params[1], 16)) : b.root;
    return reply(root + '00'.repeat(64));
  };
}

const cases = [
  ['three agree', { [A]: { block: 100, root: GOOD }, [B]: { block: 100, root: GOOD }, [C]: { block: 100, root: GOOD } }, GOOD],
  ['one down, two agree', { [A]: 'down', [B]: { block: 100, root: GOOD }, [C]: { block: 100, root: GOOD } }, GOOD],
  ['two down', { [A]: 'down', [B]: 'down', [C]: { block: 100, root: GOOD } }, 'rpc'],
  ['one liar of three', { [A]: { block: 100, root: EVIL }, [B]: { block: 100, root: GOOD }, [C]: { block: 100, root: GOOD } }, 'check'],
  ['a liar and one honest', { [A]: { block: 100, root: EVIL }, [B]: 'down', [C]: { block: 100, root: GOOD } }, 'check'],
  ['only a liar answers', { [A]: { block: 100, root: EVIL }, [B]: 'down', [C]: 'down' }, 'rpc'],
  ['asked at the lowest block', { [A]: { block: 120, root: GOOD }, [B]: { block: 95, root: GOOD }, [C]: { block: 110, root: GOOD } }, GOOD, 95],
  // The project was republished at block 5,000: before it the root was OLD. An endpoint that reports an old
  // block must not pull the read back to before the publish.
  ['a liar reports an old block', { [A]: { block: 1000, root: AT }, [B]: { block: 10000, root: AT }, [C]: { block: 10001, root: AT } }, GOOD, 10000],
  ['a liar reports a future block', { [A]: { block: 999999, root: AT }, [B]: { block: 10000, root: AT }, [C]: { block: 10001, root: AT } }, GOOD, 10000],
  // A contract with no token parameters reverts: that is an answer, the zero root, not an endpoint failing.
  ['all three revert', { [A]: { block: 100, root: 'revert' }, [B]: { block: 100, root: 'revert' }, [C]: { block: 100, root: 'revert' } }, '0x' + '00'.repeat(32)],
  ['one reverts, two give a root', { [A]: { block: 100, root: 'revert' }, [B]: { block: 100, root: GOOD }, [C]: { block: 100, root: GOOD } }, 'check'],
  ['two endpoints far apart', { [A]: { block: 1000, root: AT }, [B]: { block: 10000, root: AT }, [C]: 'down' }, 'rpc'],
];
let bad = 0;
for (const [name, behave, want, block] of cases) {
  const asked = [];
  endpoints(behave, asked);
  let got;
  try { got = (await askHead()).root; } catch (e) { got = e.kind || String(e); }
  const ok = got === want && (block === undefined || (asked.length > 0 && asked.every((b) => b === block)));
  bad += !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${block === undefined ? '' : `, asked at ${[...new Set(asked)]}`}`);
}
process.exit(bad ? 1 : 0);
