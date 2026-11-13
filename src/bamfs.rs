//! A reader for BAMFS, the file store ABX FS grew out of, in both of its generations. Projects published before ABX
//! FS keep their root in the token parameter "bamfs.cid" and their files in these older store contracts. Every
//! reply is checked back to the root. `H` is keccak-256.
//!
//!   second generation (FileStoreV2, DirectoryStoreV2): trees of nodes
//!     directory CID = H(0x12 . root node id)        entry node id = H(0x22 . blob)
//!     file CID      = H(0x11 . root node id . H(mime) . compression . outputHash)     chunk node id = H(0x21 . blob)
//!   first generation (FileStore, DirectoryStore): flat lists
//!     directory CID = H(0x02 . H(entry hashes))     entry hash = H(H(name) . child CID . isDirectory)
//!     file CID      = H(0x01 . H(chunk hashes) . H(mime) . compression . outputHash)
//!   both: chunk hash = H(backend address . stored bytes); outputHash = H(the file's bytes) when it is compressed.
//!
//! This follows the from-chain viewer's `site/bamfs.js` rule for rule, so the two can be compared on the same roots.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::json;

use crate::hex::{from_hex, to_hex};
use crate::ids::keccak256;
use crate::rpc::Rpc;
use crate::Result;

type H256 = [u8; 32];

const CONTENT_STORE: &str = "0xd4a0ffa88a58ee7bb7e802e7079ee90c8da52250";
const BACKEND: [u8; 20] = [0x91, 0x52, 0x0c, 0xda, 0xaa, 0xb4, 0x42, 0x67, 0xe9, 0x9d, 0x08, 0xfe, 0xa7, 0x73, 0x0d, 0x7a, 0x7c, 0x60, 0xe9, 0xc2];
const FILES2: &str = "0x13036662e483335ff9c6f30e8852a4694e9a2154";
const DIRS2: &str = "0xb9411b8fc6fa3cce85efb6dd3ffa11f83a54ef72";
const FILES1: &str = "0xaa79ce91da95367fd79bf5d718b055d31eb9cfd3";
const DIRS1: &str = "0x16fa2ecac2b898fb91dc17bae843c7d0e6d8531f";
const MAX_ENTRIES: usize = 4096;
const MAX_NODES: usize = 4096;
const MAX_CHUNKS: usize = 16_384;
const MAX_FILE_BYTES: usize = 64 * 1024 * 1024;
const MAX_DEPTH: usize = 32;
const MAX_CALLS: u64 = 6000;

/// One file of a BAMFS tree, as checked bytes.
pub struct File {
    /// Path under the root, '/'-separated; "" when the root is a file.
    pub path: String,
    pub mime: String,
    /// Shared between paths that name the same file.
    pub content: Arc<Vec<u8>>,
}

/// Everything under a BAMFS root that can be opened. Entries whose names cannot be a path part are listed in
/// `unusable` and not read.
pub struct Tree {
    pub is_file: bool,
    pub generation: u8,
    pub dirs: Vec<String>,
    pub files: Vec<File>,
    pub unusable: Vec<String>,
    /// Bytes of distinct file contents held.
    pub bytes: usize,
    /// What every check rested on, for an archive bundle.
    pub evidence: Evidence,
}

/// The records and blobs a BAMFS read checked, keyed by id or CID, with names and types as the raw bytes stored.
#[derive(Default)]
pub struct Evidence {
    pub dir_roots: HashMap<H256, H256>,
    pub dir_entries: HashMap<H256, Vec<(Vec<u8>, bool, H256)>>,
    pub nodes: HashMap<H256, Vec<u8>>,
    pub files: HashMap<H256, FileEvidence>,
    pub chunks: HashMap<H256, Vec<u8>>,
}

#[derive(Clone)]
pub struct FileEvidence {
    pub root: H256,
    pub chunk_ids: Vec<H256>,
    pub mime: Vec<u8>,
    pub compression: u8,
    pub output_hash: H256,
    pub size: usize,
}

fn h(parts: &[&[u8]]) -> H256 {
    keccak256(&parts.concat())
}

