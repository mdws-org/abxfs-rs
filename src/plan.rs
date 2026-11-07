//! Offline upload planning (SDK `plan.ts` `planChunk`, `planFile`, `planUploadOffline`).

use std::collections::HashSet;
#[cfg(unix)]
use std::path::Path;

use rayon::prelude::*;

use crate::chunking::chunk_bytes;
use crate::dir::{plan_directory_tree, validate_relative_path, PlannedDirectory};
use crate::fastlz;
use crate::ids::{chunk_id, file_cid, keccak256, Backend, H256, FASTLZ_BACKEND, RAW_BACKEND, SSTORE2_MAX_INPUT, ZERO};
use crate::ipfs;
use crate::mime::infer_mime_type;
use crate::nodes::{pack_chunk_tree, Tree};
#[cfg(unix)]
use crate::scan::{read_scanned, scan_directory, ScanOptions};
use crate::Result;

/// The backends a plan writes through; chunk ids are bound to these addresses.
#[derive(Clone, Copy, Debug)]
pub struct PlanBackends {
    pub raw: &'static Backend,
    /// `None` never compresses per chunk.
    pub fastlz: Option<&'static Backend>,
    pub max_input_size: usize,
}

impl Default for PlanBackends {
    fn default() -> Self {
        PlanBackends { raw: &RAW_BACKEND, fastlz: Some(&FASTLZ_BACKEND), max_input_size: SSTORE2_MAX_INPUT }
    }
}

#[derive(Clone, Debug)]
pub struct PlannedChunk {
    pub id: H256,
    pub backend: &'static Backend,
    /// The bytes handed to the backend when they differ from the data (FastLZ); `None` means input = data.
    pub packed: Option<Vec<u8>>,
    pub input_len: usize,
    pub input_hash: H256,
    pub data_hash: H256,
    /// Data length.
    pub size: u64,
}

#[derive(Clone, Debug)]
pub struct PlannedFile {
    pub path: String,
    pub cid: H256,
    pub mime_type: String,
    pub codec: H256,
    pub output_hash: H256,
    pub chunks: Vec<PlannedChunk>,
    pub tree: Tree,
    pub logical_size: u64,
    pub data_size: u64,
    pub stored_size: u64,
    pub ipfs_cid: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Plan {
    pub fastlz: bool,
    pub backends: PlanBackends,
    pub files: Vec<PlannedFile>,
    pub directories: Vec<PlannedDirectory>,
    pub root_cid: H256,
    pub unique_chunks: usize,
    pub stored_bytes: u64,
    pub logical_bytes: u64,
}

#[derive(Clone, Debug)]
pub struct PlanOptions {
    pub backends: PlanBackends,
    pub fastlz: bool,
    pub ipfs_cids: bool,
    pub empty_directories: Vec<String>,
}

impl Default for PlanOptions {
    fn default() -> Self {
        PlanOptions { backends: PlanBackends::default(), fastlz: true, ipfs_cids: true, empty_directories: Vec::new() }
    }
}

/// FastLZ backend when it strictly shrinks the chunk and fits the backend, else the raw backend.
pub fn plan_chunk(data: &[u8], backends: &PlanBackends, fastlz_on: bool) -> Result<PlannedChunk> {
    let max = backends.max_input_size;
    if data.is_empty() {
        return Err("a chunk holds at least one byte".into());
    }
    let mut backend = backends.raw;
    let mut packed = None;
    if let (Some(fb), true) = (backends.fastlz, fastlz_on) {
        let p = fastlz::compress(data);
        if p.len() < data.len() && p.len() <= max {
            backend = fb;
            packed = Some(p);
        }
    }
    let input: &[u8] = packed.as_deref().unwrap_or(data);
    if input.len() > max {
        return Err(format!("chunk input of {} bytes exceeds the backend's {max}", input.len()));
    }
    let input_hash = keccak256(input);
    let data_hash = if packed.is_some() { keccak256(data) } else { input_hash };
    Ok(PlannedChunk {
        id: chunk_id(&backend.address, &input_hash, &data_hash, data.len() as u64)?,
        backend,
        input_len: input.len(),
        packed,
        input_hash,
        data_hash,
        size: data.len() as u64,
    })
}

/// Plan one file with no file codec: chunk, choose a backend per chunk, pack, derive the CID.
pub fn plan_file(path: &str, bytes: &[u8], mime_type: &str, opts: &PlanOptions) -> Result<PlannedFile> {
    let backends = &opts.backends;
    let pieces = chunk_bytes(bytes, backends.max_input_size);
    let chunks: Vec<PlannedChunk> = if pieces.len() > 1 {
        pieces.par_iter().map(|&(s, e)| plan_chunk(&bytes[s..e], backends, opts.fastlz)).collect::<Result<_>>()?
    } else {
        pieces.iter().map(|&(s, e)| plan_chunk(&bytes[s..e], backends, opts.fastlz)).collect::<Result<_>>()?
    };
    let ids: Vec<H256> = chunks.iter().map(|c| c.id).collect();
    let sizes: Vec<u64> = chunks.iter().map(|c| c.size).collect();
    let tree = pack_chunk_tree(&ids, &sizes, path)?;
    let cid = file_cid(&tree.root, mime_type, &ZERO, &ZERO)?;
    let stored_size = chunks.iter().map(|c| c.input_len as u64).sum();
    let ipfs_cid = opts.ipfs_cids.then(|| ipfs::file_cid(bytes));
    Ok(PlannedFile {
        path: path.to_string(),
        cid,
        mime_type: mime_type.to_string(),
        codec: ZERO,
        output_hash: ZERO,
        chunks,
        tree,
        logical_size: bytes.len() as u64,
        data_size: bytes.len() as u64,
        stored_size,
        ipfs_cid,
    })
}

/// `assertUploadPaths`: valid relative paths, no backslash, each file path once.
pub fn assert_upload_paths<'a>(paths: impl IntoIterator<Item = &'a str>, empty_directories: &[String]) -> Result<()> {
    let mut seen = HashSet::new();
    for p in paths {
        validate_relative_path(p)?;
        if p.contains('\\') {
            return Err(format!("\"{p}\": names cannot contain a backslash"));
        }
        if !seen.insert(p) {
            return Err(format!("\"{p}\" is in this upload twice; every path must be unique"));
        }
    }
    for d in empty_directories {
        validate_relative_path(d)?;
        if d.contains('\\') {
            return Err(format!("\"{d}\": names cannot contain a backslash"));
        }
    }
    Ok(())
}

