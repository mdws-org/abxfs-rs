// The block roots the light client starts from, and the beacon nodes it asks. Written by tools/checkpoint.py,
// which takes a finalized root only when two independent beacon nodes report the same one and the light client
// can start from it. A root is trusted for 14 days (site/light.js); a build older than that stops claiming proof.
export const CHECKPOINTS = {
  1: { root: '0x8c5fc83200571c72083c73f3ca55b6f5111b011716e2867b27fabfe4353865c4', slot: 15634688, date: '2026-11-11' },
  11155111: { root: '0xf54bd3575c05c7d83ee53dcef9bbfd98720b39e0be93aa9707a22dce8f2225d3', slot: 11558912, date: '2026-11-11' },
};
// Beacon API servers with CORS that serve the light-client routes. None is trusted: a wrong reply fails its
// signature or its Merkle branch. More than one is listed so that one being down does not end proving.
export const BEACONS = {
  1: ['https://lodestar-mainnet.chainsafe.io', 'https://ethereum-beacon-api.publicnode.com'],
  11155111: ['https://lodestar-sepolia.chainsafe.io'],
};