fn sel(sig: &str) -> String {
    to_hex(&keccak256(sig.as_bytes())[..4]).trim_start_matches("0x").to_string()
}

struct Ctx<'a> {
    rpc: &'a Rpc,
    block: String,
    calls: AtomicU64,
    ev: &'a std::cell::RefCell<Evidence>,
}

impl Ctx<'_> {
    fn eth(&self, to: &str, sig: &str, arg: &H256) -> Result<Vec<u8>> {
        if self.calls.fetch_add(1, Ordering::Relaxed) >= MAX_CALLS {
            return Err(format!("it needs more than {MAX_CALLS} reads"));
        }
        let data = format!("0x{}{}", sel(sig), to_hex(arg).trim_start_matches("0x"));
        let reply = self.rpc.call("eth_call", json!([{"to": to, "data": data}, self.block]))?.map_err(|e| format!("{sig}: {e}"))?;
        from_hex(reply.as_str().unwrap_or("")).map_err(|e| format!("{sig}: {e}"))
    }
}

/// ABI words of a reply.
struct Abi<'a>(&'a [u8]);
impl Abi<'_> {
    fn need(&self, at: usize, n: usize) -> Result<()> {
        if at.checked_add(n).map_or(true, |e| e > self.0.len()) {
            return Err("a reply is shorter than its contents".into());
        }
        Ok(())
    }
    fn uint(&self, at: usize) -> Result<usize> {
        self.need(at, 32)?;
        let w = &self.0[at..at + 32];
        if w[..26].iter().any(|&b| b != 0) {
            return Err("a number in a reply is too large".into());
        }
        let v = w[26..].iter().fold(0u64, |v, &b| (v << 8) | b as u64);
        // A number past the address space cannot point inside a reply held in memory.
        usize::try_from(v).ok().filter(|v| v.checked_add(1 << 20).is_some()).ok_or_else(|| "a reply is shorter than its contents".to_string())
    }
    fn h256(&self, at: usize) -> Result<H256> {
        self.need(at, 32)?;
        let mut o = [0u8; 32];
        o.copy_from_slice(&self.0[at..at + 32]);
        Ok(o)
    }
    fn bool(&self, at: usize) -> Result<bool> {
        match self.uint(at)? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err("a true or false in a reply is neither".into()),
        }
    }
    fn bytes(&self, at: usize) -> Result<&[u8]> {
        let n = self.uint(at)?;
        self.need(at + 32, n)?;
        Ok(&self.0[at + 32..at + 32 + n])
    }
}

/// UTF-8 as the browser's TextDecoder reads it: strictly, with a leading byte-order mark dropped.
fn utf8(b: &[u8], what: &str) -> Result<String> {
    let b = b.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(b);
    String::from_utf8(b.to_vec()).map_err(|_| format!("{what} is not UTF-8"))
}

fn be(b: &[u8], at: usize, n: usize) -> usize {
    b[at..at + n].iter().fold(0usize, |v, &x| v * 256 + x as usize)
}

/// A name that can be one part of a path.
fn usable(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0'])
}

struct Entry {
    name: String,
    is_dir: bool,
    cid: H256,
}

struct Info {
    generation: u8,
    root: H256,
    chunks: Vec<(H256, Option<usize>)>,
    size: usize,
    mime: String,
    compression: u8,
    output_hash: H256,
}

/* ── second generation ── */

fn node(ctx: &Ctx, store: &str, id: &H256, prefix: u8, seen: &mut usize) -> Result<Vec<u8>> {
    if *seen > MAX_NODES {
        return Err(format!("it has more than {MAX_NODES} nodes"));
    }
    *seen += 1;
    let reply = ctx.eth(store, "getNode(bytes32)", id)?;
    let r = Abi(&reply);
    let blob = r.bytes(r.uint(0)?)?.to_vec();
    if h(&[&[prefix], &blob]) != *id {
        return Err(format!("node {}: its contents do not hash to its id", to_hex(id)));
    }
    if blob.is_empty() {
        return Err(format!("node {} is empty", to_hex(id)));
    }
    ctx.ev.borrow_mut().nodes.insert(*id, blob.clone());
    Ok(blob)
}

