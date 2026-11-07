# Find3r v0

Find3r is a static browser for supported BAMFS deployments. The reference client
reads chain state through replaceable JSON-RPC endpoints. Its byte reader uses
viem's ABI and Keccak primitives; it does not use BAMFS/ABX SDKs, content gateways,
NFT APIs or an indexer for BAMFS content. Art Blocks and ABX wallet discovery uses public hosted indexes and resolvers; direct NFT reads do not require those services. No ads, accounts, wallet integration, or application
backend are present.

## Navigation

Saved locations are device-local wallet/ENS folders, BAMFS drives, or Art Blocks/ABX collections with adapter, chainId and contract. BAMFS locations retain deployment IDs.
Each location retains an original `deploymentId` identifying chain, collection,
history, enumeration, and storage addresses in `config/deployments.json`.

The default Simple mode opens apps with one click, selecting the on-chain latest head and index.html/index.htm automatically. Root files open directly. Folders without a start page show files. Explorer mode retains wallet/collection → project token → positive fixed version → directories/files. New users have no saved/demo locations; preferences persist mode and addresses.
Wallet roots check supported holdings and display relevant Apps, Art Blocks, ABX, and Artworks folders, without duplicate category tabs. Failed checks remain retryable; successful empty checks hide the category. Breadcrumbs return to the wallet to choose another folder. Art Blocks shows exact-owner project folders across chains 1/42161/8453, including Engine; contract folders show projects first without an owner restriction. Name/artist search, counts, and token sorting happen in the index before offset pagination. Recently collected is last_transferred_at, newest minted is minted_at, newest projects is first_token_minted_at, with stable ID ties. Ownership changes can move records between pages. ABX groups owned items by registered collection and supports ERC-721 owners and positive ERC-1155 balances. Numeric token ordering is explicit. Library pages replace, rather than append, 40 items. BAMFS history retains Load more; Apps search/sort are limited to the current enumeration page. Failures are displayed rather than an empty verified inventory.

The Go field accepts an address, direct onchain ASCII .eth name, known collection,
or the BAMFS `web3://collection:chain/token/v/version/path` convention. The browser Go field resolves a bare
token or /latest/ link through the BAMFS hook latestVersion read and records a
fixed version before retrieval. The low-level recovery parser retains its legacy
abbreviated version-1 convention; descriptors and /v/N/ URLs are unambiguous. This convention is not a generic ERC-4804 implementation.
ENS is only a convenience; chain/collection/token/version remain the identity.

## Reader boundary

BAMFS org apps use `orgs.json`'s immutable factory and content-v2 generation on
the four selectable networks. On-chain holder indexes discover each wallet's
orgs; exact ownership counts and slices produce pages of at most 40 projects
inside the selected org. Wallet → Apps first shows current org folders; old shared collections are omitted from automatic wallet discovery but remain readable by direct original links. Administering an org is not ownership
of its projects. Discovery is capped at 200 owned orgs per chain with a visible
partial-inventory warning. Direct org addresses remain navigable beyond that cap.
Factory authentication precedes default ABX classification. The explicit ABX
metadata path remains separate and can show the same token's image/live link.
V2 node trees and legacy v1 lists use distinct CID verification, documented in
`site-v0.md`. New descriptors record their original orgFactory/contentVersion.

`core/catalog.js` exports an adapter registry. A BAMFS reader supplies common
item fields (`id`, `name`, `kind`, `type`, plus token/version/CID/path as needed).
ArtBlocksCatalog (core/artblocks.js) and AbxCatalog (core/abx.js) supply project/collection/artwork items. Art Blocks detection uses contracts_metadata; ABX wallet discovery uses the public registered collection list plus authenticated owned BAMFS orgs, whose owned token slices and metadata are read directly. Direct collection fallback uses contract code, ERC-165 and abxVersion; non-NFT contracts have their own view. Chain/address identity is checked. ABX caches projections for 60 seconds, scans up to four collections concurrently, and loads at most six token metadata responses concurrently for a page. Only whitelisted token identity/ownership fields leave projections; service configuration is never rendered or exported. Burned tokens/zero edition balances are excluded. Missing projections are reported; discovery is not universal enumeration.

