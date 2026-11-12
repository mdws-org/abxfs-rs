// The block roots the light client starts from, and the beacon nodes it asks. Written by tools/checkpoint.py,
// which takes a finalized root only when two independent beacon nodes report the same one and the light client
// can start from it. A root is trusted for 14 days (site/light.js); a build older than that stops claiming proof.
export const CHECKPOINTS = {
  1: { root: '0x429b47af3de0b1c099adedcc08f939993e1a081f6513241f13c6738f95312c45', slot: 15640768, date: '2026-11-12' },
  11155111: { root: '0xee6c50637284f95d12e9720c45e95d78bf196557c80f935c3fb149dce3725367', slot: 11564992, date: '2026-11-12' },
};
// Beacon API servers with CORS that serve the light-client routes. None is trusted: a wrong reply fails its
// signature or its Merkle branch. More than one is listed so that one being down does not end proving.
export const BEACONS = {
  1: ['https://lodestar-mainnet.chainsafe.io', 'https://ethereum-beacon-api.publicnode.com'],
  11155111: ['https://lodestar-sepolia.chainsafe.io'],
};
