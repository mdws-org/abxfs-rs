//! Read a root back from chain, verifying every id on the way.
//!
//! The walk is breadth-first over every pending object at once, so the number of round trips grows with the depth
//! of the tree, not its size:
//!
//! - a directory: `DirectoryStore.rootOf(cid)`, checked against `cid = keccak256(0x32 ‖ root)`, then its entry-node
//!   tree through `DirectoryStore.getNode`, each blob checked against `nodeId = keccak256(0x42 ‖ blob)`;
//! - a file: `FileStore.getFileInfo(cid)`, checked against `fileCid(root, mime, codec, outputHash)`, then its
//!   chunk-node tree through `FileStore.getNode` (`keccak256(0x41 ‖ blob)`);
//! - a chunk: `ChunkStore.recordOf(id)` gives the backend and the SSTORE2 pointer; for the two canonical backends the
//!   stored input is the pointer's code after its leading STOP byte (`eth_getCode`, no gas cap applies), inflated
//!   locally for FastLZ, and the chunk id is recomputed from `keccak256(input)`, `keccak256(data)` and the size. Any
//!   other backend is read through `ChunkStore.read` and `backend.retrieve`, and checked the same way.
//!
//! Branch cumulative counts and byte totals, node levels, `getNode`'s count and size, `chunkCount` and `size` are all
//! checked against what the children hold.

use std::collections::{HashMap, HashSet};

use rayon::prelude::*;

use crate::abi::{call_words, selector, Address, Dec};
use crate::chain::{Client, Out, View, CHUNK_STORE, DIRECTORY_STORE, FILE_STORE};
use crate::codec::{codec_name, decode};
use crate::fastlz;
use crate::hex::to_hex;
use crate::ids::{
    chunk_id, directory_cid, empty_directory, file_cid, keccak256, node_id, H256, CHUNK_NODE_PREFIX, ENTRY_NODE_PREFIX,
    FASTLZ_BACKEND, RAW_BACKEND, ZERO,
};
use crate::nodes::{assert_entry_name, NODE_MAX_LEVEL};
use crate::Result;

/// Deepest directory nesting a read follows.
const MAX_DEPTH: usize = 1024;
/// Gas of a cheap storage view (a few slots).
const SMALL_GAS: u64 = 60_000;
/// Gas of one `getNode` (code copy of up to 24,575 bytes plus ABI copy).
const NODE_GAS: u64 = 400_000;
/// Largest node blob plus its ABI framing.
const NODE_RET: usize = 24_575 + 192;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    File,
    Directory,
}

#[derive(Clone, Debug)]
pub struct DirEntry {
    pub name: Vec<u8>,
    pub cid: H256,
    pub is_dir: bool,
}

#[derive(Clone, Debug)]
pub struct FileInfo {
    pub root: H256,
    pub root_level: u8,
    pub chunk_count: u64,
    pub size: u64,
    pub mime: Vec<u8>,
    pub codec: H256,
    pub output_hash: H256,
}

#[derive(Clone, Debug)]
pub struct FileRead {
    pub info: FileInfo,
    /// `(chunk id, data size)` in file order.
    pub chunks: Vec<(H256, u64)>,
    /// The file's content: its data, decoded when it carries a codec.
    pub content: Option<Vec<u8>>,
}

/// Everything read under one root, keyed by CID.
pub struct ChainTree {
    pub root: H256,
    pub kind: Kind,
    pub dirs: HashMap<H256, Vec<DirEntry>>,
    /// Empty when the read skipped file contents.
    pub files: HashMap<H256, FileRead>,
    /// What every check above rested on, for an archive bundle: each directory's root node, every node blob, and
    /// each chunk's backend and input hash. A chunk's data is its slice of the file's content.
    pub evidence: Evidence,
}

#[derive(Default)]
pub struct Evidence {
    pub dir_roots: HashMap<H256, H256>,
    pub nodes: HashMap<H256, Vec<u8>>,
    pub chunks: HashMap<H256, (Address, H256)>,
}

/// One path under the root, `""` for the root itself.
#[derive(Clone, Debug)]
pub struct PathItem {
    pub path: Vec<u8>,
    pub cid: H256,
    pub kind: Kind,
}

impl ChainTree {
    /// Every path, parents before children, entries in directory order.
    pub fn paths(&self) -> Result<Vec<PathItem>> {
        let mut out = vec![PathItem { path: Vec::new(), cid: self.root, kind: self.kind }];
        if self.kind == Kind::Directory {
            self.walk_paths(&self.root, &[], 0, &mut out)?;
        }
        Ok(out)
    }

