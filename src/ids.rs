//! Keccak ids: chunk ids, node ids, file CIDs and directory CIDs (SDK `cid.ts`, `nodes.ts`).

use tiny_keccak::{Hasher, Keccak};

use crate::hex::decode_const;
use crate::Result;

pub type H256 = [u8; 32];
pub const ZERO: H256 = [0u8; 32];

pub const CHUNK_ID_PREFIX: u8 = 0x30;
pub const FILE_CID_PREFIX: u8 = 0x31;
pub const DIRECTORY_CID_PREFIX: u8 = 0x32;
pub const CHUNK_NODE_PREFIX: u8 = 0x41;
pub const ENTRY_NODE_PREFIX: u8 = 0x42;

pub const MAX_MIME_BYTES: usize = 127;
pub const MAX_U48: u64 = (1u64 << 48) - 1;

/// A storage backend: its raw address (hashed into every chunk id) and its EIP-55 spelling.
#[derive(Debug, PartialEq, Eq)]
pub struct Backend {
    pub address: [u8; 20],
    pub checksummed: &'static str,
}

/// Canonical `Sstore2Backend` (raw), same address on every chain.
pub static RAW_BACKEND: Backend = Backend {
    address: decode_const::<20>("0x3C3AE36F5d8Aff2Dd60c37cA9103D93803c4c844"),
    checksummed: "0x3C3AE36F5d8Aff2Dd60c37cA9103D93803c4c844",
};

/// Canonical `FastLzSstore2Backend`.
pub static FASTLZ_BACKEND: Backend = Backend {
    address: decode_const::<20>("0x80a4Ec4A4F98358022A5a060F7cB467188fb68E1"),
    checksummed: "0x80a4Ec4A4F98358022A5a060F7cB467188fb68E1",
};

/// The input cap of both SSTORE2 backends (EIP-170 code limit minus the STOP byte).
pub const SSTORE2_MAX_INPUT: usize = 24_575;

pub fn keccak256(data: &[u8]) -> H256 {
    keccak_parts(&[data])
}

pub fn keccak_parts(parts: &[&[u8]]) -> H256 {
    let mut k = Keccak::v256();
    for p in parts {
        k.update(p);
    }
    let mut out = [0u8; 32];
    k.finalize(&mut out);
    out
}

pub fn u48_be(v: u64) -> [u8; 6] {
    assert!(v <= MAX_U48, "value {v} does not fit u48");
    let b = v.to_be_bytes();
    [b[2], b[3], b[4], b[5], b[6], b[7]]
}

/// `keccak256(0x30 ‖ backend:20 ‖ inputHash:32 ‖ dataHash:32 ‖ u48(size))`.
pub fn chunk_id(backend: &[u8; 20], input_hash: &H256, data_hash: &H256, size: u64) -> Result<H256> {
    if size < 1 || size > MAX_U48 {
        return Err(format!("chunkId: size {size} is outside 1 to 2^48 - 1"));
    }
    Ok(keccak_parts(&[&[CHUNK_ID_PREFIX], backend, input_hash, data_hash, &u48_be(size)]))
}

/// `keccak256(prefix ‖ blob)`.
pub fn node_id(prefix: u8, blob: &[u8]) -> H256 {
    keccak_parts(&[&[prefix], blob])
}

/// `keccak256(0x31 ‖ root ‖ keccak256(utf8(mime)) ‖ codec ‖ outputHash)`, with `createFile`'s refusals.
pub fn file_cid(root: &H256, mime: &str, codec: &H256, output_hash: &H256) -> Result<H256> {
    let m = mime.as_bytes();
    if m.is_empty() || m.len() > MAX_MIME_BYTES {
        return Err(format!("mime type must be 1 to {MAX_MIME_BYTES} bytes"));
    }
    let no_codec = *codec == ZERO;
    let no_output = *output_hash == ZERO;
    if no_codec != no_output {
        return Err("a file codec and its outputHash are both zero or both set".into());
    }
    if !no_codec && *root == ZERO {
        return Err("the empty file has no codec".into());
    }
    Ok(keccak_parts(&[&[FILE_CID_PREFIX], root, &keccak256(m), codec, output_hash]))
}

/// `keccak256(0x32 ‖ root)`.
pub fn directory_cid(root: &H256) -> H256 {
    keccak_parts(&[&[DIRECTORY_CID_PREFIX], root])
}

/// `DirectoryStore.EMPTY_DIRECTORY`: exists on chain without being created.
pub fn empty_directory() -> H256 {
    directory_cid(&ZERO)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hex::to_hex;

    #[test]
    fn keccak_empty() {
        assert_eq!(
            to_hex(&keccak256(b"")),
            "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        );
    }
}