Artwork clicks open artwork.html with chain/contract/token and optional adapter=abx. It shows static image/features/description and explicit full-screen/live choices. Metadata is inserted as text. ABX media permits safe image data URIs, HTTPS, and IPFS/Arweave gateway conversion; executable data-HTML and unsafe schemes are rejected. Live views open as external HTTPS tabs with no opener. Art Blocks uses GraphQL/media-proxy/generator endpoints; ABX uses its public resolver token API. Hosted indexes/previews are conveniences, not proof that content is entirely on-chain. Missing ABX animation_url disables live view. Artwork UI shows no BAMFS recovery or gateway actions. The agent guide documents ABX raw reads and CLI/SDK; the bundled recovery command supports only BAMFS and Ethereum Art Blocks.

Deployment migrations append new records. Preserve old IDs and addresses instead
of rewriting them to a new default. Recovery descriptors also embed original
stores so independently downloaded tools can read deployments absent from their
built-in map. Distinct history deployments on the same chain/collection require
an explicit descriptor; the abbreviated address does not distinguish them.

## Rendering and origin isolation

HTML opens in a new trusted viewer tab. Load as needed (default) verifies the
opened document and its HTML/CSS/module dependencies first; relative fetches and
later navigation retrieve additional paths from the same fixed root. Download
everything first verifies the full tree before rendering. Optional IndexedDB
caching preserves original proofs for up to one day within a 40 MiB budget and
rechecks commitments on hits. Each session has an unpredictable UUID and no RPC
URL or credential. The trusted viewer embeds verified assets as data URLs and
renders HTML in an iframe with sandbox:

`allow-scripts allow-forms allow-downloads`

Open full screen opens viewer.html?view=app with the same session UUID in another
tab. This fresh view hides the outer bar and fills the window. The original tab
stays open and sandbox permissions are identical. No Fullscreen API or keyboard
shortcut is required.

It never grants `allow-same-origin`, popups, top navigation, or wallet access.
Each rendered document has an opaque origin and cannot access parent storage.

Static ESM imports are adapted to a generated import map. CSS URLs, stylesheets,
images and fonts are embedded. A small page bootstrap supports relative/root
`fetch` reads and local link navigation through a parent message bridge. The
parent validates both message source and a per-render nonce, and serves only
verified bytes from this selected publication. It exposes no RPC API, arbitrary URL
fetch, other session lookup, preference access, or transaction functionality.

A prototype location/history facade supports common unqualified browser-global
uses in bundled modules and simple classic scripts. It is not a general JavaScript
compiler or a complete browser-origin implementation. Explicit window.location,
computed imports, import.meta URL resources, cross-script global dependencies,
XHR, workers, wallet injection, and persistent app storage are compatibility
limits. Downloads preserve original bytes; a separate localhost origin is the
compatibility route. External runtime dependencies remain external.

No service worker is required. Find3r can be served beneath a static directory
prefix or a BAMFS gateway prefix. It needs a normal HTTP(S)/localhost origin for
its own local storage and IndexedDB; directly opening a file:// copy is not the
recommended hosting path.

On known BAMFS hosts or BAMFS gateway paths, preferences are temporary and custom
RPC inputs are disabled. A shared gateway origin can run unrelated published
JavaScript, so private settings require a dedicated trusted host or localhost.
This policy covers known gateway shapes, not arbitrary multi-tenant host detection.

## Agent access

Public `AGENTS.md`, `llms.txt`, `deployments.json`, the exact read specification,
and a standalone `agent/recover.mjs` are included in every build. The recovery
tool bundles ABI, Keccak and decompression code; Node builtins perform output
writing and SHA-256 receipts. No npm installation is needed after downloading it.

The `find3r-recovery-v1` descriptor contains adapter, deployment ID, chain ID,
collection, optional wallet/token/fixed version/root/path, original stores,
canonical address, observed block, and relative documentation locations.
It never contains RPC transport credentials. A published-version descriptor
can recover its entire tree independently, irrespective of the selected subpath.