    fn walk_paths(&self, dir: &H256, prefix: &[u8], depth: usize, out: &mut Vec<PathItem>) -> Result<()> {
        if depth >= MAX_DEPTH {
            return Err(format!("directories nest deeper than {MAX_DEPTH} levels"));
        }
        let entries = self.dirs.get(dir).ok_or_else(|| format!("directory {} was not read", h(dir)))?;
        for e in entries {
            let mut p = prefix.to_vec();
            if !p.is_empty() {
                p.push(b'/');
            }
            p.extend_from_slice(&e.name);
            let kind = if e.is_dir { Kind::Directory } else { Kind::File };
            out.push(PathItem { path: p.clone(), cid: e.cid, kind });
            if e.is_dir {
                self.walk_paths(&e.cid, &p, depth + 1, out)?;
            }
        }
        Ok(())
    }
}

enum DirNode {
    Branch { level: u8, count: u64, children: Vec<(H256, u64)> },
    Leaf { count: u64, entries: Vec<DirEntry> },
}

enum FileNode {
    Branch { level: u8, count: u64, size: u64, children: Vec<(H256, u64, u64)> },
    Leaf { size: u64, chunks: Vec<(H256, u64)> },
}

#[derive(Clone, Copy, Debug)]
struct Record {
    backend: Address,
    size: u64,
    pointer: H256,
    data_hash: H256,
}

/// What a view in a round was asked for.
enum Ask {
    RootOf(H256),
    DirNode(H256),
    FileInfo(H256),
    FileNode(H256),
    Record(H256),
    ChunkRead(H256),
    Retrieve(H256),
}

fn h(x: &H256) -> String {
    to_hex(x)
}

fn ret_ok(out: &Out, what: &str) -> Result<Vec<u8>> {
    match out {
        Out::Ok(d) => Ok(d.clone()),
        Out::Revert(d) => Err(format!("{what} reverted (data {})", to_hex(d))),
    }
}

struct Walk<'a> {
    client: &'a Client,
    content: bool,
    // pending work for the next round
    q_rootof: Vec<H256>,
    q_dirnode: Vec<H256>,
    q_info: Vec<H256>,
    q_filenode: Vec<H256>,
    q_record: Vec<H256>,
    q_code: Vec<H256>,
    q_fallback: Vec<H256>,
    // dedup
    seen_dirs: HashSet<H256>,
    seen_files: HashSet<H256>,
    seen_dirnodes: HashSet<H256>,
    seen_filenodes: HashSet<H256>,
    seen_chunks: HashSet<H256>,
    // expected levels of requested nodes
    want_level: HashMap<H256, u8>,
    // results
    dir_root: HashMap<H256, H256>,
    dir_nodes: HashMap<H256, DirNode>,
    infos: HashMap<H256, FileInfo>,
    file_nodes: HashMap<H256, FileNode>,
    records: HashMap<H256, Record>,
    fallback_read: HashMap<H256, Vec<u8>>,
    fallback_input: HashMap<H256, Vec<u8>>,
    chunk_data: HashMap<H256, Vec<u8>>,
    blobs: HashMap<H256, Vec<u8>>,
    input_hashes: HashMap<H256, H256>,
}

/// Read `root` (file or directory). With `content`, every file is fetched and checked byte for byte; without it,
/// only the directory structure is read (file CIDs as the entries name them).
pub fn read_tree(client: &Client, root: &H256, content: bool) -> Result<ChainTree> {
    let (kind, first) = root_kind_with(client, root, content)?;
    let mut w = Walk {
        client,
        content,
        q_rootof: Vec::new(),
        q_dirnode: Vec::new(),
        q_info: Vec::new(),
        q_filenode: Vec::new(),
        q_record: Vec::new(),
        q_code: Vec::new(),
        q_fallback: Vec::new(),
        seen_dirs: HashSet::new(),
        seen_files: HashSet::new(),
        seen_dirnodes: HashSet::new(),
        seen_filenodes: HashSet::new(),
        seen_chunks: HashSet::new(),
        want_level: HashMap::new(),
        dir_root: HashMap::new(),
        dir_nodes: HashMap::new(),
        infos: HashMap::new(),
        file_nodes: HashMap::new(),
        records: HashMap::new(),
        fallback_read: HashMap::new(),
        fallback_input: HashMap::new(),
        chunk_data: HashMap::new(),
        blobs: HashMap::new(),
        input_hashes: HashMap::new(),
    };
    match kind {
        Kind::Directory => {
            w.seen_dirs.insert(*root);
            w.take(Ask::RootOf(*root), first)?;
        }
        Kind::File if content => {
            w.seen_files.insert(*root);
            w.take(Ask::FileInfo(*root), first)?;
        }
        Kind::File => {}
    }
    w.run()?;
    w.finish(*root, kind)
}

/// Whether `root` is a directory or a file (`directoryExists`, `fileExists`).
pub fn root_kind(client: &Client, root: &H256) -> Result<Kind> {
    Ok(root_kind_with(client, root, false)?.0)
}

