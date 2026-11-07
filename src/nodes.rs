//! Canonical packing of chunk lists and directory entries into node trees (SDK `nodes.ts`, `node-gas.ts`).

use crate::ids::{keccak256, node_id, u48_be, H256, CHUNK_NODE_PREFIX, ENTRY_NODE_PREFIX, MAX_U48, ZERO};
use crate::Result;

pub const NODE_MAX_BYTES: usize = 24_575;
pub const NODE_MAX_LEVEL: u8 = 3;
pub const BRANCH_MAX_CHILDREN: usize = 128;
pub const CHUNK_LEAF_MAX_HASHES: usize = 512;
pub const CHUNK_LEAF_MIN_HASHES: usize = 32;
pub const CHUNK_LEAF_BOUNDARY_ODDS: u64 = 128;
pub const ENTRY_LEAF_MIN_BYTES: usize = 4096;
pub const ENTRY_LEAF_TARGET_BYTES: u64 = 4096;
pub const BRANCH_BOUNDARY_ODDS: u64 = 32;
pub const ENTRY_LEAF_GAS_CAP: u64 = 7_000_000;
pub const MAX_ENTRY_NAME_BYTES: usize = 255;

const TWO_32: u64 = 1 << 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TreeKind {
    Chunks,
    Entries,
}

impl TreeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TreeKind::Chunks => "chunks",
            TreeKind::Entries => "entries",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Node {
    pub id: H256,
    pub blob: Vec<u8>,
    pub level: u8,
    /// Items (chunks or entries) in the whole subtree.
    pub count: u64,
    /// Data bytes in the whole subtree; 0 for entry nodes.
    pub size: u64,
    pub child_ids: Vec<H256>,
}

#[derive(Clone, Debug)]
pub struct Tree {
    pub kind: TreeKind,
    pub root: H256,
    pub root_level: u8,
    pub count: u64,
    /// Children before parents: all leaves, then each branch level.
    pub nodes: Vec<Node>,
}

impl Tree {
    fn empty(kind: TreeKind) -> Tree {
        Tree { kind, root: ZERO, root_level: 0, count: 0, nodes: Vec::new() }
    }
}

/// One directory entry: the name's exact bytes, its text form, the child CID and whether it is a directory.
#[derive(Clone, Debug)]
pub struct Entry {
    pub name: String,
    pub cid: H256,
    pub is_directory: bool,
}

impl Entry {
    pub fn name_bytes(&self) -> &[u8] {
        self.name.as_bytes()
    }
}

/// Top 32 bits of a 32-byte id, big-endian.
pub fn hash_key(id: &H256) -> u32 {
    u32::from_be_bytes([id[0], id[1], id[2], id[3]])
}

pub fn name_key(name: &[u8]) -> u32 {
    hash_key(&keccak256(name))
}

pub fn chunk_leaf_blob_size(n: usize) -> usize {
    1 + 38 * n
}

pub fn branch_blob_size(n: usize, with_bytes: bool) -> usize {
    3 + n * if with_bytes { 42 } else { 36 }
}

pub fn entry_leaf_blob_size(count: usize, name_bytes: usize) -> usize {
    3 + 2 * count + 34 * count + name_bytes
}

/// The frozen packing cost that bounds an entry leaf (not the gas estimate).
pub fn entry_leaf_packing_cost(count: usize, name_bytes: usize) -> u64 {
    75_000 + 205 * entry_leaf_blob_size(count, name_bytes) as u64 + 11_000 * count as u64 + 170 * name_bytes as u64
}

pub fn partition_chunk_leaves(keys: &[u32]) -> Vec<usize> {
    let threshold = TWO_32 / CHUNK_LEAF_BOUNDARY_ODDS;
    let mut out = Vec::new();
    let mut cur = 0;
    for &k in keys {
        cur += 1;
        if cur == CHUNK_LEAF_MAX_HASHES || (cur >= CHUNK_LEAF_MIN_HASHES && (k as u64) < threshold) {
            out.push(cur);
            cur = 0;
        }
    }
    if cur > 0 {
        out.push(cur);
    }
    out
}

/// Items are `(name byte length, name key)` in sorted name order.
pub fn partition_entry_leaves(items: &[(usize, u32)], gas_cap: u64) -> Vec<usize> {
    let mut out = Vec::new();
    let mut count = 0;
    let mut nb = 0;
    for &(len, key) in items {
        let c = count + 1;
        let b = nb + len;
        if count > 0 && (entry_leaf_blob_size(c, b) > NODE_MAX_BYTES || entry_leaf_packing_cost(c, b) > gas_cap) {
            out.push(count);
            count = 0;
            nb = 0;
        }
        count += 1;
        nb += len;
        let record_bytes = (2 + 1 + len + 1 + 32) as u64;
        if entry_leaf_blob_size(count, nb) >= ENTRY_LEAF_MIN_BYTES
            && (key as u64) < (record_bytes * TWO_32) / ENTRY_LEAF_TARGET_BYTES
        {
            out.push(count);
            count = 0;
            nb = 0;
        }
    }
    if count > 0 {
        out.push(count);
    }
    out
}