#[allow(clippy::too_many_arguments)]
fn leaves(ctx: &Ctx, store: &str, id: &H256, prefix: u8, child_bytes: usize, level: Option<u8>, seen: &mut usize, out: &mut Vec<Vec<u8>>) -> Result<()> {
    let blob = node(ctx, store, id, prefix, seen)?;
    if let Some(l) = level {
        if blob[0] != l {
            return Err(format!("node {} is at level {}, its parent says {l}", to_hex(id), blob[0]));
        }
    }
    if blob[0] == 0 {
        out.push(blob);
        return Ok(());
    }
    if blob[0] > 3 || blob.len() < 3 {
        return Err(format!("node {} has a level no tree has", to_hex(id)));
    }
    let k = be(&blob, 1, 2);
    if !(2..=128).contains(&k) || blob.len() != 3 + child_bytes * k {
        return Err(format!("branch {} does not hold the children it counts", to_hex(id)));
    }
    for i in 0..k {
        let mut child = [0u8; 32];
        child.copy_from_slice(&blob[3 + child_bytes * i..35 + child_bytes * i]);
        leaves(ctx, store, &child, prefix, child_bytes, Some(blob[0] - 1), seen, out)?;
    }
    Ok(())
}

fn entries_of(leaf: &[u8]) -> Result<Vec<Entry>> {
    if leaf.len() < 3 {
        return Err("an entry leaf is too short".into());
    }
    let n = be(leaf, 1, 2);
    let area = 3 + 2 * n;
    if n < 1 || area > leaf.len() {
        return Err("an entry leaf does not hold the entries it counts".into());
    }
    let mut out = Vec::new();
    let mut at = area;
    for i in 0..n {
        if area + be(leaf, 3 + 2 * i, 2) != at {
            return Err("an entry leaf's offsets do not match its records".into());
        }
        if at >= leaf.len() {
            return Err("an entry leaf ends inside a record".into());
        }
        let len = leaf[at] as usize;
        if at + 1 + len + 33 > leaf.len() {
            return Err("an entry leaf ends inside a record".into());
        }
        let flag = leaf[at + 1 + len];
        if flag > 1 {
            return Err("an entry is neither a file nor a directory".into());
        }
        let mut cid = [0u8; 32];
        cid.copy_from_slice(&leaf[at + 2 + len..at + 34 + len]);
        out.push(Entry { name: utf8(&leaf[at + 1..at + 1 + len], "an entry name")?, is_dir: flag == 1, cid });
        at += 34 + len;
    }
    if at != leaf.len() {
        return Err("an entry leaf has bytes after its records".into());
    }
    Ok(out)
}

fn list2(ctx: &Ctx, cid: &H256, seen: &mut usize) -> Result<Vec<Entry>> {
    let reply = ctx.eth(DIRS2, "rootOf(bytes32)", cid)?;
    let root = Abi(&reply).h256(0)?;
    if h(&[&[0x12], &root]) != *cid {
        return Err(format!("directory {}: its root node does not hash to its CID", to_hex(cid)));
    }
    ctx.ev.borrow_mut().dir_roots.insert(*cid, root);
    let mut blobs = Vec::new();
    leaves(ctx, DIRS2, &root, 0x22, 36, None, seen, &mut blobs)?;
    let mut out = Vec::new();
    for b in blobs {
        out.extend(entries_of(&b)?);
    }
    Ok(out)
}

fn info2(ctx: &Ctx, cid: &H256) -> Result<Info> {
    let reply = ctx.eth(FILES2, "getFileInfo(bytes32)", cid)?;
    let r = Abi(&reply);
    let t = r.uint(0)?;
    let mime_bytes = r.bytes(t + r.uint(t + 128)?)?.to_vec();
    let compression = r.uint(t + 160)?;
    if compression > 255 {
        return Err("a compression byte is larger than a byte".into());
    }
    let info = Info {
        generation: 2,
        root: r.h256(t)?,
        chunks: Vec::new(),
        size: r.uint(t + 96)?,
        mime: utf8(&mime_bytes, "a file type")?,
        compression: compression as u8,
        output_hash: r.h256(t + 192)?,
    };
    if h(&[&[0x11], &info.root, &keccak256(&mime_bytes), &[info.compression], &info.output_hash]) != *cid {
        return Err(format!("file {}: its record does not hash to its CID", to_hex(cid)));
    }
    let fe = FileEvidence { root: info.root, chunk_ids: Vec::new(), mime: mime_bytes, compression: info.compression, output_hash: info.output_hash, size: info.size };
    ctx.ev.borrow_mut().files.insert(*cid, fe);
    Ok(info)
}

