//! Ethereum's RLP, block headers and Merkle-Patricia proofs, as archive/ARCHIVE.md section 3 defines them.

use crate::ids::keccak256;

pub type H256 = [u8; 32];

/// One RLP item.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rlp {
    Str(Vec<u8>),
    List(Vec<Rlp>),
}

impl Rlp {
    pub fn str(&self) -> Option<&[u8]> {
        match self {
            Rlp::Str(s) => Some(s),
            Rlp::List(_) => None,
        }
    }
    pub fn list(&self) -> Option<&[Rlp]> {
        match self {
            Rlp::List(l) => Some(l),
            Rlp::Str(_) => None,
        }
    }
}

const MAX_DEPTH: usize = 16;

fn be_len(b: &[u8]) -> Option<usize> {
    if b.is_empty() || b[0] == 0 || b.len() > 8 {
        return None;
    }
    usize::try_from(b.iter().fold(0u64, |v, &x| (v << 8) | x as u64)).ok()
}

fn item(b: &[u8], at: usize, depth: usize) -> Option<(Rlp, usize)> {
    if depth > MAX_DEPTH {
        return None;
    }
    let p = *b.get(at)?;
    let (is_list, start, len) = match p {
        0x00..=0x7f => return Some((Rlp::Str(vec![p]), at + 1)),
        0x80..=0xb7 => (false, at + 1, (p - 0x80) as usize),
        0xb8..=0xbf => {
            let n = (p - 0xb7) as usize;
            let len = be_len(b.get(at + 1..at + 1 + n)?)?;
            if len <= 55 {
                return None;
            }
            (false, at + 1 + n, len)
        }
        0xc0..=0xf7 => (true, at + 1, (p - 0xc0) as usize),
        0xf8..=0xff => {
            let n = (p - 0xf7) as usize;
            let len = be_len(b.get(at + 1..at + 1 + n)?)?;
            if len <= 55 {
                return None;
            }
            (true, at + 1 + n, len)
        }
    };
    let end = start.checked_add(len)?;
    let body = b.get(start..end)?;
    if !is_list {
        if len == 1 && body[0] < 0x80 {
            return None;
        }
        return Some((Rlp::Str(body.to_vec()), end));
    }
    let mut items = Vec::new();
    let mut i = 0;
    while i < body.len() {
        let (it, next) = item(body, i, depth + 1)?;
        items.push(it);
        i = next;
    }
    Some((Rlp::List(items), end))
}

/// Strict decoding of one item that fills `b` exactly.
pub fn decode(b: &[u8]) -> Option<Rlp> {
    let (it, end) = item(b, 0, 0)?;
    (end == b.len()).then_some(it)
}

pub fn encode(r: &Rlp) -> Vec<u8> {
    fn head(out: &mut Vec<u8>, len: usize, short: u8, long: u8) {
        if len <= 55 {
            out.push(short + len as u8);
        } else {
            let lb: Vec<u8> = len.to_be_bytes().iter().copied().skip_while(|&x| x == 0).collect();
            out.push(long + lb.len() as u8);
            out.extend_from_slice(&lb);
        }
    }
    let mut out = Vec::new();
    match r {
        Rlp::Str(s) if s.len() == 1 && s[0] < 0x80 => out.push(s[0]),
        Rlp::Str(s) => {
            head(&mut out, s.len(), 0x80, 0xb7);
            out.extend_from_slice(s);
        }
        Rlp::List(l) => {
            let body: Vec<u8> = l.iter().flat_map(encode).collect();
            head(&mut out, body.len(), 0xc0, 0xf7);
            out.extend_from_slice(&body);
        }
    }
    out
}

/// An RLP integer: at most `max` bytes with no leading zero, as a u128 when it fits.
pub fn int(b: &[u8], max: usize) -> Option<u128> {
    if b.len() > max || b.first() == Some(&0) || b.len() > 16 {
        return None;
    }
    Some(b.iter().fold(0u128, |v, &x| (v << 8) | x as u128))
}

