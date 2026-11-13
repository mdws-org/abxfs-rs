//! The container of an archive bundle (archive/ARCHIVE.md section 1): CAR version 1 with one dag-json index block
//! and raw blocks, every CID version 1 with a SHA-256 multihash.

use sha2::{Digest, Sha256};

use crate::Result;

/// Largest raw block, the largest a block can be and still travel between IPFS nodes.
pub const MAX_BLOCK: usize = 1_048_576;
/// Largest index block: the same, so that any IPFS node can pass it on.
pub const MAX_INDEX: usize = 1_048_576;

const DAG_JSON_PREFIX: [u8; 5] = [0x01, 0xa9, 0x02, 0x12, 0x20];
const RAW_PREFIX: [u8; 4] = [0x01, 0x55, 0x12, 0x20];

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

pub fn raw_cid(data: &[u8]) -> Vec<u8> {
    [&RAW_PREFIX[..], &sha256(data)].concat()
}

pub fn index_cid(data: &[u8]) -> Vec<u8> {
    [&DAG_JSON_PREFIX[..], &sha256(data)].concat()
}

/// A binary CID as text: `b` and lowercase base32 without padding (RFC 4648).
pub fn cid_text(cid: &[u8]) -> String {
    const A: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut out = String::from("b");
    let (mut acc, mut bits) = (0u32, 0u32);
    for &b in cid {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(A[((acc >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(A[((acc << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// The binary CID a text CID names, or None when it is not `b` and lowercase base32 without padding that decodes
/// with no stray bits.
pub fn cid_from_text(s: &str) -> Option<Vec<u8>> {
    let body = s.strip_prefix('b')?;
    let (mut acc, mut bits, mut out) = (0u32, 0u32, Vec::new());
    for c in body.bytes() {
        let v = match c {
            b'a'..=b'z' => c - b'a',
            b'2'..=b'7' => c - b'2' + 26,
            _ => return None,
        } as u32;
        acc = (acc << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    if bits >= 5 || acc & ((1 << bits) - 1) != 0 {
        return None;
    }
    Some(out)
}

fn varint(mut n: usize, out: &mut Vec<u8>) {
    loop {
        let b = (n & 0x7f) as u8;
        n >>= 7;
        if n == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

/// A minimal unsigned LEB128 varint at `at`: its value and the position after it.
fn read_varint(b: &[u8], at: usize) -> Option<(usize, usize)> {
    let mut v: u64 = 0;
    for i in 0..9 {
        let x = *b.get(at + i)?;
        v |= ((x & 0x7f) as u64) << (7 * i);
        if x & 0x80 == 0 {
            if i > 0 && x == 0 {
                return None;
            }
            return usize::try_from(v).ok().map(|v| (v, at + i + 1));
        }
    }
    None
}

fn header(index: &[u8]) -> Vec<u8> {
    let mut h = vec![0xa2, 0x65];
    h.extend_from_slice(b"roots");
    h.extend_from_slice(&[0x81, 0xd8, 0x2a, 0x58, 0x26, 0x00]);
    h.extend_from_slice(index);
    h.push(0x67);
    h.extend_from_slice(b"version");
    h.push(0x01);
    h
}

/// The bundle bytes: the index block first, then the raw blocks in the order given (the order the index first
/// links them), each once.
pub fn write(index: &[u8], blocks: &[Vec<u8>]) -> Result<Vec<u8>> {
    if index.len() > MAX_INDEX {
        return Err("the index is larger than an index block may be".into());
    }
    let icid = index_cid(index);
    let mut seen = std::collections::HashSet::new();
    let raw: Vec<(Vec<u8>, &[u8])> = blocks.iter().map(|b| (raw_cid(b), b.as_slice())).filter(|(c, _)| seen.insert(c.clone())).collect();
    let mut out = Vec::new();
    let h = header(&icid);
    varint(h.len(), &mut out);
    out.extend_from_slice(&h);
    for (cid, data) in std::iter::once((icid, index)).chain(raw.into_iter()) {
        if cid[1] == 0x55 && data.len() > MAX_BLOCK {
            return Err("a raw block is larger than 1 MiB".into());
        }
        varint(cid.len() + data.len(), &mut out);
        out.extend_from_slice(&cid);
        out.extend_from_slice(data);
    }
    Ok(out)
}

/// A bundle's index and raw blocks, keyed by binary CID, with every container rule checked.
pub struct Parsed<'a> {
    pub index: &'a [u8],
    pub index_cid: Vec<u8>,
    pub blocks: std::collections::BTreeMap<Vec<u8>, &'a [u8]>,
    /// The raw blocks' CIDs in the order the file holds them.
    pub order: Vec<Vec<u8>>,
}

pub fn read(b: &[u8]) -> std::result::Result<Parsed<'_>, String> {
    let (hlen, at) = read_varint(b, 0).ok_or("the header length is not a varint")?;
    if hlen != 59 || b.len() < at + 59 {
        return Err("the header is not the 59-byte header of a bundle".into());
    }
    let h = &b[at..at + 59];
    let icid = h[13..50].to_vec();
    if h != header(&icid).as_slice() || icid[..5] != DAG_JSON_PREFIX {
        return Err("the header is not the header of a bundle".into());
    }
    let mut at = at + 59;
    let mut first = true;
    let mut index: &[u8] = &[];
    let mut blocks = std::collections::BTreeMap::new();
    let mut order = Vec::new();
    while at < b.len() {
        let (len, from) = read_varint(b, at).ok_or("a block length is not a varint")?;
        let end = from.checked_add(len).filter(|&e| e <= b.len()).ok_or("a block runs past the end of the file")?;
        let block = &b[from..end];
        let (cid, data) = if first {
            if block.len() < 37 || block[..37] != icid[..] {
                return Err("the first block is not the index the header names".into());
            }
            (block[..37].to_vec(), &block[37..])
        } else {
            if block.len() < 36 || block[..4] != RAW_PREFIX {
                return Err("a block after the index is not a raw block".into());
            }
            (block[..36].to_vec(), &block[36..])
        };
        if sha256(data) != cid[cid.len() - 32..] {
            return Err("a block's bytes do not hash to its CID".into());
        }
        if first {
            if data.len() > MAX_INDEX {
                return Err("the index block is larger than 1 MiB".into());
            }
            index = data;
            first = false;
        } else {
            if data.len() > MAX_BLOCK {
                return Err("a raw block is larger than 1 MiB".into());
            }
            if blocks.insert(cid.clone(), data).is_some() {
                return Err("a block appears twice".into());
            }
            order.push(cid);
        }
        at = end;
    }
    if first {
        return Err("the bundle has no index block".into());
    }
    Ok(Parsed { index, index_cid: icid, blocks, order })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_cids() {
        // The CID of the raw block "hello", as IPFS prints it.
        let c = raw_cid(b"hello");
        assert_eq!(cid_text(&c), "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq");
        assert_eq!(cid_from_text(&cid_text(&c)), Some(c));
        assert_eq!(cid_from_text("Bafk"), None);
        assert_eq!(cid_from_text("bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4ye1"), None);
    }

    #[test]
    fn round_trip() {
        let index = br#"{"a":1}"#.to_vec();
        let blocks = vec![b"two".to_vec(), b"one".to_vec(), b"two".to_vec()];
        let car = write(&index, &blocks).unwrap();
        assert_eq!(car[0], 0x3b);
        let p = read(&car).unwrap();
        assert_eq!(p.index, index.as_slice());
        assert_eq!(p.blocks.len(), 2);
        let mut bad = car.clone();
        let n = bad.len();
        bad[n - 1] ^= 1;
        assert!(read(&bad).is_err());
        assert!(read(&[car.as_slice(), &[0x01]].concat()).is_err());
    }
}
