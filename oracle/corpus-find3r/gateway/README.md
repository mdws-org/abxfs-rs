# A small gateway for one BAMFS website

The generated package contains a self-contained Cloudflare Worker, publication settings and a launcher. It does not contain the website's HTML, JavaScript, CSS or images. On a cache miss, the Worker reconstructs and verifies the requested file through EVM JSON-RPC. It serves one app from a supported BAMFS deployment, either following the latest published version or keeping a fixed version.

## Few-step setup

1. In Find3r, select a BAMFS app and click **Put an app online**. Or open `gateway.html` and paste its web3 or BAMFS /g/p/ link. Choose **Follow updates automatically** (default) or **Keep the version in my link**, then prepare the gateway.
2. Click **Copy gateway code**. In Cloudflare Workers & Pages, create a Worker using Hello World, deploy it, then open **Edit code**. Replace the sample module with the copied code and deploy again. No website files are uploaded to Cloudflare.
3. Under Worker Settings → Variables and Secrets, add the complete RPC endpoint for the app’s chain as a **Secret** named `RPC_URL`. A bundled public endpoint is available for an initial test; your own endpoint is recommended for operating the gateway.
4. Open the workers.dev address. Optionally attach your domain under Settings → Domains & Routes → Add → Custom Domain. The domain needs an active Cloudflare DNS zone.

Advanced: download the optional ZIP, unzip, and run `node deploy.mjs` with Node 22+. The launcher uses `npx --yes wrangler@4 deploy` and its configuration requests Workers Paid. It may ask you to sign in and select an account. This creates or updates the named Worker, so review an existing name before updating it.

This is a one-click preparation tool, not yet a one-click account deployment service. Running the launcher actually deploys. Generating/downloading never does. No Git repository, website asset upload, database or persistent storage binding is required by this package.

Cloudflare also offers a Deploy to Cloudflare button based on a public GitHub/GitLab template. That button clones a repository and still needs account authorization. This prototype does not invent a button URL or claim to implement Cloudflare OAuth.

- Dashboard/account documentation: https://developers.cloudflare.com/workers/get-started/dashboard/
- Git-template deployment buttons: https://developers.cloudflare.com/workers/platform/deploy-buttons/
- CLI deployment: https://developers.cloudflare.com/workers/wrangler/commands/#deploy
- Domains: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/

## The same reader for every app

For an existing Worker with its own code editor, replace its module with generated `worker.js` and deploy. The complete reader is bundled; do not paste an import of Find3r code from a remote HTTP URL. Choose one Worker/domain per website so unrelated published apps do not share browser storage. Use the supplied module, not the unconfigured `worker-template.js`.

## Your RPC

Initially the gateway uses the deployment's public endpoint. To pay for its chain reads or replace the endpoint, add a Worker binding named **RPC_URL**, type **Secret**, under Settings → Variables and Secrets. When a matching `RPC_URL_CHAIN_ID` is also configured, that endpoint takes precedence for loading the website. This lets Find3r move its publication between chains while retaining its browsing connections. Do not put an API-key URL into worker.js, wrangler.json, publication.json, chat or a public repository. No browser response contains this binding, including failures.

The launcher optionally accepts `BAMFS_GATEWAY_RPC` through its process environment. It writes a temporary permissions-0600 secrets file, passes only the file path to Wrangler's `--secrets-file`, removes the environment variable before launching Wrangler and deletes the temporary file afterward. Prefer the dashboard if you do not already have a private environment setup; do not paste keys into shell history.

By default, this gateway sponsors **retrieval of the published website files only**. Arbitrary apps keep their own runtime connections. It never signs or sends transactions.

For Find3r’s sponsored browsing, explicitly enable `SPONSORED_HOSTS` with a comma-separated list of dedicated hosts (for example `find3r.app,www.find3r.app`). Then configure full HTTPS RPC URLs as secrets:

| Binding | Purpose |
| --- | --- |
| `RPC_URL` | Website retrieval fallback when no matching chain-specific endpoint exists. Also the Base browsing fallback; keep this pointed at Base for Find3r, or set `RPC_URL_8453` explicitly. |
| `RPC_URL_1` | Ethereum browsing and ENS. |
| `RPC_URL_8453` | Base browsing; optional when `RPC_URL` already points to Base. |
| `RPC_URL_42161` | Arbitrum One browsing (chain ID 42161). |
| `RPC_URL_84532` | Base Sepolia browsing and website retrieval when the app is published there. |