/// The root's kind, asked together with what a read needs first: `rootOf` for a directory, `getFileInfo` for a file
/// (only when `file_info`). Returns the kind and that view's outcome.
fn root_kind_with(client: &Client, root: &H256, file_info: bool) -> Result<(Kind, Out)> {
    let mut views = vec![
        View { to: DIRECTORY_STORE, data: call_words(selector("directoryExists(bytes32)"), &[*root]), ret: 32, gas: SMALL_GAS },
        View { to: FILE_STORE, data: call_words(selector("fileExists(bytes32)"), &[*root]), ret: 32, gas: SMALL_GAS },
        View { to: DIRECTORY_STORE, data: call_words(selector("rootOf(bytes32)"), &[*root]), ret: 32, gas: SMALL_GAS },
    ];
    if file_info {
        views.push(View { to: FILE_STORE, data: call_words(selector("getFileInfo(bytes32)"), &[*root]), ret: 512, gas: SMALL_GAS * 3 });
    }
    let (mut outs, _) = client.round(&views, &[])?;
    let d = Dec::new(&ret_ok(&outs[0], "directoryExists")?).boolean(0)?;
    let f = Dec::new(&ret_ok(&outs[1], "fileExists")?).boolean(0)?;
    match (d, f) {
        (true, false) => Ok((Kind::Directory, outs.swap_remove(2))),
        (false, true) => Ok((Kind::File, if file_info { outs.swap_remove(3) } else { Out::Ok(Vec::new()) })),
        (true, true) => Err(format!("{} is both a directory and a file", h(root))),
        (false, false) => Err(format!("{} is neither a directory nor a file on {}", h(root), client.chain.name)),
    }
}

/// `getFileInfo` for many file CIDs in one round, each checked against `fileCid(root, mime, codec, outputHash)`.
pub fn file_infos(client: &Client, cids: &[H256]) -> Result<Vec<FileInfo>> {
    let views: Vec<View> = cids
        .iter()
        .map(|cid| View { to: FILE_STORE, data: call_words(selector("getFileInfo(bytes32)"), &[*cid]), ret: 512, gas: SMALL_GAS * 3 })
        .collect();
    let (outs, _) = client.round(&views, &[])?;
    outs.iter()
        .zip(cids)
        .map(|(o, cid)| {
            let info = decode_file_info(&ret_ok(o, &format!("getFileInfo {}", h(cid)))?)?;
            let mime = std::str::from_utf8(&info.mime).map_err(|_| format!("file {}: mime type is not UTF-8", h(cid)))?;
            if file_cid(&info.root, mime, &info.codec, &info.output_hash)? != *cid {
                return Err(format!("file {}: getFileInfo describes another file CID", h(cid)));
            }
            Ok(info)
        })
        .collect()
}

/// Existence of many ids at once: `(store, function signature, id)` → exists.
pub fn exists_many(client: &Client, probes: &[(Address, &str, H256)]) -> Result<Vec<bool>> {
    let views: Vec<View> = probes
        .iter()
        .map(|(to, sig, id)| View { to: *to, data: call_words(selector(sig), &[*id]), ret: 32, gas: SMALL_GAS })
        .collect();
    let (outs, _) = client.round(&views, &[])?;
    outs.iter().zip(probes).map(|(o, (_, sig, id))| Dec::new(&ret_ok(o, &format!("{sig} {}", h(id)))?).boolean(0)).collect()
}