/// The fields of a block header that archive bundles use.
#[derive(Clone, Debug)]
pub struct Header {
    pub hash: H256,
    pub state_root: H256,
    pub number: u64,
    pub timestamp: u64,
}

pub fn header(rlp: &[u8]) -> Result<Header, String> {
    let r = decode(rlp).ok_or("a header is not valid RLP")?;
    let l = r.list().ok_or("a header is not an RLP list")?;
    if l.len() < 15 || l.iter().any(|x| x.str().is_none()) {
        return Err("a header is not a list of at least 15 strings".into());
    }
    let sr = l[3].str().unwrap();
    if sr.len() != 32 {
        return Err("a header's state root is not 32 bytes".into());
    }
    let num = |i: usize, what: &str| -> Result<u64, String> {
        int(l[i].str().unwrap(), 7).filter(|&v| v < (1 << 53)).map(|v| v as u64).ok_or_else(|| format!("a header's {what} is not a number below 2^53"))
    };
    Ok(Header { hash: keccak256(rlp), state_root: sr.try_into().unwrap(), number: num(8, "number")?, timestamp: num(11, "timestamp")? })
}

/// The nibbles of a hex-prefix encoded path, and whether it ends in a leaf.
fn hex_prefix(b: &[u8]) -> Option<(Vec<u8>, bool)> {
    let first = *b.first()?;
    let flag = first >> 4;
    if flag > 3 || (flag & 1 == 0 && first & 0x0f != 0) {
        return None;
    }
    let mut nib = Vec::new();
    if flag & 1 == 1 {
        nib.push(first & 0x0f);
    }
    for &x in &b[1..] {
        nib.push(x >> 4);
        nib.push(x & 0x0f);
    }
    Some((nib, flag >= 2))
}

/// Walk `proof` for `key` from `root`. Some(value) for a leaf at the key, None for absence; Err for a proof that
/// does not hold (archive/ARCHIVE.md 3.3).
pub fn verify(root: &H256, key: &[u8], proof: &[Vec<u8>]) -> Result<Option<Vec<u8>>, String> {
    if proof.is_empty() || proof.len() > 64 {
        return Err("a proof has no nodes, or more than 64".into());
    }
    let path: Vec<u8> = keccak256(key).iter().flat_map(|b| [b >> 4, b & 0x0f]).collect();
    let mut at = 0usize;
    let mut used = 0usize;
    let first = &proof[0];
    if keccak256(first) != *root {
        return Err("a proof's first node does not hash to the root".into());
    }
    let mut node = decode(first).ok_or("a proof node is not valid RLP")?;
    used += 1;
    loop {
        let l = node.list().ok_or("a proof node is not a list")?.to_vec();
        let next: Rlp = match l.len() {
            17 => {
                if l[16].str() != Some(&[][..]) {
                    return Err("a branch holds a value, which these tries never do".into());
                }
                if at >= path.len() {
                    return Err("a proof runs past its key".into());
                }
                let child = l[path[at] as usize].clone();
                at += 1;
                child
            }
            2 => {
                let (nib, leaf) = hex_prefix(l[0].str().ok_or("a short node's path is not a string")?).ok_or("a short node's path is not hex-prefix encoded")?;
                let rest = &path[at..];
                if leaf {
                    if nib.as_slice() != rest {
                        return finish(used, proof.len(), None);
                    }
                    let v = l[1].str().ok_or("a leaf's value is not a string")?.to_vec();
                    return finish(used, proof.len(), Some(v));
                }
                if nib.is_empty() || !rest.starts_with(&nib) {
                    return finish(used, proof.len(), None);
                }
                at += nib.len();
                l[1].clone()
            }
            _ => return Err("a proof node is neither a branch nor a short node".into()),
        };
        match &next {
            Rlp::Str(s) if s.is_empty() => return finish(used, proof.len(), None),
            Rlp::Str(s) if s.len() == 32 => {
                let n = proof.get(used).ok_or("a proof ends before its key")?;
                if keccak256(n) != s.as_slice() {
                    return Err("a proof node does not hash to the reference its parent holds".into());
                }
                node = decode(n).ok_or("a proof node is not valid RLP")?;
                used += 1;
            }
            Rlp::List(_) => {
                if encode(&next).len() >= 32 {
                    return Err("an embedded node is 32 bytes or longer".into());
                }
                node = next;
            }
            Rlp::Str(_) => return Err("a child reference is neither a hash nor an embedded node".into()),
        }
    }
}

