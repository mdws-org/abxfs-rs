//! FastCDC with a 32-bit Gear hash (SDK `chunking/fastcdc.ts`, `chunking/gear-table.ts`).

/// Mulberry32 seeded with `0xba5e5eed`; entry `i` is the `i`-th output.
pub const GEAR: [u32; 256] = build_gear();

const fn build_gear() -> [u32; 256] {
    let mut out = [0u32; 256];
    let mut s: u32 = 0xba5e_5eed;
    let mut i = 0;
    while i < 256 {
        s = s.wrapping_add(0x6d2b_79f5);
        let mut t = s;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        out[i] = t ^ (t >> 14);
        i += 1;
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Params {
    pub min: usize,
    pub target: usize,
    pub hard_max: usize,
}

/// `{ min: floor(max/2), target: floor(max*3/4), hardMax: max }`.
pub fn default_params_for(max: usize) -> Params {
    assert!(max > 0, "max chunk size must be positive");
    Params { min: max / 2, target: max * 3 / 4, hard_max: max }
}

fn masks(target: usize) -> (u32, u32) {
    let log2 = usize::BITS - 1 - target.max(2).leading_zeros();
    let strict = log2 + 1;
    let loose = log2.saturating_sub(1).max(1);
    ((1u32 << strict) - 1, (1u32 << loose) - 1)
}

/// Cut points: returns `(start, end)` byte ranges covering `bytes` in order.
pub fn fastcdc_split(bytes: &[u8], p: Params) -> Vec<(usize, usize)> {
    let n = bytes.len();
    if n == 0 {
        return Vec::new();
    }
    if n <= p.min {
        return vec![(0, n)];
    }
    let (strict_mask, loose_mask) = masks(p.target);
    let mut out = Vec::with_capacity(n / p.target + 2);
    let mut pos = 0;
    while pos < n {
        if n - pos <= p.min {
            out.push((pos, n));
            break;
        }
        let target_end = (pos + p.target).min(n);
        let hard_end = (pos + p.hard_max).min(n);
        let mut h: u32 = 0;
        let mut cut = None;
        let mut i = pos + p.min;
        while i < target_end {
            h = (h << 1) ^ GEAR[bytes[i] as usize];
            if h & strict_mask == 0 {
                cut = Some(i + 1);
                break;
            }
            i += 1;
        }
        if cut.is_none() {
            while i < hard_end {
                h = (h << 1) ^ GEAR[bytes[i] as usize];
                if h & loose_mask == 0 {
                    cut = Some(i + 1);
                    break;
                }
                i += 1;
            }
        }
        let cut = cut.unwrap_or(hard_end);
        out.push((pos, cut));
        pos = cut;
    }
    out
}

/// `chunkBytes(bytes, { backendMax })`.
pub fn chunk_bytes(bytes: &[u8], backend_max: usize) -> Vec<(usize, usize)> {
    fastcdc_split(bytes, default_params_for(backend_max))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gear_check_values() {
        assert_eq!(
            &GEAR[..8],
            &[0xdfdc2d53, 0xaa637a57, 0xd20ff763, 0x682331f8, 0xfe950442, 0x441c029e, 0x4f2e6f0f, 0x23e06a5d]
        );
        assert_eq!(GEAR[255], 0xc4b3875b);
        assert_eq!(GEAR.iter().fold(0u32, |a, &g| a ^ g), 0x59df477b);
        assert_eq!(GEAR.iter().fold(0u32, |a, &g| a.wrapping_add(g)), 0x3e55e013);
    }

    #[test]
    fn params_and_masks() {
        let p = default_params_for(24_575);
        assert_eq!(p, Params { min: 12_287, target: 18_431, hard_max: 24_575 });
        assert_eq!(masks(p.target), (0x7fff, 0x1fff));
    }
}