impl Walk<'_> {
    fn add_dir(&mut self, cid: H256) {
        if self.seen_dirs.insert(cid) {
            if cid == empty_directory() {
                self.dir_root.insert(cid, ZERO);
            } else {
                self.q_rootof.push(cid);
            }
        }
    }

    fn add_file(&mut self, cid: H256) {
        if self.content && self.seen_files.insert(cid) {
            self.q_info.push(cid);
        }
    }

    fn add_dir_node(&mut self, id: H256, level: Option<u8>) -> Result<()> {
        self.expect_level(id, level)?;
        if self.seen_dirnodes.insert(id) {
            self.q_dirnode.push(id);
        }
        Ok(())
    }

    fn add_file_node(&mut self, id: H256, level: Option<u8>) -> Result<()> {
        self.expect_level(id, level)?;
        if self.seen_filenodes.insert(id) {
            self.q_filenode.push(id);
        }
        Ok(())
    }

    fn expect_level(&mut self, id: H256, level: Option<u8>) -> Result<()> {
        if let Some(l) = level {
            if let Some(&prev) = self.want_level.get(&id) {
                if prev != l {
                    return Err(format!("node {} is expected at level {prev} and at level {l}", h(&id)));
                }
            }
            self.want_level.insert(id, l);
        }
        Ok(())
    }

    fn run(&mut self) -> Result<()> {
        loop {
            let mut views = Vec::new();
            let mut asks = Vec::new();
            for cid in std::mem::take(&mut self.q_rootof) {
                views.push(View { to: DIRECTORY_STORE, data: call_words(selector("rootOf(bytes32)"), &[cid]), ret: 32, gas: SMALL_GAS });
                asks.push(Ask::RootOf(cid));
            }
            for id in std::mem::take(&mut self.q_dirnode) {
                views.push(View { to: DIRECTORY_STORE, data: call_words(selector("getNode(bytes32)"), &[id]), ret: NODE_RET, gas: NODE_GAS });
                asks.push(Ask::DirNode(id));
            }
            for cid in std::mem::take(&mut self.q_info) {
                views.push(View { to: FILE_STORE, data: call_words(selector("getFileInfo(bytes32)"), &[cid]), ret: 512, gas: SMALL_GAS * 3 });
                asks.push(Ask::FileInfo(cid));
            }
            for id in std::mem::take(&mut self.q_filenode) {
                views.push(View { to: FILE_STORE, data: call_words(selector("getNode(bytes32)"), &[id]), ret: NODE_RET, gas: NODE_GAS });
                asks.push(Ask::FileNode(id));
            }
            for id in std::mem::take(&mut self.q_record) {
                views.push(View { to: CHUNK_STORE, data: call_words(selector("recordOf(bytes32)"), &[id]), ret: 128, gas: SMALL_GAS });
                asks.push(Ask::Record(id));
            }
            for id in std::mem::take(&mut self.q_fallback) {
                let r = self.records[&id];
                views.push(View { to: CHUNK_STORE, data: call_words(selector("read(bytes32)"), &[id]), ret: r.size as usize + 96, gas: 30_000 + 125 * r.size });
                asks.push(Ask::ChunkRead(id));
                views.push(View { to: r.backend, data: call_words(selector("retrieve(bytes32)"), &[r.pointer]), ret: 24_575 + 96, gas: 30_000 + 125 * r.size });
                asks.push(Ask::Retrieve(id));
            }
            let code_ids = std::mem::take(&mut self.q_code);
            let mut code_addrs = Vec::with_capacity(code_ids.len());
            for id in &code_ids {
                code_addrs.push(pointer_address(&self.records[id].pointer).expect("checked when queued"));
            }
            if views.is_empty() && code_ids.is_empty() {
                return Ok(());
            }
            let (outs, codes) = self.client.round(&views, &code_addrs)?;
            for (ask, out) in asks.into_iter().zip(outs) {
                self.take(ask, out)?;
            }
            self.take_codes(&code_ids, codes)?;
        }
    }

    fn take(&mut self, ask: Ask, out: Out) -> Result<()> {
        match ask {
            Ask::RootOf(cid) => {
                let root = Dec::new(&ret_ok(&out, &format!("rootOf {}", h(&cid)))?).h256(0)?;
                if directory_cid(&root) != cid {
                    return Err(format!("directory {}: rootOf returned {}, whose directory CID is {}", h(&cid), h(&root), h(&directory_cid(&root))));
                }
                self.dir_root.insert(cid, root);
                if root != ZERO {
                    self.add_dir_node(root, None)?;
                }
            }
            Ask::DirNode(id) => {
                let (blob, level, count, size) = decode_node(&ret_ok(&out, &format!("DirectoryStore.getNode {}", h(&id)))?)?;
                self.check_node(&id, ENTRY_NODE_PREFIX, &blob, level)?;
                self.blobs.insert(id, blob.clone());
                if size != 0 {
                    return Err(format!("directory node {} reports size {size}", h(&id)));
                }
                let node = parse_dir_node(&id, &blob, count)?;
                if let DirNode::Branch { level, children, .. } = &node {
                    for (c, _) in children.clone() {
                        self.add_dir_node(c, Some(level - 1))?;
                    }
                }
                if let DirNode::Leaf { entries, .. } = &node {
                    for e in entries.clone() {
                        if e.is_dir {
                            self.add_dir(e.cid);
                        } else {
                            self.add_file(e.cid);
                        }
                    }
                }
                self.dir_nodes.insert(id, node);
            }
            Ask::FileInfo(cid) => {
                let info = decode_file_info(&ret_ok(&out, &format!("getFileInfo {}", h(&cid)))?)?;
                let mime = std::str::from_utf8(&info.mime).map_err(|_| format!("file {}: mime type is not UTF-8", h(&cid)))?;
                let want = file_cid(&info.root, mime, &info.codec, &info.output_hash)?;
                if want != cid {
                    return Err(format!("file {}: getFileInfo describes file CID {}", h(&cid), h(&want)));
                }
                if let Some(name) = codec_name(&info.codec)? {
                    if !matches!(name.as_str(), "gzip" | "deflate" | "br" | "zstd") {
                        return Err(format!("file {}: no decoder for file codec \"{name}\"", h(&cid)));
                    }
                }
                if info.root == ZERO {
                    if info.chunk_count != 0 || info.size != 0 {
                        return Err(format!("file {}: empty root but {} chunks, {} bytes", h(&cid), info.chunk_count, info.size));
                    }
                } else {
                    self.add_file_node(info.root, Some(info.root_level))?;
                }
                self.infos.insert(cid, info);
            }
            Ask::FileNode(id) => {
                let (blob, level, count, size) = decode_node(&ret_ok(&out, &format!("FileStore.getNode {}", h(&id)))?)?;
                self.check_node(&id, CHUNK_NODE_PREFIX, &blob, level)?;
                self.blobs.insert(id, blob.clone());
                let node = parse_file_node(&id, &blob, count, size)?;
                match &node {
                    FileNode::Branch { level, children, .. } => {
                        for (c, _, _) in children.clone() {
                            self.add_file_node(c, Some(level - 1))?;
                        }
                    }
                    FileNode::Leaf { chunks, .. } => {
                        for &(c, _) in chunks {
                            if self.seen_chunks.insert(c) {
                                self.q_record.push(c);
                            }
                        }
                    }
                }
                self.file_nodes.insert(id, node);
            }
            Ask::Record(id) => {
                let d = ret_ok(&out, &format!("recordOf {}", h(&id)))?;
                let d = Dec::new(&d);
                let r = Record { backend: d.address(0)?, size: d.uint(32, 48)?, pointer: d.h256(64)?, data_hash: d.h256(96)? };
                if r.backend == [0u8; 20] {
                    return Err(format!("chunk {} is not on chain (recordOf is empty)", h(&id)));
                }
                self.records.insert(id, r);
                let canonical = r.backend == RAW_BACKEND.address || r.backend == FASTLZ_BACKEND.address;
                if canonical && pointer_address(&r.pointer).is_some() {
                    self.q_code.push(id);
                } else {
                    self.q_fallback.push(id);
                }
            }
            Ask::ChunkRead(id) => {
                self.fallback_read.insert(id, decode_bytes(&ret_ok(&out, &format!("ChunkStore.read {}", h(&id)))?)?);
                self.finish_fallback(id)?;
            }
            Ask::Retrieve(id) => {
                self.fallback_input.insert(id, decode_bytes(&ret_ok(&out, &format!("backend.retrieve for chunk {}", h(&id)))?)?);
                self.finish_fallback(id)?;
            }
        }
        Ok(())
    }

    fn check_node(&self, id: &H256, prefix: u8, blob: &[u8], level: u8) -> Result<()> {
        if node_id(prefix, blob) != *id {
            return Err(format!("node {}: getNode returned a blob whose id is {}", h(id), h(&node_id(prefix, blob))));
        }
        if blob.first() != Some(&level) {
            return Err(format!("node {}: getNode level {level} disagrees with the blob", h(id)));
        }
        if level > NODE_MAX_LEVEL {
            return Err(format!("node {}: level {level} is above {NODE_MAX_LEVEL}", h(id)));
        }
        if let Some(&want) = self.want_level.get(id) {
            if want != level {
                return Err(format!("node {}: level {level}, its parent says {want}", h(id)));
            }
        }
        Ok(())
    }

    /// Check and inflate chunks fetched as code, in parallel.
    fn take_codes(&mut self, ids: &[H256], codes: Vec<Vec<u8>>) -> Result<()> {
        let recs: Vec<Record> = ids.iter().map(|id| self.records[id]).collect();
        let done: Vec<Result<(H256, Vec<u8>)>> = ids
            .par_iter()
            .zip(codes.into_par_iter())
            .zip(recs.par_iter())
            .map(|((id, code), r)| {
                if code.first() != Some(&0) {
                    return Err(format!("chunk {}: pointer {} holds no SSTORE2 data", h(id), h(&r.pointer)));
                }
                let input = &code[1..];
                let data = if r.backend == FASTLZ_BACKEND.address { fastlz::decompress(input)? } else { input.to_vec() };
                check_chunk(id, r, input, &data)?;
                Ok((keccak256(input), data))
            })
            .collect();
        for (id, d) in ids.iter().zip(done) {
            let (input_hash, data) = d?;
            self.input_hashes.insert(*id, input_hash);
            self.chunk_data.insert(*id, data);
        }
        Ok(())
    }

    fn finish_fallback(&mut self, id: H256) -> Result<()> {
        if let (Some(data), Some(input)) = (self.fallback_read.get(&id), self.fallback_input.get(&id)) {
            let r = self.records[&id];
            check_chunk(&id, &r, input, data)?;
            self.input_hashes.insert(id, keccak256(input));
            let data = self.fallback_read.remove(&id).unwrap();
            self.fallback_input.remove(&id);
            self.chunk_data.insert(id, data);
        }
        Ok(())
    }

    fn finish(mut self, root: H256, kind: Kind) -> Result<ChainTree> {
        let mut dirs = HashMap::new();
        for (&cid, &node_root) in &self.dir_root {
            let entries = if node_root == ZERO { Vec::new() } else { collect_dir(&self.dir_nodes, &node_root, 0)?.1 };
            let mut seen = HashSet::new();
            for e in &entries {
                if !seen.insert(e.name.as_slice()) {
                    return Err(format!("directory {} lists {:?} twice", h(&cid), String::from_utf8_lossy(&e.name)));
                }
            }
            dirs.insert(cid, entries);
        }
        let mut files = HashMap::new();
        let infos: Vec<(H256, FileInfo)> = self.infos.drain().collect();
        for (cid, info) in infos {
            let chunks = if info.root == ZERO {
                Vec::new()
            } else {
                let (count, size, chunks) = collect_file(&self.file_nodes, &info.root)?;
                if count != info.chunk_count || size != info.size {
                    return Err(format!(
                        "file {}: getFileInfo says {} chunks / {} bytes, its tree holds {count} / {size}",
                        h(&cid),
                        info.chunk_count,
                        info.size
                    ));
                }
                chunks
            };
            let mut content = Vec::with_capacity(info.size as usize);
            for (id, size) in &chunks {
                let d = &self.chunk_data[id];
                if d.len() as u64 != *size {
                    return Err(format!("file {}: chunk {} is {} bytes, its leaf says {size}", h(&cid), h(id), d.len()));
                }
                content.extend_from_slice(d);
            }
            if content.len() as u64 != info.size {
                return Err(format!("file {}: read {} bytes, expected {}", h(&cid), content.len(), info.size));
            }
            if let Some(name) = codec_name(&info.codec)? {
                let decoded = decode(&name, &content).map_err(|e| format!("file {}: {e}", h(&cid)))?;
                let got = keccak256(&decoded);
                if got != info.output_hash {
                    return Err(format!("file {}: {name} output hashes to {}, outputHash is {}", h(&cid), h(&got), h(&info.output_hash)));
                }
                content = decoded;
            }
            files.insert(cid, FileRead { info, chunks, content: Some(content) });
        }
        let chunks = self.input_hashes.iter().map(|(id, ih)| (*id, (self.records[id].backend, *ih))).collect();
        let evidence = Evidence { dir_roots: self.dir_root.clone(), nodes: std::mem::take(&mut self.blobs), chunks };
        let tree = ChainTree { root, kind, dirs, files, evidence };
        let paths = tree.paths()?;
        if self.content {
            for p in &paths {
                if p.kind == Kind::File && !tree.files.contains_key(&p.cid) {
                    return Err(format!("file {} was not read", h(&p.cid)));
                }
            }
        }
        Ok(tree)
    }
}