fn finish(used: usize, total: usize, v: Option<Vec<u8>>) -> Result<Option<Vec<u8>>, String> {
    if used != total {
        return Err("a proof has nodes after the one its walk ends at".into());
    }
    Ok(v)
}

/// An account: (storage root, code hash), or None when the proof shows it does not exist.
pub fn account(state_root: &H256, address: &[u8; 20], proof: &[Vec<u8>]) -> Result<Option<(H256, H256)>, String> {
    let Some(v) = verify(state_root, address, proof)? else { return Ok(None) };
    let r = decode(&v).ok_or("an account is not valid RLP")?;
    let l = r.list().filter(|l| l.len() == 4).ok_or("an account is not a list of four")?;
    for i in 0..2 {
        int(l[i].str().ok_or("an account's nonce or balance is not a string")?, 32).ok_or("an account's nonce or balance is not an integer")?;
    }
    let sr: H256 = l[2].str().and_then(|s| s.try_into().ok()).ok_or("an account's storage root is not 32 bytes")?;
    let ch: H256 = l[3].str().and_then(|s| s.try_into().ok()).ok_or("an account's code hash is not 32 bytes")?;
    Ok(Some((sr, ch)))
}

/// A storage word, zero when the proof shows it absent.
pub fn storage(storage_root: &H256, slot: &H256, proof: &[Vec<u8>]) -> Result<H256, String> {
    let Some(v) = verify(storage_root, slot, proof)? else { return Ok([0u8; 32]) };
    let r = decode(&v).ok_or("a storage value is not valid RLP")?;
    let s = r.str().ok_or("a storage value is not a string")?;
    if s.len() > 32 || s.first() == Some(&0) || s.is_empty() {
        return Err("a storage value is not a non-zero integer of at most 32 bytes".into());
    }
    let mut w = [0u8; 32];
    w[32 - s.len()..].copy_from_slice(s);
    Ok(w)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rlp() {
        assert_eq!(decode(&[0x80]), Some(Rlp::Str(vec![])));
        assert_eq!(decode(&[0x05]), Some(Rlp::Str(vec![5])));
        assert_eq!(decode(&[0x81, 0x05]), None);
        assert_eq!(decode(&[0x82, 0x01]), None);
        assert_eq!(decode(&[0xc0, 0x00]), None);
        assert_eq!(decode(&[0xb8, 0x05, 1, 2, 3, 4, 5]), None);
        let long = Rlp::Str(vec![7; 60]);
        assert_eq!(decode(&encode(&long)), Some(long));
        let l = Rlp::List(vec![Rlp::Str(b"cat".to_vec()), Rlp::Str(b"dog".to_vec())]);
        assert_eq!(encode(&l), vec![0xc8, 0x83, b'c', b'a', b't', 0x83, b'd', b'o', b'g']);
    }

    /// A one-leaf trie: the root node is the leaf itself.
    #[test]
    fn single_leaf() {
        let key = [0x11u8; 20];
        let path: Vec<u8> = keccak256(&key).to_vec();
        let leaf = encode(&Rlp::List(vec![Rlp::Str([&[0x20u8][..], &path].concat()), Rlp::Str(b"value".to_vec())]));
        let root = keccak256(&leaf);
        assert_eq!(verify(&root, &key, &[leaf.clone()]).unwrap(), Some(b"value".to_vec()));
        assert_eq!(verify(&root, &[0x12u8; 20], &[leaf.clone()]).unwrap(), None);
        assert!(verify(&[0u8; 32], &key, &[leaf.clone()]).is_err());
        assert!(verify(&root, &key, &[leaf.clone(), leaf]).is_err());
    }
}
