//! Compare a local folder (or file), planned offline, with a root on chain.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use crate::abi::Address;
use crate::chain::{Client, CHUNK_STORE, DIRECTORY_STORE, FILE_STORE};
use crate::codec::codec_name;
use crate::ids::H256;
use crate::mime::infer_mime_type;
use crate::plan::{plan_file, plan_folder, PlanOptions, PlannedFile};
use crate::read::{exists_many, file_infos, read_tree, Kind};
use crate::scan::{ScanOptions, MAX_READ_FILE_BYTES};
use crate::Result;

/// What a local path plans to: every path's kind and CID, and every object the root needs on chain.
pub struct LocalPlan {
    pub root: H256,
    pub paths: BTreeMap<Vec<u8>, (Kind, H256)>,
    /// Each planned file's MIME type, by path.
    pub mimes: BTreeMap<Vec<u8>, String>,
    /// `(store, existence view, id, what)`, each id once.
    pub objects: Vec<(Address, &'static str, H256, &'static str)>,
}

#[derive(Default)]
struct Objects {
    seen: HashSet<(Address, &'static str, H256)>,
    list: Vec<(Address, &'static str, H256, &'static str)>,
}

impl Objects {
    fn add(&mut self, store: Address, sig: &'static str, id: H256, what: &'static str) {
        if self.seen.insert((store, sig, id)) {
            self.list.push((store, sig, id, what));
        }
    }

    fn add_file(&mut self, f: &PlannedFile) {
        self.add(FILE_STORE, "fileExists(bytes32)", f.cid, "file");
        for n in &f.tree.nodes {
            self.add(FILE_STORE, "nodeExists(bytes32)", n.id, "chunk node");
        }
        for c in &f.chunks {
            self.add(CHUNK_STORE, "exists(bytes32)", c.id, "chunk");
        }
    }
}

/// Plan `path` offline: a folder as `abxfs upload` would (empty directories included), a single file under its own
/// name.
pub fn plan_local(path: &Path, scan: &ScanOptions, opts: &PlanOptions) -> Result<LocalPlan> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut paths = BTreeMap::new();
    let mut mimes = BTreeMap::new();
    let mut objects = Objects::default();
    let root = if meta.is_file() {
        let name = path.file_name().and_then(|n| n.to_str()).ok_or("the file name is not UTF-8")?;
        let bytes = read_capped(path)?;
        let f = plan_file(name, &bytes, &infer_mime_type(name), opts)?;
        paths.insert(Vec::new(), (Kind::File, f.cid));
        mimes.insert(Vec::new(), f.mime_type.clone());
        objects.add_file(&f);
        f.cid
    } else {
        let plan = plan_folder(path, scan, opts, true)?;
        for f in &plan.files {
            paths.insert(f.path.as_bytes().to_vec(), (Kind::File, f.cid));
            mimes.insert(f.path.as_bytes().to_vec(), f.mime_type.clone());
            objects.add_file(f);
        }
        for d in &plan.directories {
            paths.insert(d.path.as_bytes().to_vec(), (Kind::Directory, d.cid));
            objects.add(DIRECTORY_STORE, "directoryExists(bytes32)", d.cid, "directory");
            for n in &d.tree.nodes {
                objects.add(DIRECTORY_STORE, "nodeExists(bytes32)", n.id, "entry node");
            }
        }
        plan.root_cid
    };
    Ok(LocalPlan { root, paths, mimes, objects: objects.list })
}

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum DiffKind {
    /// Local has it, the chain root does not.
    Missing,
    /// The chain root has it, local does not.
    Extra,
    /// Both have it with another kind or another CID.
    Changed,
}

#[derive(Debug)]
pub struct Diff {
    pub kind: DiffKind,
    pub path: Vec<u8>,
    pub local: Option<(Kind, H256)>,
    pub chain: Option<(Kind, H256)>,
}