fn check_chunk(id: &H256, r: &Record, input: &[u8], data: &[u8]) -> Result<()> {
    if data.len() as u64 != r.size {
        return Err(format!("chunk {}: {} data bytes, its record says {}", h(id), data.len(), r.size));
    }
    let dh = keccak256(data);
    if dh != r.data_hash {
        return Err(format!("chunk {}: data hash {} disagrees with its record {}", h(id), h(&dh), h(&r.data_hash)));
    }
    let got = chunk_id(&r.backend, &keccak256(input), &dh, r.size)?;
    if got != *id {
        return Err(format!("chunk {}: the bytes read give chunk id {}", h(id), h(&got)));
    }
    Ok(())
}

/// The address an SSTORE2 pointer word names, when its upper 12 bytes are zero.
fn pointer_address(p: &H256) -> Option<Address> {
    if p[..12].iter().any(|&b| b != 0) {
        return None;
    }
    Some(p[12..].try_into().unwrap())
}

/// `getNode` → `(bytes blob, uint8 level, uint32 count, uint48 size)`.
fn decode_node(ret: &[u8]) -> Result<(Vec<u8>, u8, u64, u64)> {
    let d = Dec::new(ret);
    let blob = d.bytes_at(d.offset(0, 0)?)?.to_vec();
    Ok((blob, d.uint(32, 8)? as u8, d.uint(64, 32)?, d.uint(96, 48)?))
}

