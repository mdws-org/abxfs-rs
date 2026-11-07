// Keccak-256 with the original padding Ethereum uses (0x01, not SHA-3's 0x06). Each 64-bit lane is held as two
// 32-bit halves, lo at even index and hi at odd, so hashing a 24 KB node blob stays well under a millisecond.

const RC = [
  0x00000001, 0x00000000, 0x00008082, 0x00000000, 0x0000808a, 0x80000000, 0x80008000, 0x80000000,
  0x0000808b, 0x00000000, 0x80000001, 0x00000000, 0x80008081, 0x80000000, 0x00008009, 0x80000000,
  0x0000008a, 0x00000000, 0x00000088, 0x00000000, 0x80008009, 0x00000000, 0x8000000a, 0x00000000,
  0x8000808b, 0x00000000, 0x0000008b, 0x80000000, 0x00008089, 0x80000000, 0x00008003, 0x80000000,
  0x00008002, 0x80000000, 0x00000080, 0x80000000, 0x0000800a, 0x00000000, 0x8000000a, 0x80000000,
  0x80008081, 0x80000000, 0x00008080, 0x80000000, 0x80000001, 0x00000000, 0x80008008, 0x80000000,
];
// Rotation of lane x + 5y.
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
// Destination lane of x + 5y under pi: y + 5((2x + 3y) mod 5).
const PI = [];
for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) PI[x + 5 * y] = y + 5 * ((2 * x + 3 * y) % 5);

const C = new Uint32Array(10);
const B = new Uint32Array(50);

function permute(s) {
  for (let r = 0; r < 24; r++) {
    for (let x = 0; x < 5; x++) {
      C[2 * x] = s[2 * x] ^ s[2 * x + 10] ^ s[2 * x + 20] ^ s[2 * x + 30] ^ s[2 * x + 40];
      C[2 * x + 1] = s[2 * x + 1] ^ s[2 * x + 11] ^ s[2 * x + 21] ^ s[2 * x + 31] ^ s[2 * x + 41];
    }
    for (let x = 0; x < 5; x++) {
      const a = (x + 4) % 5, b = (x + 1) % 5;
      const bl = C[2 * b], bh = C[2 * b + 1];
      const dl = C[2 * a] ^ ((bl << 1) | (bh >>> 31));
      const dh = C[2 * a + 1] ^ ((bh << 1) | (bl >>> 31));
      for (let y = 0; y < 25; y += 5) {
        s[2 * (x + y)] ^= dl;
        s[2 * (x + y) + 1] ^= dh;
      }
    }
    for (let i = 0; i < 25; i++) {
      const lo = s[2 * i], hi = s[2 * i + 1], n = ROT[i], d = 2 * PI[i];
      if (n === 0) { B[d] = lo; B[d + 1] = hi; }
      else if (n < 32) { B[d] = (lo << n) | (hi >>> (32 - n)); B[d + 1] = (hi << n) | (lo >>> (32 - n)); }
      else if (n === 32) { B[d] = hi; B[d + 1] = lo; }
      else { const m = n - 32; B[d] = (hi << m) | (lo >>> (32 - m)); B[d + 1] = (lo << m) | (hi >>> (32 - m)); }
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        const i = 2 * (y + x), j = 2 * (y + ((x + 1) % 5)), k = 2 * (y + ((x + 2) % 5));
        s[i] = B[i] ^ (~B[j] & B[k]);
        s[i + 1] = B[i + 1] ^ (~B[j + 1] & B[k + 1]);
      }
    }
    s[0] ^= RC[2 * r];
    s[1] ^= RC[2 * r + 1];
  }
}

// bytes: Uint8Array -> Uint8Array(32). `pad` is 0x01 for Keccak-256; 0x06 gives SHA3-256.
export function keccak256(bytes, pad = 0x01) {
  const rate = 136;
  const padded = new Uint8Array(Math.floor(bytes.length / rate + 1) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= pad;
  padded[padded.length - 1] ^= 0x80;
  const s = new Uint32Array(50);
  const v = new DataView(padded.buffer);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 4; i++) s[i] ^= v.getUint32(off + 4 * i, true);
    permute(s);
  }
  const out = new Uint8Array(32);
  const o = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) o.setUint32(4 * i, s[i], true);
  return out;
}