Normal recovery checks version binding and hashes at a pinned RPC block. The
explicit `--root-only` fallback reads a trusted descriptor root without a history
binding; its receipt records that distinction. This still relies on the recorded
storage interfaces. The current tool does not reconstruct directly from an
archived SSTORE2 pointer graph when those interfaces stop working.

RPC is trusted for chain state. Internal content consistency is verified, not
consensus. The original prerelease BAMFS administrative configuration has not
been audited by this client.

## Publishing Find3r

`npm run build` creates the complete `dist/` tree plus a file SHA-256 manifest in
`build/find3r-package.json`. Publish the complete tree using the existing BAMFS
workflow, record its collection/token/fixed version/root, recover it through RPC,
and compare with that build before claiming Find3r itself is onchain.

An earlier Find3r package was published as Base token 7, version 1; this updated build still requires publication and hash comparison. Sponsored read-only browsing is implemented in the optional Worker. Additional NFT adapters remain future work.

## Gateway preparation

`gateway.html` prepares copy-paste Worker code, plus an optional six-file ZIP. Supported links can follow latest or pin a version. The helper uses Find3r's configured connection, never requests a Cloudflare token, and excludes RPC settings from generated code. Creating a Worker, pasting the module and deploying happen in the owner's account. The optional launcher invokes Wrangler only when run. No automatic OAuth account deployment is implemented.

GET/HEAD resolve paths inside one publication, verify the hook record and content commitments, and use version/root/path cache keys and revalidated CID ETags. Latest mode reads latestVersion and versionAt through RPC at a pinned block and exposes the resolved fixed identity in the descriptor. A document-selected version cookie scopes asset reads; concurrent tabs can change it, so fixed mode is required for strict version stability. Contract/token migrations need a new pointer and potentially a new adapter.

Sponsored read-only POST /rpc/CHAIN_ID is opt-in via SPONSORED_HOSTS. RPC_URL_1, RPC_URL_8453 (or Base RPC_URL fallback), RPC_URL_42161 and RPC_URL_84532 stay in the Worker. The browser automatically uses the relay only on exact HTTPS find3r.app/www.find3r.app. Other copies use public defaults for Ethereum, Base, Arbitrum and Base Sepolia; explicit custom RPC settings override those defaults. An opaque embedded copy keeps preferences in memory and uses the viewer virtual history. Public defaults are conveniences, not canonical dependencies. Relay accepts the bounded read-only policy in core/rpc-policy.js, sanitizes replies, caps gas, and rejects transactions, batches, overrides and cross-origin browser requests. Per-isolate limits are not global spending guarantees; see gateway/README.md for provider budgets and optional RPC_LIMITER.


BAMFS app selection shows contextual Open independently and Put this app online actions. Recovery resolves a fixed version/root; gateway preparation inherits the selected token and explicit version, or follows latest for a project without a chosen version. These actions are hidden on wallet roots, collection lists without a selected app, and artwork views.

## Direct NFT collections and share links

NftCatalog (`core/nft.js`) supports direct ERC-721/1155 metadata on chains 1/8453/42161/84532 and recognizes ABX interfaces without directory registration. Labels are compatibility detection, not factory-authenticated provenance. Enumerable ERC-721 collections expose exact IDs; ABX Series core 1–3 has nextTokenId, with 40 issued IDs per page and burned items skipped. Single-live-token ABX collections can list token 0 when its owner exists. Arbitrary supply counts do not establish ID ranges. Unlisted collections expose exact token lookup instead. ERC-1155 URI IDs use 64 lowercase hex digits; optional supply reads distinguish known mint status. Data-JSON, HTTPS, IPFS and Arweave metadata are bounded; arbitrary HTML/data live views are rejected.

Public folder links use #collection=CHAIN:CONTRACT or #address=WALLET_OR_ENS; artwork links carry chain/contract/token and adapter. No local folder ID is required. Explicit contract holdings add view=holdings. OpenSea item/assets URLs are parsed as identities, not fetched through OpenSea. Failed direct probes do not classify an address as a wallet; matches on multiple directly probed chains show a chooser. See AGENTS.md for interfaces and limitations.