fn decode_bytes(ret: &[u8]) -> Result<Vec<u8>> {
    let d = Dec::new(ret);
    Ok(d.bytes_at(d.offset(0, 0)?)?.to_vec())
}

/// `getFileInfo` → one tuple `(bytes32, uint8, uint256, uint256, string, bytes32, bytes32)`.
fn decode_file_info(ret: &[u8]) -> Result<FileInfo> {
    let d = Dec::new(ret);
    let t = d.offset(0, 0)?;
    let mime_at = d.offset(t + 128, t)?;
    Ok(FileInfo {
        root: d.h256(t)?,
        root_level: d.uint(t + 32, 8)? as u8,
        chunk_count: d.uint(t + 64, 64)?,
        size: d.uint(t + 96, 64)?,
        mime: d.bytes_at(mime_at)?.to_vec(),
        codec: d.h256(t + 160)?,
        output_hash: d.h256(t + 192)?,
    })
}

fn be(b: &[u8]) -> u64 {
    b.iter().fold(0u64, |a, &x| (a << 8) | x as u64)
}

fn h256_at(b: &[u8], at: usize) -> H256 {
    b[at..at + 32].try_into().unwrap()
}

/// Parse a branch blob: `level ‖ u16 n ‖ (child:32 ‖ u32 cumCount [‖ u48 cumBytes])*n`.
fn parse_branch(id: &H256, blob: &[u8], with_bytes: bool) -> Result<Vec<(H256, u64, u64)>> {
    let stride = if with_bytes { 42 } else { 36 };
    if blob.len() < 3 {
        return Err(format!("node {}: branch blob too short", h(id)));
    }
    let n = be(&blob[1..3]) as usize;
    if n < 1 || blob.len() != 3 + stride * n {
        return Err(format!("node {}: branch of {n} children has {} bytes", h(id), blob.len()));
    }
    let mut out = Vec::with_capacity(n);
    let (mut prev_c, mut prev_b) = (0u64, 0u64);
    for i in 0..n {
        let at = 3 + stride * i;
        let c = be(&blob[at + 32..at + 36]);
        let b = if with_bytes { be(&blob[at + 36..at + 42]) } else { 0 };
        if c <= prev_c || (with_bytes && b < prev_b) {
            return Err(format!("node {}: branch cumulative fields do not increase at child {i}", h(id)));
        }
        out.push((h256_at(blob, at), c, b));
        prev_c = c;
        prev_b = b;
    }
    Ok(out)
}

