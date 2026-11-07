//! File-level codecs on the read side (SDK `compression.ts`): a label is a lowercase ASCII token, left-aligned and
//! zero-padded to 32 bytes. A decoded file is accepted only when `keccak256(content) == outputHash`.

use std::io::Read;

use crate::ids::H256;
use crate::Result;

/// Most bytes one file decodes to (the SDK's `DEFAULT_MAX_INFLATE_BYTES`).
pub const MAX_INFLATE_BYTES: u64 = 256 * 1024 * 1024;

/// The token of a codec label; `None` for zero. Refuses a label that is not a padded lowercase token.
pub fn codec_name(label: &H256) -> Result<Option<String>> {
    let end = label.iter().position(|&b| b == 0).unwrap_or(32);
    if label[end..].iter().any(|&b| b != 0) {
        return Err(format!("codec label {} is not zero-padded after its token", crate::hex::to_hex(label)));
    }
    if end == 0 {
        return Ok(None);
    }
    let tok = &label[..end];
    if !tok.iter().all(|&c| matches!(c, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'+' | b'-')) {
        return Err(format!("codec label {} does not hold a lowercase ASCII token", crate::hex::to_hex(label)));
    }
    Ok(Some(String::from_utf8(tok.to_vec()).unwrap()))
}

fn read_capped(r: impl Read, name: &str) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    r.take(MAX_INFLATE_BYTES + 1).read_to_end(&mut out).map_err(|e| format!("{name} decode failed: {e}"))?;
    if out.len() as u64 > MAX_INFLATE_BYTES {
        return Err(format!("{name} output exceeds {MAX_INFLATE_BYTES} bytes"));
    }
    Ok(out)
}

/// Decode `data` stored under codec `name` (gzip, deflate as zlib-wrapped, br, zstd).
pub fn decode(name: &str, data: &[u8]) -> Result<Vec<u8>> {
    match name {
        "gzip" => read_capped(flate2::read::MultiGzDecoder::new(data), name),
        "deflate" => read_capped(flate2::read::ZlibDecoder::new(data), name),
        "br" => read_capped(brotli_decompressor::Decompressor::new(data, 64 * 1024), name),
        "zstd" => {
            let d = ruzstd::decoding::StreamingDecoder::new(data).map_err(|e| format!("zstd decode failed: {e}"))?;
            read_capped(d, name)
        }
        other => Err(format!("no decoder for file codec \"{other}\"")),
    }
}
