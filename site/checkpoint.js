// The block roots the light client starts from, and the beacon nodes it asks. Written by tools/checkpoint.py,
// which takes a finalized root only when two independent beacon nodes report the same one and the light client
// can start from it. A root is trusted for 14 days (site/light.js); a build older than that stops claiming proof.
export const CHECKPOINTS = {
  1: { root: '0xf5cf784be01b625cc70b3d2715e207c1c1601f516ed103b7f7cee6a75f9ec41b', slot: 15669408, date: '2026-11-16' },
  11155111: { root: '0x6deb865a794f0177dc47783225f73b6bb80d305e0e547399eaf59e502cfbca00', slot: 11593600, date: '2026-11-16' },
};
// Beacon API servers with CORS that serve the light-client routes. None is trusted: a wrong reply fails its
// signature or its Merkle branch. More than one is listed so that one being down does not end proving.
export const BEACONS = {
  1: ['https://lodestar-mainnet.chainsafe.io', 'https://ethereum-beacon-api.publicnode.com'],
  11155111: ['https://lodestar-sepolia.chainsafe.io'],
};
