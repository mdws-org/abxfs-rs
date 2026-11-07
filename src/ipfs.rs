//! IPFS CIDv1 derivation for the `ipfs add -r --cid-version=1 --hidden` profile (SDK `cid.ts`).

use sha2::{Digest, Sha256};

use crate::Result;

pub const IPFS_CHUNK_SIZE: usize = 262_144;
pub const IPFS_MAX_LINKS: usize = 174;
pub const IPFS_SHARD_THRESHOLD_BYTES: usize = 262_144;
pub const CODEC_RAW: u8 = 0x55;
pub const CODEC_DAG_PB: u8 = 0x70;

/// Binary CIDv1 with a sha2-256 multihash: `0x01 ‖ codec ‖ 0x12 ‖ 0x20 ‖ digest`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cid(pub [u8; 36]);

impl Cid {
    pub fn new(codec: u8, data: &[u8]) -> Cid {
        let digest = Sha256::digest(data);
        let mut b = [0u8; 36];
        b[0] = 0x01;
        b[1] = codec;
        b[2] = 0x12;
        b[3] = 0x20;
        b[4..].copy_from_slice(&digest);
        Cid(b)
    }

    /// Multibase base32 lowercase, no padding, prefix `b`.
    pub fn to_string_b32(&self) -> String {
        const ALPHA: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
        let mut s = String::with_capacity(1 + (36usize * 8).div_ceil(5));
        s.push('b');
        let mut acc: u32 = 0;
        let mut bits = 0;
        for &byte in &self.0 {
            acc = (acc << 8) | byte as u32;
            bits += 8;
            while bits >= 5 {
                bits -= 5;
                s.push(ALPHA[((acc >> bits) & 31) as usize] as char);
            }
        }
        if bits > 0 {
            s.push(ALPHA[((acc << (5 - bits)) & 31) as usize] as char);
        }
        s
    }
}

pub fn varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8 & 0x7f) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

/// A derived node: its CID, content bytes beneath it, and cumulative serialized size (the parent's `Tsize`).
#[derive(Clone, Copy, Debug)]
pub struct IpfsNode {
    pub cid: Cid,
    pub total_size: u64,
    pub tsize: u64,
}

/// A dag-pb link: name bytes, child CID, cumulative size.
pub struct Link<'a> {
    pub name: &'a [u8],
    pub cid: Cid,
    pub tsize: u64,
}

/// dag-pb block as `@ipld/dag-pb` writes it: every link (Hash, Name, Tsize), then Data.
pub fn encode_dag_pb(links: &[Link], data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(links.len() * 48 + data.len() + 4);
    let mut body = Vec::with_capacity(64);
    for l in links {
        body.clear();
        body.push(0x0a);
        varint(&mut body, l.cid.0.len() as u64);
        body.extend_from_slice(&l.cid.0);
        body.push(0x12);
        varint(&mut body, l.name.len() as u64);
        body.extend_from_slice(l.name);
        body.push(0x18);
        varint(&mut body, l.tsize);
        out.push(0x12);
        varint(&mut out, body.len() as u64);
        out.extend_from_slice(&body);
    }
    out.push(0x0a);
    varint(&mut out, data.len() as u64);
    out.extend_from_slice(data);
    out
}

fn wrap_group(children: &[IpfsNode]) -> IpfsNode {
    let filesize: u64 = children.iter().map(|c| c.total_size).sum();
    let mut data = vec![0x08, 0x02, 0x18];
    varint(&mut data, filesize);
    for c in children {
        data.push(0x20);
        varint(&mut data, c.total_size);
    }
    let links: Vec<Link> = children.iter().map(|c| Link { name: b"", cid: c.cid, tsize: c.tsize }).collect();
    let block = encode_dag_pb(&links, &data);
    let cumulative: u64 = children.iter().map(|c| c.tsize).sum();
    IpfsNode { cid: Cid::new(CODEC_DAG_PB, &block), total_size: filesize, tsize: block.len() as u64 + cumulative }
}

/// A file's IPFS root over its content: one raw block up to 256 KiB inclusive, else a balanced dag-pb DAG of raw leaves.
pub fn file_node(bytes: &[u8]) -> IpfsNode {
    if bytes.len() <= IPFS_CHUNK_SIZE {
        return IpfsNode { cid: Cid::new(CODEC_RAW, bytes), total_size: bytes.len() as u64, tsize: bytes.len() as u64 };
    }
    let mut layer: Vec<IpfsNode> = bytes
        .chunks(IPFS_CHUNK_SIZE)
        .map(|c| IpfsNode { cid: Cid::new(CODEC_RAW, c), total_size: c.len() as u64, tsize: c.len() as u64 })
        .collect();
    while layer.len() > 1 {
        layer = layer.chunks(IPFS_MAX_LINKS).map(wrap_group).collect();
    }
    layer[0]
}

pub fn file_cid(bytes: &[u8]) -> String {
    file_node(bytes).cid.to_string_b32()
}

/// A flat UnixFS directory. Refuses a directory Kubo would shard (Σ(name + CID bytes) > 256 KiB) and duplicate names.
pub fn directory_node(entries: &[(Vec<u8>, IpfsNode)]) -> Result<IpfsNode> {
    let estimate: usize = entries.iter().map(|(n, c)| n.len() + c.cid.0.len()).sum();
    if estimate > IPFS_SHARD_THRESHOLD_BYTES {
        return Err(format!("directory needs sharding: IPFS size estimate {estimate} > {IPFS_SHARD_THRESHOLD_BYTES}"));
    }
    let mut links: Vec<Link> = entries.iter().map(|(n, c)| Link { name: n, cid: c.cid, tsize: c.tsize }).collect();
    links.sort_by(|a, b| a.name.cmp(b.name));
    if links.windows(2).any(|w| w[0].name == w[1].name) {
        return Err("ipfs directory: two entries have the same name".into());
    }
    let block = encode_dag_pb(&links, &[0x08, 0x01]);
    let cumulative: u64 = links.iter().map(|l| l.tsize).sum();
    Ok(IpfsNode { cid: Cid::new(CODEC_DAG_PB, &block), total_size: 0, tsize: block.len() as u64 + cumulative })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_vectors() {
        assert_eq!(file_cid(b""), "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
        let d = directory_node(&[]).unwrap();
        assert_eq!(d.cid.to_string_b32(), "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354");
        assert_eq!(d.tsize, 4);
    }
}