pub fn branch_group_sizes(keys: &[u32]) -> Vec<usize> {
    assert!(keys.len() >= 2, "a branch needs at least two children");
    let threshold = TWO_32 / BRANCH_BOUNDARY_ODDS;
    let mut sizes = Vec::new();
    let mut cur = 0;
    for &k in keys {
        cur += 1;
        if cur == BRANCH_MAX_CHILDREN || (cur >= 2 && (k as u64) < threshold) {
            sizes.push(cur);
            cur = 0;
        }
    }
    if cur > 0 {
        sizes.push(cur);
    }
    let last = sizes.len() - 1;
    if sizes[last] == 1 && last > 0 {
        if sizes[last - 1] < BRANCH_MAX_CHILDREN {
            sizes.pop();
            sizes[last - 1] += 1;
        } else {
            sizes[last - 1] = BRANCH_MAX_CHILDREN - 1;
            sizes[last] = 2;
        }
    }
    sizes
}

/// The fewest branch levels `leaf_count` leaves can need (every branch full).
pub fn branch_levels_needed(leaf_count: usize) -> u32 {
    let mut n = leaf_count;
    let mut levels = 0;
    while n > 1 {
        n = n.div_ceil(BRANCH_MAX_CHILDREN);
        levels += 1;
    }
    levels
}

fn too_many_levels(kind: &str, path: &str, levels: u32) -> String {
    format!("{kind} \"{path}\" needs {levels} node levels, more than the protocol's {NODE_MAX_LEVEL}")
}

fn u32_field(v: u64) -> Result<[u8; 4]> {
    u32::try_from(v).map(|x| x.to_be_bytes()).map_err(|_| format!("u32 {v} does not fit a node field"))
}

fn stack_branches(prefix: u8, leaves: Vec<Node>, with_bytes: bool, kind: &str, path: &str) -> Result<Vec<Node>> {
    let stride = if with_bytes { 42 } else { 36 };
    let mut all = leaves;
    let mut start = 0;
    let mut level: u8 = 0;
    while all.len() - start > 1 {
        level += 1;
        if level > NODE_MAX_LEVEL {
            return Err(too_many_levels(kind, path, level as u32));
        }
        let end = all.len();
        let keys: Vec<u32> = all[start..end].iter().map(|n| hash_key(&n.id)).collect();
        let mut at = start;
        let mut next = Vec::new();
        for g in branch_group_sizes(&keys) {
            let kids = &all[at..at + g];
            at += g;
            let mut blob = vec![0u8; branch_blob_size(g, with_bytes)];
            blob[0] = level;
            blob[1..3].copy_from_slice(&(g as u16).to_be_bytes());
            let mut running = 0u64;
            let mut running_bytes = 0u64;
            for (i, k) in kids.iter().enumerate() {
                running += k.count;
                running_bytes += k.size;
                if with_bytes && running_bytes > MAX_U48 {
                    return Err(format!("the file \"{path}\" totals {running_bytes} bytes, more than a chunk node records"));
                }
                let o = 3 + i * stride;
                blob[o..o + 32].copy_from_slice(&k.id);
                blob[o + 32..o + 36].copy_from_slice(&u32_field(running)?);
                if with_bytes {
                    blob[o + 36..o + 42].copy_from_slice(&u48_be(running_bytes));
                }
            }
            next.push(Node {
                id: node_id(prefix, &blob),
                blob,
                level,
                count: running,
                size: running_bytes,
                child_ids: kids.iter().map(|k| k.id).collect(),
            });
        }
        start = end;
        all.extend(next);
    }
    Ok(all)
}

fn finish(kind: TreeKind, nodes: Vec<Node>, count: u64) -> Tree {
    let root = nodes.last().expect("non-empty tree");
    Tree { kind, root: root.id, root_level: root.level, count, nodes }
}

