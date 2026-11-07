//! Folder walk with the official CLI's selection rules (`@artblocks/abxfs-cli` `fsscan.js`, SDK `upload-skip.ts`).
//!
//! Symlinks are never followed; names in the ignore list are skipped wherever they appear; dot-names are skipped
//! unless hidden files are included, except `.well-known`. Files are listed in JS string order of their paths
//! (UTF-16 code units), as the CLI sorts them.

use std::cmp::Ordering;
use std::collections::HashSet;
#[cfg(unix)]
use std::fs;
#[cfg(unix)]
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
#[cfg(unix)]
use std::path::Path;
use std::path::PathBuf;

use crate::Result;

pub const UPLOAD_IGNORE_NAMES: &[&str] = &["node_modules", ".DS_Store", "dist", "build", "out", ".next", ".turbo", "cache", "broadcast"];
pub const UPLOAD_VCS_NAMES: &[&str] = &[".git"];
pub const UPLOAD_DOT_ALLOWLIST: &[&str] = &[".well-known"];

/// Most the CLI reads of one file.
pub const MAX_READ_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// Most the CLI reads for one upload.
pub const MAX_TOTAL_READ_BYTES: u64 = 1024 * 1024 * 1024;

#[cfg(target_os = "linux")]
const O_NOFOLLOW: i32 = 0o400000;
#[cfg(all(unix, not(target_os = "linux")))]
const O_NOFOLLOW: i32 = 0x0100;

#[derive(Clone, Debug, Default)]
pub struct ScanOptions {
    pub include_hidden: bool,
}

#[derive(Clone, Debug)]
pub struct ScannedFile {
    /// POSIX path relative to the root.
    pub path: String,
    pub abs: PathBuf,
    pub size: u64,
    pub dev: u64,
    pub ino: u64,
}

#[derive(Clone, Debug, Default)]
pub struct ScanReport {
    pub files: Vec<ScannedFile>,
    pub empty_directories: Vec<String>,
    pub skipped_symlinks: Vec<String>,
    pub skipped_hidden: Vec<String>,
}

/// JS `a < b` on strings: UTF-16 code unit order.
pub fn js_string_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// The walk's selection rules applied to relative file paths that are already in hand (a browser file picker):
/// ignored names in any segment, dot-names unless `include_hidden` (`.well-known` always kept), and the read
/// limits. Returns the kept indices in JS string order of their paths.
pub fn select_paths(paths: &[String], sizes: &[u64], opts: &ScanOptions) -> Result<Vec<usize>> {
    let mut ignore: Vec<&str> = UPLOAD_IGNORE_NAMES.to_vec();
    if !opts.include_hidden {
        ignore.extend_from_slice(UPLOAD_VCS_NAMES);
    }
    let mut kept = Vec::new();
    let mut total = 0u64;
    for (i, path) in paths.iter().enumerate() {
        let skip = path.split('/').any(|seg| {
            ignore.contains(&seg)
                || (seg.starts_with('.') && !opts.include_hidden && !UPLOAD_DOT_ALLOWLIST.contains(&seg))
        });
        if skip {
            continue;
        }
        let size = sizes.get(i).copied().unwrap_or(0);
        if size > MAX_READ_FILE_BYTES {
            return Err(format!("\"{path}\" is {size} bytes, more than the {MAX_READ_FILE_BYTES} the CLI reads of one file"));
        }
        if total + size > MAX_TOTAL_READ_BYTES {
            return Err(format!("the files to upload add up to more than {MAX_TOTAL_READ_BYTES} bytes (at \"{path}\")"));
        }
        total += size;
        kept.push(i);
    }
    kept.sort_by(|&a, &b| js_string_cmp(&paths[a], &paths[b]));
    Ok(kept)
}

/// The directories the walk would report as empty, from relative directory paths already in hand (a dropped
/// folder): a directory is kept unless a segment is ignored or hidden, and empty when no kept file and no kept
/// directory lies inside it. `kept_files` are the paths `select_paths` kept. Sorted in JS string order.
pub fn empty_directories(dirs: &[String], kept_files: &[&str], opts: &ScanOptions) -> Vec<String> {
    let mut ignore: Vec<&str> = UPLOAD_IGNORE_NAMES.to_vec();
    if !opts.include_hidden {
        ignore.extend_from_slice(UPLOAD_VCS_NAMES);
    }
    let kept = |p: &str| {
        !p.is_empty()
            && !p.split('/').any(|seg| {
                ignore.contains(&seg)
                    || (seg.starts_with('.') && !opts.include_hidden && !UPLOAD_DOT_ALLOWLIST.contains(&seg))
            })
    };
    let kept_dirs: Vec<&str> = dirs.iter().map(|d| d.trim_end_matches('/')).filter(|d| kept(d)).collect();
    // Every proper ancestor of a kept file or kept directory holds something, so it is not empty.
    let mut holders: HashSet<&str> = HashSet::new();
    for p in kept_files.iter().copied().chain(kept_dirs.iter().copied()) {
        for (i, b) in p.bytes().enumerate() {
            if b == b'/' {
                holders.insert(&p[..i]);
            }
        }
    }
    let mut out: Vec<String> = kept_dirs.iter().filter(|d| !holders.contains(**d)).map(|d| d.to_string()).collect();
    out.sort_by(|a, b| js_string_cmp(a, b));
    out.dedup();
    out
}

