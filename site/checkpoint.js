// The block roots the light client starts from, and the beacon nodes it asks. Written by tools/checkpoint.py,
// which takes a finalized root only when two independent beacon nodes report the same one and the light client
// can start from it. A root is trusted for 14 days (site/light.js); a build older than that stops claiming proof.
export const CHECKPOINTS = {
  1: { root: '0x039634d0b5d6140a8aefe07f43a15870b868ddaf017afa28f0f1ab0bd2c05d98', slot: 15720352, date: '2026-11-23' },
  11155111: { root: '0xa8d7f9e81d73f1e52b3a8f3b8858448d6544116d2651e88a8089c7763fc346f0', slot: 11644576, date: '2026-11-23' },
};
// Beacon API servers with CORS that serve the light-client routes. None is trusted: a wrong reply fails its
// signature or its Merkle branch. More than one is listed so that one being down does not end proving.
export const BEACONS = {
  1: ['https://lodestar-mainnet.chainsafe.io', 'https://ethereum-beacon-api.publicnode.com'],
  11155111: ['https://lodestar-sepolia.chainsafe.io'],
};