/// Fold planned files into directories and total what the upload stores.
pub fn assemble(files: Vec<PlannedFile>, opts: &PlanOptions) -> Result<Plan> {
    let pairs: Vec<(String, H256)> = files.iter().map(|f| (f.path.clone(), f.cid)).collect();
    let (root_cid, directories) = plan_directory_tree(&pairs, &opts.empty_directories)?;
    let mut seen: HashSet<H256> = HashSet::new();
    let mut stored_bytes = 0u64;
    let mut logical_bytes = 0u64;
    for f in &files {
        logical_bytes += f.logical_size;
        for c in &f.chunks {
            if seen.insert(c.id) {
                stored_bytes += c.input_len as u64;
            }
        }
    }
    Ok(Plan {
        fastlz: opts.fastlz,
        backends: opts.backends,
        files,
        directories,
        root_cid,
        unique_chunks: seen.len(),
        stored_bytes,
        logical_bytes,
    })
}

/// Plan in-memory files `(path, bytes, mime)`; an empty mime is inferred from the path.
pub fn plan_upload(files: &[(String, Vec<u8>, String)], opts: &PlanOptions) -> Result<Plan> {
    assert_upload_paths(files.iter().map(|f| f.0.as_str()), &opts.empty_directories)?;
    let planned = files
        .par_iter()
        .map(|(path, bytes, mime)| {
            let mime = if mime.is_empty() { infer_mime_type(path) } else { mime.clone() };
            plan_file(path, bytes, &mime, opts)
        })
        .collect::<Result<Vec<_>>>()?;
    assemble(planned, opts)
}

/// Scan a folder the way the official CLI does and plan it. With `include_empty_dirs`, the empty directories the
/// scan found are planned too, as `abxfs upload` passes them; without it, `opts.empty_directories` is used as given.
#[cfg(unix)]
pub fn plan_folder(root: &Path, scan: &ScanOptions, opts: &PlanOptions, include_empty_dirs: bool) -> Result<Plan> {
    let report = scan_directory(root, scan)?;
    let mut opts = opts.clone();
    if include_empty_dirs {
        opts.empty_directories = report.empty_directories.clone();
    }
    assert_upload_paths(report.files.iter().map(|f| f.path.as_str()), &opts.empty_directories)?;
    let planned = report
        .files
        .par_iter()
        .map(|f| {
            let bytes = read_scanned(f)?;
            plan_file(&f.path, &bytes, &infer_mime_type(&f.path), &opts)
        })
        .collect::<Result<Vec<_>>>()?;
    assemble(planned, &opts)
}

