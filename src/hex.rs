//! Lowercase `0x` hex, as viem prints ids and blobs.

const DIGITS: &[u8; 16] = b"0123456789abcdef";

pub fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("0x");
    for &b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 0xf) as usize] as char);
    }
    s
}

/// Parse a hex string (with or without `0x`) into bytes.
pub fn from_hex(s: &str) -> Result<Vec<u8>, String> {
    let b = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")).unwrap_or(s).as_bytes();
    if b.len() % 2 != 0 {
        return Err(format!("hex string has an odd length ({})", b.len()));
    }
    let val = |c: u8| -> Result<u8, String> {
        match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'a'..=b'f' => Ok(c - b'a' + 10),
            b'A'..=b'F' => Ok(c - b'A' + 10),
            _ => Err(format!("bad hex digit {:?}", c as char)),
        }
    };
    b.chunks_exact(2).map(|p| Ok((val(p[0])? << 4) | val(p[1])?)).collect()
}

/// Parse exactly 32 bytes of hex.
pub fn parse_h256(s: &str) -> Result<[u8; 32], String> {
    let v = from_hex(s)?;
    v.try_into().map_err(|v: Vec<u8>| format!("expected 32 bytes of hex, got {}", v.len()))
}

/// Parse `N` bytes from a hex string (with or without `0x`), usable in constants.
pub const fn decode_const<const N: usize>(s: &str) -> [u8; N] {
    let b = s.as_bytes();
    let start = if b.len() >= 2 && b[0] == b'0' && (b[1] == b'x' || b[1] == b'X') { 2 } else { 0 };
    assert!(b.len() - start == N * 2, "hex length");
    let mut out = [0u8; N];
    let mut i = 0;
    while i < N {
        out[i] = (nibble(b[start + 2 * i]) << 4) | nibble(b[start + 2 * i + 1]);
        i += 1;
    }
    out
}

const fn nibble(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => panic!("bad hex digit"),
    }
}