pub struct Report {
    pub local_root: H256,
    pub chain_root: H256,
    /// Objects the plan needs that the chain lacks (only checked when the roots match).
    pub absent: Vec<(&'static str, H256)>,
    pub probed: usize,
    /// Path differences (only computed when the roots differ).
    pub diffs: Vec<Diff>,
    /// Files whose CIDs differ only because the chain stores them with a file codec: `(path, codec)`. The chain's
    /// decoded content equals the local file.
    pub encoded_same: Vec<(Vec<u8>, String)>,
}

impl Report {
    /// Roots equal with every object present, or roots differing only through files stored codec-encoded.
    pub fn ok(&self) -> bool {
        if self.local_root == self.chain_root {
            self.absent.is_empty()
        } else {
            self.diffs.is_empty() && !self.encoded_same.is_empty()
        }
    }
}

/// Read a local file, refusing one larger than the scanner reads of one file.
fn read_capped(p: &Path) -> Result<Vec<u8>> {
    use std::io::Read;
    let f = std::fs::File::open(p).map_err(|e| format!("{}: {e}", p.display()))?;
    let mut buf = Vec::new();
    f.take(MAX_READ_FILE_BYTES + 1).read_to_end(&mut buf).map_err(|e| format!("{}: {e}", p.display()))?;
    if buf.len() as u64 > MAX_READ_FILE_BYTES {
        return Err(format!("{} is more than the {MAX_READ_FILE_BYTES} bytes the CLI reads of one file", p.display()));
    }
    Ok(buf)
}

/// The local file at a chain path: `local` itself for a single-file root, otherwise `local/<path>`.
fn local_file(local: &Path, path: &[u8]) -> Result<Vec<u8>> {
    let p = if path.is_empty() {
        local.to_path_buf()
    } else {
        local.join(std::str::from_utf8(path).map_err(|_| "a planned path is not UTF-8")?)
    };
    read_capped(&p)
}

/// `dir` is `path` itself or one of its ancestors (`""` is the root, every path's ancestor).
fn is_under(path: &[u8], dir: &[u8]) -> bool {
    dir.is_empty() || (path.len() > dir.len() && path.starts_with(dir) && path[dir.len()] == b'/')
}

/// Takes out of `diffs` every changed file the chain stores with a file codec, under the MIME type the local plan
/// gives it, and whose decoded content (read and checked against its outputHash) equals the local file; then every
/// changed directory with such a file under it, since that file's CID explains the directory's.
fn split_encoded(client: &Client, local: &Path, mimes: &BTreeMap<Vec<u8>, String>, opts: &PlanOptions, diffs: Vec<Diff>) -> Result<(Vec<Diff>, Vec<(Vec<u8>, String)>)> {
    let both_files = |d: &Diff| d.kind == DiffKind::Changed && matches!((d.local, d.chain), (Some((Kind::File, _)), Some((Kind::File, _))));
    let cids: Vec<H256> = diffs.iter().filter(|d| both_files(d)).map(|d| d.chain.unwrap().1).collect();
    if cids.is_empty() {
        return Ok((diffs, Vec::new()));
    }
    let mut codecs: BTreeMap<H256, (String, Vec<u8>)> = BTreeMap::new();
    for (cid, info) in cids.iter().zip(file_infos(client, &cids)?) {
        if let Some(name) = codec_name(&info.codec)? {
            codecs.insert(*cid, (name, info.mime));
        }
    }
    let mut kept = Vec::new();
    let mut same = Vec::new();
    for d in diffs {
        let codec = if both_files(&d) { codecs.get(&d.chain.unwrap().1) } else { None };
        let Some((codec, chain_mime)) = codec else {
            kept.push(d);
            continue;
        };
        if mimes.get(&d.path).map(|m| m.as_bytes()) != Some(chain_mime.as_slice()) {
            kept.push(d);
            continue;
        }
        let cid = d.chain.unwrap().1;
        let tree = read_tree(client, &cid, true)?;
        let chain_bytes = tree.files.get(&cid).and_then(|f| f.content.as_ref()).ok_or_else(|| format!("file {} was not read", crate::hex::to_hex(&cid)))?;
        // The bytes compared must be the bytes planned: a file replaced since planning plans to another CID.
        let local_bytes = local_file(local, &d.path)?;
        let planned_cid = d.local.unwrap().1;
        let mime = std::str::from_utf8(chain_mime).map_err(|_| "the chain MIME type is not UTF-8")?;
        if plan_file(&String::from_utf8_lossy(&d.path), &local_bytes, mime, opts)?.cid != planned_cid {
            return Err(format!("{} changed after it was planned; run verify again", String::from_utf8_lossy(&d.path)));
        }
        if *chain_bytes == local_bytes {
            same.push((d.path, codec.clone()));
        } else {
            kept.push(d);
        }
    }
    let explained = |d: &Diff| {
        d.kind == DiffKind::Changed
            && matches!((d.local, d.chain), (Some((Kind::Directory, _)), Some((Kind::Directory, _))))
            && same.iter().any(|(p, _)| is_under(p, &d.path))
    };
    kept.retain(|d| !explained(d));
    Ok((kept, same))
}

pub fn verify(client: &Client, chain_root: &H256, local: &Path, scan: &ScanOptions, opts: &PlanOptions) -> Result<Report> {
    let plan = plan_local(local, scan, opts)?;
    if plan.root == *chain_root {
        let probes: Vec<(Address, &str, H256)> = plan.objects.iter().map(|o| (o.0, o.1, o.2)).collect();
        let found = exists_many(client, &probes)?;
        let absent = plan.objects.iter().zip(found).filter(|(_, f)| !f).map(|(o, _)| (o.3, o.2)).collect();
        return Ok(Report { local_root: plan.root, chain_root: *chain_root, absent, probed: probes.len(), diffs: Vec::new(), encoded_same: Vec::new() });
    }
    let tree = read_tree(client, chain_root, false)?;
    let chain: BTreeMap<Vec<u8>, (Kind, H256)> = tree.paths()?.into_iter().map(|p| (p.path, (p.kind, p.cid))).collect();
    let mut keys: Vec<&Vec<u8>> = plan.paths.keys().chain(chain.keys()).collect();
    keys.sort();
    keys.dedup();
    let mut diffs = Vec::new();
    for k in keys {
        let l = plan.paths.get(k).copied();
        let c = chain.get(k).copied();
        let kind = match (l, c) {
            (Some(_), None) => DiffKind::Missing,
            (None, Some(_)) => DiffKind::Extra,
            (Some((lk, lc)), Some((ck, cc))) => {
                if lk != ck || lc != cc {
                    DiffKind::Changed
                } else {
                    continue;
                }
            }
            (None, None) => unreachable!(),
        };
        diffs.push(Diff { kind, path: k.clone(), local: l, chain: c });
    }
    let (diffs, encoded_same) = split_encoded(client, local, &plan.mimes, opts, diffs)?;
    Ok(Report { local_root: plan.root, chain_root: *chain_root, absent: Vec::new(), probed: 0, diffs, encoded_same })
}