fn parse_dir_node(id: &H256, blob: &[u8], count: u64) -> Result<DirNode> {
    if blob[0] > 0 {
        let ch = parse_branch(id, blob, false)?;
        let total = ch.last().unwrap().1;
        if total != count {
            return Err(format!("node {}: getNode count {count}, blob totals {total}", h(id)));
        }
        return Ok(DirNode::Branch { level: blob[0], count, children: ch.into_iter().map(|(c, n, _)| (c, n)).collect() });
    }
    if blob.len() < 3 {
        return Err(format!("node {}: entry leaf too short", h(id)));
    }
    let n = be(&blob[1..3]) as usize;
    let records = 3 + 2 * n;
    if blob.len() < records || n as u64 != count {
        return Err(format!("node {}: entry leaf of {n} entries (getNode count {count}) has {} bytes", h(id), blob.len()));
    }
    let mut at = records;
    let mut entries = Vec::with_capacity(n);
    for i in 0..n {
        let off = be(&blob[3 + 2 * i..5 + 2 * i]) as usize;
        if records + off != at {
            return Err(format!("node {}: entry {i} offset {off} does not follow the previous record", h(id)));
        }
        let len = *blob.get(at).ok_or_else(|| format!("node {}: entry {i} runs past the blob", h(id)))? as usize;
        let end = at + 1 + len + 1 + 32;
        if end > blob.len() {
            return Err(format!("node {}: entry {i} runs past the blob", h(id)));
        }
        let name = blob[at + 1..at + 1 + len].to_vec();
        assert_entry_name(&name).map_err(|e| format!("node {}: {e}", h(id)))?;
        let flag = blob[at + 1 + len];
        if flag > 1 {
            return Err(format!("node {}: entry {i} directory flag is {flag}", h(id)));
        }
        entries.push(DirEntry { name, is_dir: flag == 1, cid: h256_at(blob, at + 2 + len) });
        at = end;
    }
    if at != blob.len() {
        return Err(format!("node {}: {} bytes after the last entry", h(id), blob.len() - at));
    }
    Ok(DirNode::Leaf { count, entries })
}