Wallet browsing defaults to All chains (network=0): Ethereum (1), Base (8453), Arbitrum One (42161), Base Sepolia (84532). The Network selector limits address detection and wallet/category discovery to the selected chain, and wallet links retain it. ENS resolution still uses Ethereum. Collection and app links pin their actual chain. BAMFS wallet apps use the current orgs.json factory and stores on all four networks, grouped into org folders. Old shared-contract direct links retain the original deployment records. Org identity includes network and contract; no store addresses are guessed. Non-BAMFS ABX wallet discovery remains limited to registered public-resolver collections; owned BAMFS orgs are included directly. The Worker requires RPC_URL_42161 as a full Arbitrum One HTTPS RPC URL for sponsored reads. Independent copies have a replaceable public Arbitrum default.

EIP-7702 delegated EOAs are wallet locations even though eth_getCode is nonempty. Detect the exact 23-byte delegation designator before any NFT interface probes. Wallet roots keep All chains by default, with the full network selector available. Older false contract folders/collection links that now resolve to wallets reopen their holdings in All chains. Genuine unrecognized contracts and multichain NFT contracts retain the existing contract/network-choice behavior.

Public app links use `/app/CHAIN/ORG/TOKEN/?options`, defaulting to latest, with optional `/v/N/` for fixed versions and a file path suffix. All query keys are app options. `/app-full/...` hides the viewer frame. Copy app link and address-bar replacement retain the public tuple/path/query/fragment without a local session ID. Fresh-browser loading reconstructs and verifies files through RPC. Legacy hash routes remain compatible. Find3r gateways map these paths to the original onchain viewer.html only when find3rRoutes is enabled; generic gateways retain exact-file behavior. The optional Node-builtins local server agent/serve.mjs supplies the same mappings for recovered Find3r copies.

## Expanded artwork and app reads

The bundled client adds configurable IPFS/Arweave fallback, original-contract CryptoPunks SVG/traits/ownership, bounded legacy marketplace-link resolution, and audio/video/PDF/text viewers. Wallet Artworks folders combine optional Alchemy-compatible v3 index discovery with balance probes for documented familiar collections. Index results are convenience data, may lag chain state, and do not imply universal completeness. Collections are followed for at most 50 index pages per chain; truncation is visible. Direct token opening uses the original RPC/contract metadata interface. See AGENTS.md → Broader NFT access for exact calls and addresses.

Normal artwork links use artwork.html?chain=CHAIN&contract=CONTRACT&token=TOKEN&adapter=TYPE; old hash links remain accepted. App URLs and query handling are unchanged.

An opt-out sandbox read bridge supplies window.find3r.rpc.request, a read-only provider, and relative POST /rpc/CHAIN. Parent Find3r settings select the endpoint; no endpoint or credential enters the iframe. The listener authenticates the current iframe window and render nonce. Policy checks reject account/signing/transaction/debug methods, pending/state overrides, unbounded logs, and excessive data/gas. Read requests are queued and limited; wallet RPC configurations cannot be extracted. Existing external app connections are untouched. Turning the preference off requires reopening the app.

Sponsored Workers add /nfts/CHAIN using privately derived Alchemy NFT v3 settings, optional NFT_API_URL_CHAIN, plus /resolve-nft for bounded, allowlisted marketplace pages. These require an updated Worker module, separate from publishing frontend bytes. Public index and gateway access is an optional convenience; archived BAMFS retrieval still only requires the chain, original reader specification, and an RPC.

Generic NFT metadata uses core/metadata.js for common fields, inline SVG images, traits/properties, ERC-1155 ID substitution, file classification, and external project links. IPFS subdomains/bare CIDs and relative content-addressed resources share one resolver. Optional contractURI supplies missing collection names; ERC-1155 quantities from the index and optional direct totalSupply(id) remain distinct. The browser can request bounded identity-checked getNFTMetadata after direct metadata failure, but never bypasses failed ownership/mint checks. Cached metadata is visibly labelled and not proof of original storage availability. Core readers without metadataFallback retain original-source-only behavior.
