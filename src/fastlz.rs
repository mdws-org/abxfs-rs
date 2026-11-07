//! FastLZ level 1, byte-identical to Solady `LibZip.flzCompress` (SDK `fastlz.ts`), not ariya's reference.

const HASH_SIZE: usize = 0x2000;

#[inline(always)]
fn u24(d: &[u8], p: usize) -> u32 {
    d[p] as u32 | (d[p + 1] as u32) << 8 | (d[p + 2] as u32) << 16
}

#[inline(always)]
fn hash(v: u32) -> usize {
    (((2_654_435_769u64 * v as u64) >> 19) & 0x1fff) as usize
}

fn literals(out: &mut Vec<u8>, d: &[u8], mut runs: usize, mut src: usize) {
    while runs >= 0x20 {
        out.push(0x1f);
        out.extend_from_slice(&d[src..src + 0x20]);
        src += 0x20;
        runs -= 0x20;
    }
    if runs == 0 {
        return;
    }
    out.push((runs - 1) as u8);
    out.extend_from_slice(&d[src..src + runs]);
}

fn mt(out: &mut Vec<u8>, mut l: usize, d: usize) {
    let d = d - 1;
    let hi = (d >> 8) as u8;
    let lo = (d & 0xff) as u8;
    while l >= 263 {
        out.extend_from_slice(&[224 + hi, 253, lo]);
        l -= 262;
    }
    if l >= 7 {
        out.extend_from_slice(&[224 + hi, (l - 7) as u8, lo]);
        return;
    }
    out.extend_from_slice(&[((l as u8) << 5) + hi, lo]);
}

/// Length of the common run at `p`/`q` up to `e`, plus one when it ends on a mismatch (Solady's convention).
#[inline(always)]
fn cmp(d: &[u8], p: usize, q: usize, e: usize) -> usize {
    let e = e - q;
    let mut l = 0;
    while l < e {
        if d[p + l] != d[q + l] {
            return l + 1;
        }
        l += 1;
    }
    l
}

pub fn compress(d: &[u8]) -> Vec<u8> {
    let len = d.len();
    let mut out = Vec::with_capacity(len + len / 32 + 2);
    let mut htab = vec![0u32; HASH_SIZE];
    let ip_limit = len as i64 - 13;
    let mut a: usize = 0;
    let mut ip: usize = 2;
    while (ip as i64) < ip_limit {
        let mut r: usize;
        let mut dist: usize;
        loop {
            let s = u24(d, ip);
            let h = hash(s);
            r = htab[h] as usize;
            htab[h] = ip as u32;
            dist = ip - r;
            if (ip as i64) >= ip_limit {
                break;
            }
            ip += 1;
            if dist <= 0x1fff && s == u24(d, r) {
                break;
            }
        }
        if (ip as i64) >= ip_limit {
            break;
        }
        ip -= 1;
        if ip > a {
            literals(&mut out, d, ip - a, a);
        }
        let l = cmp(d, r + 3, ip + 3, (ip_limit + 9) as usize);
        mt(&mut out, l, dist);
        let p = ip + l;
        htab[hash(u24(d, p))] = p as u32;
        htab[hash(u24(d, p + 1))] = (p + 1) as u32;
        ip = p + 2;
        a = ip;
    }
    literals(&mut out, d, len - a, a);
    out
}

/// Inflate a stream `compress` emits. Refuses truncated runs and back-references before the output start.
pub fn decompress(data: &[u8]) -> crate::Result<Vec<u8>> {
    let mut out: Vec<u8> = Vec::with_capacity(data.len() * 4);
    let n = data.len();
    let mut i = 0;
    while i < n {
        let c = data[i] as usize;
        let t = c >> 5;
        if t == 0 {
            let runs = c + 1;
            if i + 1 + runs > n {
                return Err("fastlz: truncated literal run".into());
            }
            out.extend_from_slice(&data[i + 1..i + 1 + runs]);
            i += 2 + c;
        } else {
            let g = usize::from(t == 7);
            if i + 1 + g >= n {
                return Err("fastlz: truncated back-reference".into());
            }
            let l = if g == 1 { 9 + data[i + 1] as usize } else { 2 + t };
            let s = ((c & 0x1f) << 8) + data[i + 1 + g] as usize + 1;
            if s > out.len() {
                return Err("fastlz: back-reference before start of output".into());
            }
            let from = out.len() - s;
            for k in 0..l {
                let b = out[from + k];
                out.push(b);
            }
            i += 2 + g;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_inputs_are_literals() {
        for n in 0..=15usize {
            let d: Vec<u8> = (0..n as u8).collect();
            let c = compress(&d);
            assert_eq!(c.len(), if n == 0 { 0 } else { n + 1 });
        }
    }

    #[test]
    fn round_trip() {
        let mut s: u32 = 1;
        let mut d = Vec::new();
        for i in 0..100_000u32 {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            d.push(if i % 7 < 3 { (s & 0xff) as u8 } else { b'a' + (i % 5) as u8 });
        }
        d.extend(std::iter::repeat(0u8).take(5000));
        assert_eq!(decompress(&compress(&d)).unwrap(), d);
    }
}