fn chunks2(ctx: &Ctx, info: &Info) -> Result<Vec<(H256, Option<usize>)>> {
    let mut blobs = Vec::new();
    leaves(ctx, FILES2, &info.root, 0x21, 42, None, &mut 0, &mut blobs)?;
    let mut out = Vec::new();
    for leaf in blobs {
        if leaf.len() < 35 || (leaf.len() - 1) % 34 != 0 {
            return Err("a chunk leaf does not hold whole chunks".into());
        }
        let mut at = 1;
        while at < leaf.len() {
            let mut id = [0u8; 32];
            id.copy_from_slice(&leaf[at..at + 32]);
            out.push((id, Some(be(&leaf, at + 32, 2))));
            at += 34;
        }
    }
    Ok(out)
}

/* ── first generation ── */

fn list1(ctx: &Ctx, cid: &H256) -> Result<Vec<Entry>> {
    let reply = ctx.eth(DIRS1, "listDirectory(bytes32)", cid)?;
    let r = Abi(&reply);
    let base = r.uint(0)?;
    let n = r.uint(base)?;
    if n > MAX_ENTRIES {
        return Err(format!("a directory has more than {MAX_ENTRIES} entries"));
    }
    let mut out = Vec::new();
    let mut hashes = Vec::new();
    let mut raw = Vec::new();
    for i in 0..n {
        let t = base + 32 + r.uint(base + 32 + 32 * i)?;
        let name = r.bytes(t + r.uint(t)?)?.to_vec();
        let child = r.h256(t + 32)?;
        let is_dir = r.bool(t + 64)?;
        hashes.extend_from_slice(&h(&[&keccak256(&name), &child, &[is_dir as u8]]));
        out.push(Entry { name: utf8(&name, "an entry name")?, is_dir, cid: child });
        raw.push((name, is_dir, child));
    }
    if h(&[&[0x02], &keccak256(&hashes)]) != *cid {
        return Err(format!("directory {}: its entries do not hash to its CID", to_hex(cid)));
    }
    ctx.ev.borrow_mut().dir_entries.insert(*cid, raw);
    Ok(out)
}

fn info1(ctx: &Ctx, cid: &H256) -> Result<Info> {
    let reply = ctx.eth(FILES1, "getFile(bytes32)", cid)?;
    let r = Abi(&reply);
    let t = r.uint(0)?;
    let list = t + r.uint(t)?;
    let n = r.uint(list)?;
    let mime_bytes = r.bytes(t + r.uint(t + 32)?)?.to_vec();
    if n > MAX_CHUNKS {
        return Err(format!("a file has more than {MAX_CHUNKS} chunks"));
    }
    let ids: Vec<H256> = (0..n).map(|i| r.h256(list + 32 + 32 * i)).collect::<Result<_>>()?;
    let compression = r.uint(t + 64)?;
    if compression > 255 {
        return Err("a compression byte is larger than a byte".into());
    }
    let info = Info {
        generation: 1,
        root: [0u8; 32],
        chunks: ids.iter().map(|id| (*id, None)).collect(),
        size: 0,
        mime: utf8(&mime_bytes, "a file type")?,
        compression: compression as u8,
        output_hash: r.h256(t + 96)?,
    };
    if h(&[&[0x01], &keccak256(&ids.concat()), &keccak256(&mime_bytes), &[info.compression], &info.output_hash]) != *cid {
        return Err(format!("file {}: its record does not hash to its CID", to_hex(cid)));
    }
    let fe = FileEvidence { root: [0u8; 32], chunk_ids: ids.clone(), mime: mime_bytes, compression: info.compression, output_hash: info.output_hash, size: 0 };
    ctx.ev.borrow_mut().files.insert(*cid, fe);
    Ok(info)
}