fn parse_file_node(id: &H256, blob: &[u8], count: u64, size: u64) -> Result<FileNode> {
    if blob[0] > 0 {
        let ch = parse_branch(id, blob, true)?;
        let last = ch.last().unwrap();
        if last.1 != count || last.2 != size {
            return Err(format!("node {}: getNode {count} chunks / {size} bytes, blob totals {} / {}", h(id), last.1, last.2));
        }
        return Ok(FileNode::Branch { level: blob[0], count, size, children: ch });
    }
    if (blob.len() - 1) % 38 != 0 || blob.len() == 1 {
        return Err(format!("node {}: chunk leaf of {} bytes", h(id), blob.len()));
    }
    let chunks: Vec<(H256, u64)> = (0..(blob.len() - 1) / 38).map(|i| (h256_at(blob, 1 + 38 * i), be(&blob[33 + 38 * i..39 + 38 * i]))).collect();
    let total: u64 = chunks.iter().map(|c| c.1).sum();
    if chunks.len() as u64 != count || total != size || chunks.iter().any(|c| c.1 == 0) {
        return Err(format!("node {}: getNode {count} chunks / {size} bytes, leaf holds {} / {total}", h(id), chunks.len()));
    }
    Ok(FileNode::Leaf { size, chunks })
}

/// In-order entries under a directory node, with each child's share checked against the branch's prefix sums.
fn collect_dir(nodes: &HashMap<H256, DirNode>, id: &H256, depth: usize) -> Result<(u64, Vec<DirEntry>)> {
    if depth > NODE_MAX_LEVEL as usize {
        return Err(format!("node {}: tree deeper than {NODE_MAX_LEVEL} levels", h(id)));
    }
    match nodes.get(id).ok_or_else(|| format!("directory node {} was not read", h(id)))? {
        DirNode::Leaf { count, entries } => Ok((*count, entries.clone())),
        DirNode::Branch { count, children, .. } => {
            let mut out = Vec::new();
            let mut prev = 0;
            for (c, cum) in children {
                let (n, mut e) = collect_dir(nodes, c, depth + 1)?;
                if n != cum - prev {
                    return Err(format!("node {}: child {} holds {n} entries, the branch says {}", h(id), h(c), cum - prev));
                }
                prev = *cum;
                out.append(&mut e);
            }
            if prev != *count {
                return Err(format!("node {}: holds {prev} entries, getNode says {count}", h(id)));
            }
            Ok((prev, out))
        }
    }
}

/// In-order `(chunk id, size)` under a file node, with every prefix sum checked.
fn collect_file(nodes: &HashMap<H256, FileNode>, id: &H256) -> Result<(u64, u64, Vec<(H256, u64)>)> {
    match nodes.get(id).ok_or_else(|| format!("file node {} was not read", h(id)))? {
        FileNode::Leaf { size, chunks } => Ok((chunks.len() as u64, *size, chunks.clone())),
        FileNode::Branch { count, size, children, .. } => {
            let mut out = Vec::new();
            let (mut pc, mut pb) = (0, 0);
            for (c, cc, cb) in children {
                let (n, b, mut ch) = collect_file(nodes, c)?;
                if n != cc - pc || b != cb - pb {
                    return Err(format!("node {}: child {} holds {n} chunks / {b} bytes, the branch says {} / {}", h(id), h(c), cc - pc, cb - pb));
                }
                pc = *cc;
                pb = *cb;
                out.append(&mut ch);
            }
            if pc != *count || pb != *size {
                return Err(format!("node {}: holds {pc} chunks / {pb} bytes, getNode says {count} / {size}", h(id)));
            }
            Ok((pc, pb, out))
        }
    }
}


/// Write a tree read with content: a file root to `out` as a file, a directory root as a new directory at `out`
/// (refused if `out` exists and is not an empty directory). Empty directories are created.
pub fn write_tree(tree: &ChainTree, out: &std::path::Path) -> Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let content = |cid: &H256| -> Result<&[u8]> {
        tree.files.get(cid).and_then(|f| f.content.as_deref()).ok_or_else(|| format!("file {} was not read", h(cid)))
    };
    if tree.kind == Kind::File {
        return std::fs::write(out, content(&tree.root)?).map_err(|e| format!("{}: {e}", out.display()));
    }
    if out.exists() {
        let mut rd = std::fs::read_dir(out).map_err(|e| format!("{}: {e}", out.display()))?;
        if rd.next().is_some() {
            return Err(format!("{} exists and is not empty", out.display()));
        }
    }
    std::fs::create_dir_all(out).map_err(|e| format!("{}: {e}", out.display()))?;
    let paths = tree.paths()?;
    for p in paths.iter().skip(1).filter(|p| p.kind == Kind::Directory) {
        let dst = out.join(std::ffi::OsStr::from_bytes(&p.path));
        std::fs::create_dir(&dst).map_err(|e| format!("{}: {e}", dst.display()))?;
    }
    paths
        .par_iter()
        .filter(|p| p.kind == Kind::File)
        .map(|p| {
            let dst = out.join(std::ffi::OsStr::from_bytes(&p.path));
            std::fs::write(&dst, content(&p.cid)?).map_err(|e| format!("{}: {e}", dst.display()))
        })
        .collect::<Result<Vec<()>>>()?;
    Ok(())
}
