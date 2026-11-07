//! The few Solidity ABI encodings the read path needs, by hand: static words, `bytes`, and Multicall3's
//! `aggregate3((address,bool,bytes)[])` call and `(bool,bytes)[]` result.

use crate::ids::{keccak256, H256};
use crate::Result;

pub type Address = [u8; 20];

/// The 4-byte selector of a canonical function signature.
pub fn selector(signature: &str) -> [u8; 4] {
    let h = keccak256(signature.as_bytes());
    [h[0], h[1], h[2], h[3]]
}

pub fn word_u64(v: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&v.to_be_bytes());
    w
}

pub fn word_address(a: &Address) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

/// Calldata for a function whose arguments are all static 32-byte words.
pub fn call_words(sel: [u8; 4], words: &[[u8; 32]]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + 32 * words.len());
    out.extend_from_slice(&sel);
    for w in words {
        out.extend_from_slice(w);
    }
    out
}

fn pad32(len: usize) -> usize {
    len.div_ceil(32) * 32
}

fn push_bytes_tail(out: &mut Vec<u8>, b: &[u8]) {
    out.extend_from_slice(&word_u64(b.len() as u64));
    out.extend_from_slice(b);
    out.resize(out.len() + pad32(b.len()) - b.len(), 0);
}

/// `Multicall3.aggregate3(Call3[] calls)` with `allowFailure = true` on every call.
pub fn encode_aggregate3(calls: &[(Address, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&selector("aggregate3((address,bool,bytes)[])"));
    out.extend_from_slice(&word_u64(32));
    out.extend_from_slice(&word_u64(calls.len() as u64));
    let mut tails: Vec<Vec<u8>> = Vec::with_capacity(calls.len());
    for (target, data) in calls {
        let mut t = Vec::with_capacity(128 + pad32(data.len()));
        t.extend_from_slice(&word_address(target));
        t.extend_from_slice(&word_u64(1));
        t.extend_from_slice(&word_u64(96));
        push_bytes_tail(&mut t, data);
        tails.push(t);
    }
    let mut offset = 32 * calls.len();
    for t in &tails {
        out.extend_from_slice(&word_u64(offset as u64));
        offset += t.len();
    }
    for t in tails {
        out.extend_from_slice(&t);
    }
    out
}

/// A bounds-checked reader over ABI-encoded return data.
pub struct Dec<'a> {
    pub buf: &'a [u8],
}

impl<'a> Dec<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Dec { buf }
    }

    pub fn word(&self, at: usize) -> Result<&'a [u8]> {
        self.buf.get(at..at + 32).ok_or_else(|| format!("ABI data too short: word at {at}, {} bytes", self.buf.len()))
    }

    pub fn h256(&self, at: usize) -> Result<H256> {
        let mut h = [0u8; 32];
        h.copy_from_slice(self.word(at)?);
        Ok(h)
    }

    /// A word as an unsigned integer that must fit `bits` bits.
    pub fn uint(&self, at: usize, bits: u32) -> Result<u64> {
        let w = self.word(at)?;
        if w[..24].iter().any(|&b| b != 0) {
            return Err(format!("ABI word at {at} does not fit 64 bits"));
        }
        let v = u64::from_be_bytes(w[24..].try_into().unwrap());
        if bits < 64 && v >> bits != 0 {
            return Err(format!("ABI word at {at} does not fit {bits} bits"));
        }
        Ok(v)
    }

    pub fn boolean(&self, at: usize) -> Result<bool> {
        match self.uint(at, 1)? {
            0 => Ok(false),
            _ => Ok(true),
        }
    }

    pub fn address(&self, at: usize) -> Result<Address> {
        let w = self.word(at)?;
        if w[..12].iter().any(|&b| b != 0) {
            return Err(format!("ABI word at {at} is not an address"));
        }
        Ok(w[12..].try_into().unwrap())
    }

    /// An offset word, as a position relative to `base`.
    pub fn offset(&self, at: usize, base: usize) -> Result<usize> {
        let o = self.uint(at, 32)? as usize;
        Ok(base + o)
    }

    /// `bytes` / `string` whose length word is at `at`.
    pub fn bytes_at(&self, at: usize) -> Result<&'a [u8]> {
        let len = self.uint(at, 32)? as usize;
        self.buf.get(at + 32..at + 32 + len).ok_or_else(|| format!("ABI bytes at {at} run past the data"))
    }
}

/// Decode `(bool success, bytes returnData)[]`, the return of `aggregate3`.
pub fn decode_aggregate3(ret: &[u8], expected: usize) -> Result<Vec<(bool, Vec<u8>)>> {
    let d = Dec::new(ret);
    let arr = d.offset(0, 0)?;
    let n = d.uint(arr, 32)? as usize;
    if n != expected {
        return Err(format!("aggregate3 returned {n} results for {expected} calls"));
    }
    let heads = arr + 32;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let t = d.offset(heads + 32 * i, heads)?;
        let ok = d.boolean(t)?;
        let b = d.offset(t + 32, t)?;
        out.push((ok, d.bytes_at(b)?.to_vec()));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hex::to_hex;

    #[test]
    fn known_selectors() {
        assert_eq!(to_hex(&selector("aggregate3((address,bool,bytes)[])")), "0x82ad56cb");
        assert_eq!(to_hex(&selector("transfer(address,uint256)")), "0xa9059cbb");
    }
}