/* ── both ── */

/// FastLZ level 1, to the end of the stream, no more than `limit` bytes.
pub fn inflate(d: &[u8], limit: usize) -> Result<Vec<u8>> {
    let mut out: Vec<u8> = Vec::with_capacity(d.len().saturating_mul(4).clamp(1024, limit.max(1024)));
    let mut i = 0;
    while i < d.len() {
        let c = d[i];
        let t = c >> 5;
        if t == 0 {
            let run = c as usize + 1;
            if i + 1 + run > d.len() {
                return Err("a FastLZ stream ends inside a literal run".into());
            }
            if out.len() + run > limit {
                return Err(format!("it inflates to more than {} MiB", MAX_FILE_BYTES / 1048576));
            }
            out.extend_from_slice(&d[i + 1..i + 1 + run]);
            i += 1 + run;
        } else {
            let long = usize::from(t == 7);
            if i + 1 + long >= d.len() {
                return Err("a FastLZ stream ends inside a back-reference".into());
            }
            let len = if long == 1 { 9 + d[i + 1] as usize } else { 2 + t as usize };
            let back = (((c & 31) as usize) << 8) + d[i + 1 + long] as usize + 1;
            if back > out.len() {
                return Err("a FastLZ stream refers to bytes before its start".into());
            }
            if out.len() + len > limit {
                return Err(format!("it inflates to more than {} MiB", MAX_FILE_BYTES / 1048576));
            }
            let from = out.len() - back;
            for k in 0..len {
                let b = out[from + k];
                out.push(b);
            }
            i += 2 + long;
        }
    }
    Ok(out)
}

/// One gzip member and nothing after it, as the browser's DecompressionStream('gzip') accepts.
fn gunzip(stored: &[u8], limit: usize) -> Result<Vec<u8>> {
    let bad = || "the stored bytes are not a valid gzip stream".to_string();
    let mut out = Vec::new();
    let mut d = flate2::bufread::GzDecoder::new(stored);
    (&mut d).take(limit as u64 + 1).read_to_end(&mut out).map_err(|_| bad())?;
    if out.len() > limit {
        return Err(format!("it decodes to more than {} MiB", MAX_FILE_BYTES / 1048576));
    }
    if !d.into_inner().is_empty() {
        return Err(bad());
    }
    Ok(out)
}

fn decode(algorithm: u8, bytes: &[u8], limit: usize) -> Result<Vec<u8>> {
    match algorithm {
        6 => inflate(bytes, limit),
        1 => gunzip(bytes, limit),
        a => Err(format!("this reader cannot decode BAMFS compression {a}")),
    }
}