#[cfg(unix)]
pub fn scan_directory(root: &Path, opts: &ScanOptions) -> Result<ScanReport> {
    let meta = fs::symlink_metadata(root).map_err(|e| format!("{}: {e}", root.display()))?;
    if meta.file_type().is_symlink() {
        return Err(format!("refusing to use upload root \"{}\": it is a symlink; pass the real path", root.display()));
    }
    if !meta.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }
    let mut ignore: Vec<&str> = UPLOAD_IGNORE_NAMES.to_vec();
    if !opts.include_hidden {
        ignore.extend_from_slice(UPLOAD_VCS_NAMES);
    }
    let mut report = ScanReport::default();
    let mut total = 0u64;
    walk(root, "", &ignore, opts.include_hidden, &mut report, &mut total)?;
    report.files.sort_by(|a, b| js_string_cmp(&a.path, &b.path));
    report.empty_directories.sort_by(|a, b| js_string_cmp(a, b));
    Ok(report)
}

#[cfg(unix)]
fn walk(dir: &Path, rel_dir: &str, ignore: &[&str], include_hidden: bool, out: &mut ScanReport, total: &mut u64) -> Result<usize> {
    let mut names = Vec::new();
    for ent in fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))? {
        let ent = ent.map_err(|e| format!("{}: {e}", dir.display()))?;
        let name = ent
            .file_name()
            .into_string()
            .map_err(|n| format!("{}: name {:?} is not UTF-8", dir.display(), n))?;
        names.push(name);
    }
    names.sort();
    let mut kept = 0;
    for name in names {
        if ignore.contains(&name.as_str()) {
            continue;
        }
        let abs = dir.join(&name);
        let rel = if rel_dir.is_empty() { name.clone() } else { format!("{rel_dir}/{name}") };
        let st = fs::symlink_metadata(&abs).map_err(|e| format!("{rel}: {e}"))?;
        let ft = st.file_type();
        if ft.is_symlink() {
            out.skipped_symlinks.push(rel);
            continue;
        }
        if name.starts_with('.') && !include_hidden && !UPLOAD_DOT_ALLOWLIST.contains(&name.as_str()) {
            out.skipped_hidden.push(rel);
            continue;
        }
        if ft.is_dir() {
            if walk(&abs, &rel, ignore, include_hidden, out, total)? == 0 {
                out.empty_directories.push(rel);
            }
            kept += 1;
        } else if ft.is_file() {
            let size = st.len();
            if size > MAX_READ_FILE_BYTES {
                return Err(format!("\"{rel}\" is {size} bytes, more than the {MAX_READ_FILE_BYTES} the CLI reads of one file"));
            }
            if *total + size > MAX_TOTAL_READ_BYTES {
                return Err(format!("the files to upload add up to more than {MAX_TOTAL_READ_BYTES} bytes (at \"{rel}\")"));
            }
            *total += size;
            out.files.push(ScannedFile { path: rel, abs, size, dev: st.dev(), ino: st.ino() });
            kept += 1;
        }
    }
    Ok(kept)
}

/// Read a scanned file without following a symlink swapped in since the scan, and require the same inode.
#[cfg(unix)]
pub fn read_scanned(f: &ScannedFile) -> Result<Vec<u8>> {
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(O_NOFOLLOW)
        .open(&f.abs)
        .map_err(|e| format!("{}: {e}", f.path))?;
    let st = file.metadata().map_err(|e| format!("{}: {e}", f.path))?;
    if !st.is_file() || st.dev() != f.dev || st.ino() != f.ino {
        return Err(format!("\"{}\" changed while it was being scanned; refusing to read it", f.path));
    }
    let mut buf = Vec::with_capacity(st.len() as usize);
    file.read_to_end(&mut buf).map_err(|e| format!("{}: {e}", f.path))?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_directories_by_ancestors() {
        let dirs: Vec<String> = ["empty", "nested", "nested/empty2", "full", "full/sub", "hiddenonly", "node_modules", "node_modules/x", "fullish"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let files = ["full/sub/a.txt", "fullish/b.txt"];
        let got = empty_directories(&dirs, &files, &ScanOptions::default());
        assert_eq!(got, vec!["empty", "hiddenonly", "nested/empty2"]);
    }
}