/// Pack a file's chunk ids and data sizes (in order) into a chunk-node tree.
pub fn pack_chunk_tree(ids: &[H256], sizes: &[u64], path: &str) -> Result<Tree> {
    assert_eq!(ids.len(), sizes.len(), "one size per chunk id");
    if ids.is_empty() {
        return Ok(Tree::empty(TreeKind::Chunks));
    }
    let levels = branch_levels_needed(ids.len().div_ceil(CHUNK_LEAF_MAX_HASHES));
    if levels > NODE_MAX_LEVEL as u32 {
        return Err(too_many_levels("file", path, levels));
    }
    let keys: Vec<u32> = ids.iter().map(hash_key).collect();
    let mut leaves = Vec::new();
    let mut at = 0;
    for n in partition_chunk_leaves(&keys) {
        let mut blob = vec![0u8; chunk_leaf_blob_size(n)];
        let mut total = 0u64;
        for i in 0..n {
            let size = sizes[at + i];
            if size < 1 || size > MAX_U48 {
                return Err(format!("chunk {} has size {size}; sizes are 1 to 2^48 - 1", at + i));
            }
            blob[1 + 38 * i..33 + 38 * i].copy_from_slice(&ids[at + i]);
            blob[33 + 38 * i..39 + 38 * i].copy_from_slice(&u48_be(size));
            total += size;
        }
        if total > MAX_U48 {
            return Err(format!("the file \"{path}\" totals {total} bytes in one node"));
        }
        at += n;
        leaves.push(Node { id: node_id(CHUNK_NODE_PREFIX, &blob), blob, level: 0, count: n as u64, size: total, child_ids: Vec::new() });
    }
    let nodes = stack_branches(CHUNK_NODE_PREFIX, leaves, true, "file", path)?;
    Ok(finish(TreeKind::Chunks, nodes, ids.len() as u64))
}

/// Refuse a name the contract refuses: 1..255 bytes, not `.` or `..`, no `/` or `\`.
pub fn assert_entry_name(b: &[u8]) -> Result<()> {
    if b.is_empty() || b.len() > MAX_ENTRY_NAME_BYTES {
        return Err(format!("entry name {:?} is {} bytes; names are 1 to {MAX_ENTRY_NAME_BYTES} bytes", String::from_utf8_lossy(b), b.len()));
    }
    if b == b"." || b == b".." {
        return Err(format!("entry name {:?} is reserved", String::from_utf8_lossy(b)));
    }
    if b.iter().any(|&c| c == b'/' || c == b'\\') {
        return Err(format!("entry name {:?} contains \"/\" or \"\\\"", String::from_utf8_lossy(b)));
    }
    Ok(())
}

/// Sort entries by unsigned name bytes (shorter prefix first) and refuse duplicates.
pub fn sort_entries(entries: &mut [Entry]) -> Result<()> {
    entries.sort_by(|a, b| a.name_bytes().cmp(b.name_bytes()));
    for w in entries.windows(2) {
        if w[0].name_bytes() == w[1].name_bytes() {
            return Err(format!("duplicate entry name {:?}", w[1].name));
        }
    }
    Ok(())
}

/// Pack entries, already sorted by [`sort_entries`], into an entry-node tree.
pub fn pack_entry_tree(sorted: &[Entry], path: &str) -> Result<Tree> {
    if sorted.is_empty() {
        return Ok(Tree::empty(TreeKind::Entries));
    }
    for e in sorted {
        assert_entry_name(e.name_bytes())?;
    }
    let items: Vec<(usize, u32)> = sorted.iter().map(|e| (e.name_bytes().len(), name_key(e.name_bytes()))).collect();
    let counts = partition_entry_leaves(&items, ENTRY_LEAF_GAS_CAP);
    let levels = branch_levels_needed(counts.len());
    if levels > NODE_MAX_LEVEL as u32 {
        return Err(too_many_levels("directory", path, levels));
    }
    let mut leaves = Vec::with_capacity(counts.len());
    let mut from = 0;
    for n in counts {
        let g = &sorted[from..from + n];
        from += n;
        let nb: usize = g.iter().map(|e| e.name_bytes().len()).sum();
        let mut blob = Vec::with_capacity(entry_leaf_blob_size(n, nb));
        blob.push(0);
        blob.extend_from_slice(&(n as u16).to_be_bytes());
        let mut off = 0usize;
        for e in g {
            blob.extend_from_slice(&(off as u16).to_be_bytes());
            off += 1 + e.name_bytes().len() + 1 + 32;
        }
        for e in g {
            blob.push(e.name_bytes().len() as u8);
            blob.extend_from_slice(e.name_bytes());
            blob.push(u8::from(e.is_directory));
            blob.extend_from_slice(&e.cid);
        }
        debug_assert_eq!(blob.len(), entry_leaf_blob_size(n, nb));
        leaves.push(Node { id: node_id(ENTRY_NODE_PREFIX, &blob), blob, level: 0, count: n as u64, size: 0, child_ids: Vec::new() });
    }
    let nodes = stack_branches(ENTRY_NODE_PREFIX, leaves, false, "directory", path)?;
    Ok(finish(TreeKind::Entries, nodes, sorted.len() as u64))
}