/// Largest integer a JS number holds exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_992.0;

/// Plan files already in memory, as a browser hands over a picked or dropped folder: relative `paths`, their
/// `sizes` (JS numbers), all bytes concatenated in that order, and the folder's directory paths (`dirs`, relative,
/// no trailing slash; empty when the source reports none). The CLI's selection rules apply; directories with no
/// kept file or directory inside are planned as empty directories. Paths and sizes are checked, not repaired.
pub fn plan_in_memory(paths: &[String], sizes: &[f64], data: &[u8], fastlz: bool, include_hidden: bool, dirs: &[String]) -> Result<Plan> {
    use crate::scan::{empty_directories, select_paths, ScanOptions};
    if paths.len() != sizes.len() {
        return Err("paths and sizes differ in length".into());
    }
    for p in paths.iter().chain(dirs) {
        validate_relative_path(p)?;
    }
    let mut ints = Vec::with_capacity(sizes.len());
    let mut offsets = Vec::with_capacity(sizes.len());
    let mut at = 0usize;
    for (s, p) in sizes.iter().zip(paths) {
        if !s.is_finite() || s.fract() != 0.0 || *s < 0.0 || *s >= MAX_SAFE_INTEGER {
            return Err(format!("\"{p}\" has an invalid size {s}"));
        }
        let n = *s as u64;
        let len = usize::try_from(n).map_err(|_| format!("\"{p}\" is too large to hold in memory here"))?;
        offsets.push(at);
        at = at.checked_add(len).ok_or("the file sizes add up to more than this build can hold")?;
        ints.push(n);
    }
    if at != data.len() {
        return Err("file sizes do not add up to the bytes given".into());
    }
    let scan = ScanOptions { include_hidden };
    let keep = select_paths(paths, &ints, &scan)?;
    let kept_paths: Vec<&str> = keep.iter().map(|&i| paths[i].as_str()).collect();
    let empty = empty_directories(dirs, &kept_paths, &scan);
    if keep.is_empty() && empty.is_empty() {
        return Err("nothing to upload: no files or empty directories left after the upload rules".into());
    }
    let files: Vec<(String, Vec<u8>, String)> = keep
        .iter()
        .map(|&i| (paths[i].clone(), data[offsets[i]..offsets[i] + ints[i] as usize].to_vec(), String::new()))
        .collect();
    let opts = PlanOptions { fastlz, empty_directories: empty, ..PlanOptions::default() };
    plan_upload(&files, &opts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hex::to_hex;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn only_empty_directories_match_the_cli() {
        // `abxfs upload <dir> --dry-run` on a folder holding a/b/ and c/ and nothing else.
        let plan = plan_in_memory(&[], &[], &[], true, false, &s(&["a", "a/b", "c"])).unwrap();
        assert_eq!(to_hex(&plan.root_cid), "0x0ded93b17b5419bf515e1e51b19242897bbcea7f77d27e69df29aee59115957f");
        assert_eq!(plan.directories.len(), 4);
    }

    #[test]
    fn nothing_left_is_refused() {
        assert!(plan_in_memory(&[], &[], &[], true, false, &[]).is_err());
        assert!(plan_in_memory(&[], &[], &[], true, false, &s(&[".hid", "node_modules"])).is_err());
    }

    #[test]
    fn bad_sizes_are_refused() {
        for bad in [f64::NAN, f64::INFINITY, -1.0, 1.5, MAX_SAFE_INTEGER] {
            assert!(plan_in_memory(&s(&["x"]), &[bad], &[0], true, false, &[]).is_err(), "{bad}");
        }
        assert!(plan_in_memory(&s(&["x"]), &[2.0], &[0], true, false, &[]).is_err());
        assert!(plan_in_memory(&s(&["x"]), &[1.0], &[0], true, false, &[]).is_ok());
    }

    #[test]
    fn bad_paths_are_refused_not_dropped() {
        for p in ["", "/x", "a//b", "./x", "a/../x", "a/.", "x/"] {
            assert!(plan_in_memory(&s(&[p, "ok"]), &[1.0, 1.0], &[0, 0], true, false, &[]).is_err(), "file {p:?}");
            assert!(plan_in_memory(&s(&["ok"]), &[1.0], &[0], true, false, &s(&[p])).is_err(), "dir {p:?}");
        }
    }
}