To add Arbitrum on Find3r: open the existing Worker → Settings → Variables and Secrets → Add → Secret. Name it `RPC_URL_42161` and paste the full Arbitrum One HTTPS RPC URL from your provider (not just the API key). For Alchemy the URL is `https://arb-mainnet.g.alchemy.com/v2/YOUR_API_KEY`; enable Arbitrum for that key in your Alchemy app and copy its endpoint. See [Alchemy’s Arbitrum quickstart](https://www.alchemy.com/docs/reference/arbitrum-api-quickstart). Save/deploy the change and replace the Worker code with the rebuilt `build/find3r-gateway/worker-sponsored.js`. Keep `RPC_URL` pointing at Base to load Find3r itself. Visitors need no settings on find3r.app. Independent copies can use the bundled public endpoint `https://arb1.arbitrum.io/rpc` or enter their own in Settings → Connection settings → Arbitrum.

The browser automatically uses the same-origin `/rpc/CHAIN_ID` endpoint only on HTTPS find3r.app or www.find3r.app, unless the visitor supplies an override. Other copies use public defaults for Ethereum, Base, Arbitrum and Base Sepolia; users can add their own RPC in Settings. Embedded copies keep their settings only for the current visit. Shared BAMFS gateway origins cannot store private RPC settings; recover the app to a dedicated origin or localhost first.

The relay accepts a single bounded JSON-RPC request, and a bounded read-only method list: chain ID, block number, gas prices, contract calls, code, balance, transaction count, storage, block headers, transaction/receipt lookup, and address-scoped logs over at most 2,000 blocks. Contract reverts retain a sanitized code-3 reply for optional interface probing. Confirmed provider computation-limit signals retain sanitized code -32050, also through the app bridge. Calls cannot set from/value. Gas defaults to 5 million. Exact standard metadata calls can request up to 30 million for any collection: tokenURI(uint256) 0xc87b56dd or uri(uint256) 0x0e89341c with exactly one uint256, or argument-free contractURI() 0xe8a3d485. No trailing calldata is accepted. The browser retries metadata once at the same block after a revert/explicit computation failure; ordinary transport failures do not trigger it. A requested budget up to 20 million is separately allowed only on Ethereum for the exact craftToPayload(uint256) selector 0x563dc14b, exactly one argument in 1–10,000, at Vessel 0xecb92cc7112b80a2234936315bbb493fb48d1463 or Hyperportal 0x11929178e085ae64f2bd58168f8cd7b6d7fb7e34. Other calls remain capped at 5 million. Provider gas/time limits can still be lower. Overrides and pending blocks are rejected, upstream responses are capped and sanitized, and cross-origin browser requests are rejected. No CORS access is granted. A per-isolate 600-request/minute IP limit and four-read concurrency bound reduce accidental load; these are not global spending guarantees. Optional `RPC_LIMITER` can bind Cloudflare’s rate limiter. Heavy metadata retries use additional provider computation. Keep provider account limits for the spending budget. Origin checks are browser controls, not authentication against scripted clients.

Hosted Art Blocks and ABX discovery/preview APIs are separate from RPC. Their current browsing requests do not become blockchain reads simply because the RPC is sponsored. Compatible apps opened in Find3r can request bounded reads through its sandbox bridge when Settings → Let apps use my browsing connection is enabled. The parent performs these reads; endpoint secrets never enter the app. Apps with hard-coded RPC URLs retain those connections. The Worker does not inject this bridge into standalone publisher apps or pass through a wallet.

Secrets: https://developers.cloudflare.com/workers/configuration/secrets/

## What happens on each request

The generated Worker supports both the original BAMFS shared collections and
the documented immutable org factory/content-v2 generation in `orgs.json`.
An org address is authenticated against its chain's factory before content is
served. New project-page links (`/projects/CHAIN/ORG/TOKEN`), project hosts on
`bamfs.app`, and canonical `web3://ORG:CHAIN/TOKEN/latest/` links work. The reader
verifies v2 node blobs and original bytes; it never fetches content from BAMFS.
Earlier factory generations require their original documented reader records.

- Website paths accept GET and HEAD. The separately enabled /rpc/CHAIN_ID endpoint accepts read-only POST requests. Paths resolve inside the selected publication’s file tree. `/` selects index.html, falling back to index.htm; directory URLs select their own index. Root-file publications are served as `/` or `/index.html`.
- On a cache miss, pin the RPC chain/block, read the original hook's versionAt record and match the configured root. Verify directory, file, chunk and decompressed-output commitments using the same independently documented reader as Find3r.
- The Worker transport omits browser-only `credentials` and uses `redirect: 'manual'`. Workers rejects the browser reader's `redirect: 'error'` in the tested runtime. Redirect responses are rejected by the reader's HTTP status check; RPC credentials are never forwarded to a redirect target. Failure responses report only a fixed stage/method label or HTTP status, never provider error text or the endpoint.
- Return original bytes and MIME metadata, without rewriting HTML or injecting an application shell. Relative and root-relative assets work as ordinary paths on the dedicated origin. Query strings are passed in the address bar but do not alter file identity. Client-side route fallback is not assumed: a missing file returns 404.
- Cache keys include chain, collection, token, fixed version, root and path. Cache writes are best effort. HTTP clients revalidate files with content CIDs as ETags; latest-mode updates revalidate rather than leaving year-long browser caches of old app.js at the same path. Worker Cache API data is disposable and data-center local.
- Two reconstructions run per isolate at a time, with a bounded queue. Binary assets and existing none/FastLZ compression work. The same reader limits apply (16 MiB/file, 512 directory entries, depth 16, 1024 chunks/file). Cold reads of large files can be slow and cost RPC calls.
- `/.well-known/bamfs-gateway.json` publishes the canonical locator, root and original store addresses. It contains no RPC URL. This reserved path identifies the gateway, not an arbitrary publisher file.

No BAMFS/ABX HTTP gateway or private metadata index is used for package retrieval. RPC is trusted for chain state; file commitments are verified against the pinned publication. Cached bytes can remain available if RPC later fails; a cold request still needs RPC. Content identity survives the gateway disappearing.

## Updating or migrating

To move **find3r.app** to an org publication on **Base Sepolia**, update the same
existing Worker; its domain stays attached. Paste the newly generated org-capable
Worker code in Edit code and deploy. Under Settings → Variables and Secrets,
set `SITE_URL` (Text) to the new app's canonical `web3://ORG:84532/TOKEN/latest/`
address, or its unversioned `https://84532-ORG_WITHOUT_0X-TOKEN.bamfs.app/` link.
Deploy the variable changes too. `SITE_URL` overrides the address embedded in
copied code, so update or remove an old override when switching apps.

Keep `RPC_URL_84532` set to your complete Base Sepolia endpoint; the updated
Worker uses it both for website retrieval and sponsored Sepolia browsing. Keep
the existing Base `RPC_URL` (or explicit `RPC_URL_8453`), `RPC_URL_1`,
`RPC_URL_42161`, and `SPONSORED_HOSTS=find3r.app,www.find3r.app`. Do not replace
a Base mainnet endpoint with Sepolia while it is still the Base browsing fallback.
No ROOT_CID setting is needed for latest. Check
`https://find3r.app/.well-known/bamfs-gateway.json` after deployment: its chain,
collection and token should match the new app. The Worker extracts org identity
from BAMFS links locally; it does not request that link's gateway for content.

For **Follow updates**, `SITE_URL` ends in `/latest/` and no ROOT_CID is required. The Worker reads the original history hook’s `latestVersion` and `versionAt` through RPC. A document reload selects the newest published version of the same token; cache keys include its version and root. Existing cached files cannot mask a new publication. A version-only HttpOnly cookie keeps subsequent asset requests on the document-selected version. Cookies are shared across tabs: opening/reloading another version in another tab can affect later lazy asset reads in an older tab. Use fixed-version gateways when strict version stability is required.

For **Keep this version**, the bundled root and version are immutable pointers. Generate a new package or set both SITE_URL and ROOT_CID to a verified new publication to update it.

Publishing to a different token or collection does not update a previous token’s latest pointer. A contract migration requires changing the locator and may need an updated generation-specific reader. Merely changing a frontend toggle cannot prove that Find3r’s own delivered files are on-chain; retain its publication record and verify recovery independently.

The bundled deployment map identifies original generation-specific storage and history interfaces. A new BAMFS contract generation may need a new adapter; do not merely substitute a new collection address or silently repoint old store records. Unsupported publications fail in the generator before download. Retain publication.json and independently recover bytes with the guide at ../AGENTS.md (inside Find3r) or the original reader spec.

## Cost and deployment status

Workers Paid currently starts at $5/month plus metered usage; RPC and domains are separate. CPU/hash verification and the number of chain subrequests make the free tier unsuitable as a blanket promise for arbitrary packages. Set account budgets, provider limits and suitable request controls when operating a public gateway.

Pricing: https://developers.cloudflare.com/workers/platform/pricing/
Limits: https://developers.cloudflare.com/workers/platform/limits/
Cache: https://developers.cloudflare.com/workers/runtime-apis/cache/

This generated package has not been deployed or billed by Find3r. Local reader, HTTP/cache and generator checks are separate from a live Cloudflare deployment. The owner still authorizes and verifies the actual deployment in their account.


Find3r's public app routes use `/app/CHAIN/ORG/TOKEN/?options`, with `/v/N/` for fixed versions and `/app-full/...` for the frame-free view. The prepared Find3r Worker enables these paths and serves Find3r's hash-verified onchain `viewer.html`; the browser then reconstructs the chosen app over RPC. Publish the new Find3r files and paste the new Worker once. SITE_URL, ROOT_CID policy and RPC bindings stay unchanged. Generic publisher gateways remain exact-file readers. Another Find3r gateway can opt in with FIND3R_APP_ROUTES=1 or prepareWorker(...,{find3rRoutes:true}); the general gateway helper defaults to no routing override.

## Broader artwork discovery

The updated Find3r Worker adds read-only `GET /nfts/CHAIN` on explicitly sponsored hosts. When a matching RPC URL uses Alchemy’s exact network host and `/v2/KEY` path, the Worker derives its `/nft/v3/KEY/` NFT API base privately. Existing `RPC_URL_1`, `_8453` (or Base `RPC_URL`), `_42161`, and `_84532` values can therefore cover artwork discovery without extra keys, provided the key/account supports the NFT API on that network. RPC itself has no universal wallet inventory method.

If automatic derivation is unavailable, optionally configure `NFT_API_URL_CHAIN` (for example `NFT_API_URL_1`) as a Secret containing an Alchemy-compatible NFT API base URL. Example: `https://eth-mainnet.g.alchemy.com/nft/v3/YOUR_KEY/`. The only operations exposed are `getContractsForOwner`, `getNFTsForOwner`, `getNFTsForContract`, and identity-bound `getNFTMetadata`; identity inputs, cursors, response sizes, and rates are bounded. Provider keys and upstream errors are not returned. NFT API requests have their own provider cost, independent of RPC; use provider account budgets. Collection names/previews/ownership are index results, not proof of current chain state. Opening a token reads the collection directly. Spam filtering can omit items.

Self-hosted Find3r can enter this base URL in Settings → Find more artworks, or enter an Alchemy RPC URL whose matching NFT endpoint is derived locally. Without an index, familiar collections are checked through RPC and direct collection/token access remains available. Collection and token APIs must be compatible with Alchemy v3; this is not arbitrary index-provider discovery.

The small `/resolve-nft?url=...` helper resolves selected NFT data in a bounded page from allowlisted legacy marketplaces only. It refuses redirects and arbitrary hosts. Fixed Foundation and SuperRare links and KnownOrigin edition resolution do not need this hosted helper.

To release these features, publish the new `dist/` folder on BAMFS and replace the existing Worker module with the newly prepared `build/find3r-gateway/worker-sponsored.js`. Keep `SITE_URL`, RPC settings, domains, and `SPONSORED_HOSTS`. A latest pointer follows the new publication automatically; an old Worker module will not gain its new relay routes by changing the pointer alone.

The shared-format update also enables `mode=metadata&contract=ADDRESS&tokenId=ID` on `/nfts/CHAIN`. It reads a bounded getNFTMetadata response, validates identity and omits service/error fields. The detail page requests this only if original metadata fails after chain checks. The page labels saved metadata and its possible age; it is not onchain retrieval or an ownership substitute. Existing NFT_API_URL_CHAIN or matching Alchemy RPC configuration is reused. Update the Worker module when publishing this frontend; changing SITE_URL alone cannot add this route mode.