/// A file's bytes, with a read budget of its own (as the viewer gives each file).
fn read_file(walk: &Ctx, cid: &H256, info: &Info) -> Result<Vec<u8>> {
    let ctx = &Ctx { rpc: walk.rpc, block: walk.block.clone(), calls: AtomicU64::new(0), ev: walk.ev };
    let list = if info.generation == 2 { chunks2(ctx, info)? } else { info.chunks.clone() };
    if list.len() > MAX_CHUNKS {
        return Err(format!("the file has more than {MAX_CHUNKS} chunks"));
    }
    let mut stored = Vec::new();
    let mut total = 0usize;
    for (id, size) in &list {
        let reply = ctx.eth(CONTENT_STORE, "read(bytes32)", id)?;
        let r = Abi(&reply);
        let payload = r.bytes(r.uint(0)?)?;
        if h(&[&BACKEND, payload]) != *id {
            return Err(format!("chunk {}: its bytes do not hash to its id", to_hex(id)));
        }
        if let Some(s) = size {
            if payload.len() != *s {
                return Err(format!("chunk {} is {} bytes, its leaf says {s}", to_hex(id), payload.len()));
            }
        }
        total += payload.len();
        if total > MAX_FILE_BYTES {
            return Err(format!("the file stores more than {} MiB", MAX_FILE_BYTES / 1048576));
        }
        ctx.ev.borrow_mut().chunks.insert(*id, payload.to_vec());
        stored.push(payload.to_vec());
    }
    let algorithm = info.compression & 0x7f;
    let body = if info.compression == 0 {
        if info.output_hash != [0u8; 32] {
            return Err(format!("file {} is not compressed but records an output hash", to_hex(cid)));
        }
        stored.concat()
    } else {
        let body = if info.compression & 0x80 != 0 {
            let mut parts = Vec::new();
            let mut decoded = 0usize;
            for s in &stored {
                let part = decode(algorithm, s, MAX_FILE_BYTES - decoded)?;
                decoded += part.len();
                parts.push(part);
            }
            parts.concat()
        } else {
            decode(algorithm, &stored.concat(), MAX_FILE_BYTES)?
        };
        if keccak256(&body) != info.output_hash {
            return Err(format!("file {}: its decoded bytes do not hash to its output hash", to_hex(cid)));
        }
        body
    };
    if info.generation == 2 && body.len() != info.size {
        return Err(format!("file {} is {} bytes, its record says {}", to_hex(cid), body.len(), info.size));
    }
    Ok(body)
}

fn exists(ctx: &Ctx, store: &str, sig: &str, cid: &H256) -> Result<bool> {
    let reply = ctx.eth(store, sig, cid)?;
    Abi(&reply).bool(0)
}

/// Every file under a BAMFS root, each checked back to it, read at one block, with no more than `max_bytes` of
/// distinct file contents.
pub fn read(rpc: &Rpc, root: &H256, max_bytes: usize) -> Result<Tree> {
    let block = rpc.call("eth_blockNumber", json!([]))?.map_err(|e| e.to_string())?;
    let ev = std::cell::RefCell::new(Evidence::default());
    let ctx = Ctx { rpc, block: block.as_str().ok_or("no block number")?.to_string(), calls: AtomicU64::new(0), ev: &ev };
    let mut top: Option<(u8, bool)> = None;
    for (g, dirs, files) in [(2u8, DIRS2, FILES2), (1u8, DIRS1, FILES1)] {
        if exists(&ctx, dirs, "directoryExists(bytes32)", root)? {
            top = Some((g, true));
            break;
        }
        if exists(&ctx, files, "fileExists(bytes32)", root)? {
            top = Some((g, false));
            break;
        }
    }
    let (generation, is_dir) = top.ok_or("no BAMFS store holds this root")?;
    let tree = Tree { is_file: !is_dir, generation, dirs: Vec::new(), files: Vec::new(), unusable: Vec::new(), bytes: 0, evidence: Evidence::default() };
    if !is_dir {
        let mut tree = tree;
        let i = if generation == 2 { info2(&ctx, root)? } else { info1(&ctx, root)? };
        let content = read_file(&ctx, root, &i)?;
        if content.len() > max_bytes {
            return Err(format!("it holds more than {} MiB", max_bytes / 1048576));
        }
        tree.bytes = content.len();
        tree.files.push(File { path: String::new(), mime: i.mime, content: Arc::new(content) });
        drop(ctx);
        tree.evidence = ev.into_inner();
        return Ok(tree);
    }
    let mut walk = Walk { ctx: &ctx, generation, seen: 0, count: 0, path: HashSet::new(), tree, contents: HashMap::new(), max_bytes };
    walk.descend(root, "", 0)?;
    let mut tree = walk.tree;
    drop(ctx);
    tree.evidence = ev.into_inner();
    Ok(tree)
}

struct Walk<'a> {
    ctx: &'a Ctx<'a>,
    generation: u8,
    seen: usize,
    count: usize,
    /// Directories on the path from the root to the one being listed: one of them again is a loop. The same
    /// directory in two places is not.
    path: HashSet<H256>,
    tree: Tree,
    /// Each file read once, however many paths name it.
    contents: HashMap<H256, Arc<Vec<u8>>>,
    max_bytes: usize,
}

impl Walk<'_> {
    fn descend(&mut self, cid: &H256, prefix: &str, depth: usize) -> Result<()> {
        if depth > MAX_DEPTH {
            return Err(format!("directories are nested more than {MAX_DEPTH} deep"));
        }
        if !self.path.insert(*cid) {
            return Err(format!("directory {} is inside itself", to_hex(cid)));
        }
        let entries = if self.generation == 2 { list2(self.ctx, cid, &mut self.seen)? } else { list1(self.ctx, cid)? };
        let mut names = HashSet::new();
        for e in entries {
            if !names.insert(e.name.clone()) {
                return Err(format!("two entries in {} are named {}", if prefix.is_empty() { "the root" } else { prefix }, e.name));
            }
            if self.count >= MAX_ENTRIES {
                return Err(format!("it has more than {MAX_ENTRIES} entries"));
            }
            self.count += 1;
            if !usable(&e.name) {
                self.tree.unusable.push(format!("{prefix}{}", e.name));
                continue;
            }
            if e.is_dir {
                let p = format!("{prefix}{}/", e.name);
                self.tree.dirs.push(p.trim_end_matches('/').to_string());
                self.descend(&e.cid, &p, depth + 1)?;
            } else {
                let i = if self.generation == 2 { info2(self.ctx, &e.cid)? } else { info1(self.ctx, &e.cid)? };
                let content = match self.contents.get(&e.cid) {
                    Some(c) => Arc::clone(c),
                    None => {
                        let c = Arc::new(read_file(self.ctx, &e.cid, &i)?);
                        self.tree.bytes += c.len();
                        if self.tree.bytes > self.max_bytes {
                            return Err(format!("it holds more than {} MiB", self.max_bytes / 1048576));
                        }
                        self.contents.insert(e.cid, Arc::clone(&c));
                        c
                    }
                };
                self.tree.files.push(File { path: format!("{prefix}{}", e.name), mime: i.mime, content });
            }
        }
        self.path.remove(cid);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fastlz_cases() {
        assert_eq!(inflate(&[2, 0x61, 0x62, 0x63], 100).unwrap(), b"abc");
        assert_eq!(inflate(&[0, 0x61, 0x20, 0x00], 100).unwrap(), b"aaaa");
        assert_eq!(inflate(&[0, 0x61, 0xe0, 0x01, 0x00], 100).unwrap(), vec![0x61; 11]);
        assert!(inflate(&[2, 0x61, 0x62], 100).is_err());
        assert!(inflate(&[0, 0x61, 0x20], 100).is_err());
        assert!(inflate(&[0, 0x61, 0x20, 0x05], 100).is_err());
        assert!(inflate(&[0, 0x61, 0x20, 0x00], 3).is_err());
        assert_eq!(inflate(&[], 100).unwrap(), b"");
    }

    #[test]
    fn gzip_is_one_member_and_nothing_after() {
        use std::io::Write;
        let mut g = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        g.write_all(b"hello").unwrap();
        let one = g.finish().unwrap();
        assert_eq!(gunzip(&one, 100).unwrap(), b"hello");
        assert!(gunzip(&[one.as_slice(), b"x"].concat(), 100).is_err());
        assert!(gunzip(&[one.as_slice(), one.as_slice()].concat(), 100).is_err());
        assert!(gunzip(&one, 4).is_err());
    }

    #[test]
    fn text_drops_a_leading_bom() {
        assert_eq!(utf8(b"\xef\xbb\xbfa", "x").unwrap(), "a");
        assert_eq!(utf8(b"a\xef\xbb\xbf", "x").unwrap(), "a\u{feff}");
        assert!(utf8(b"\xff", "x").is_err());
    }

    #[test]
    fn names() {
        for ok in ["a", "index.html", "a b"] {
            assert!(usable(ok));
        }
        for bad in ["", ".", "..", "a/b", "a\\b", "a\0"] {
            assert!(!usable(bad));
        }
    }

    #[test]
    fn selectors() {
        assert_eq!(sel("getNode(bytes32)").len(), 8);
        assert_eq!(sel("transfer(address,uint256)"), "a9059cbb");
    }
}
