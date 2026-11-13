//! Making an archive bundle (archive/ARCHIVE.md): one project version's content, read and checked from chain, with
//! the binding proof a separate step gathered, written as a CAR whose bytes depend only on what they hold.
//!
//! The content holds exactly what a verifier's walk reaches: a file with a codec (or a compressed BAMFS file)
//! carries its decoded bytes and none of its chunks, so nodes and chunks the reader fetched for it are left out.

use std::collections::{BTreeMap, HashSet};

use serde_json::{json, Map, Value};

use crate::bamfs;
use crate::car;
use crate::hex::to_hex;
use crate::ids::H256;
use crate::read::{ChainTree, Kind};
use crate::Result;

/// Values up to this length are written as hex in the index; longer ones as blocks.
const INLINE: usize = 1024;

struct Out {
    blocks: Vec<Vec<u8>>,
}

impl Out {
    /// A byte string (section 1).
    fn bytes(&mut self, b: &[u8]) -> Value {
        if b.len() <= INLINE {
            return Value::String(to_hex(b));
        }
        let mut links = Vec::new();
        for piece in b.chunks(car::MAX_BLOCK) {
            links.push(json!({ "/": car::cid_text(&car::raw_cid(piece)) }));
            self.blocks.push(piece.to_vec());
        }
        Value::Array(links)
    }
}

fn hx(b: &[u8]) -> Value {
    Value::String(to_hex(b))
}

/// The children of a branch blob, `stride` bytes each.
fn children(blob: &[u8], stride: usize) -> Vec<H256> {
    let n = u16::from_be_bytes([blob[1], blob[2]]) as usize;
    (0..n).map(|i| blob[3 + stride * i..35 + stride * i].try_into().unwrap()).collect()
}

/// Every node under `id`, and the leaves in order.
fn subtree(nodes: &std::collections::HashMap<H256, Vec<u8>>, id: &H256, stride: usize, keep: &mut BTreeMap<H256, Vec<u8>>, leaves: &mut Vec<Vec<u8>>) -> Result<()> {
    let blob = nodes.get(id).ok_or_else(|| format!("node {} was not read", to_hex(id)))?;
    keep.insert(*id, blob.clone());
    if blob[0] == 0 {
        leaves.push(blob.clone());
        return Ok(());
    }
    for c in children(blob, stride) {
        subtree(nodes, &c, stride, keep, leaves)?;
    }
    Ok(())
}

/// The content of an ABX FS root as section 7 lays it out.
pub fn abxfs_content(tree: &ChainTree, out_blocks: &mut Vec<Vec<u8>>) -> Result<Value> {
    let mut out = Out { blocks: std::mem::take(out_blocks) };
    let ev = &tree.evidence;
    let mut nodes = BTreeMap::new();
    let mut chunks: BTreeMap<H256, Value> = BTreeMap::new();
    let mut dirs = Vec::new();
    let mut seen_dirs: Vec<H256> = tree.dirs.keys().copied().collect();
    seen_dirs.sort();
    for cid in &seen_dirs {
        let root = *ev.dir_roots.get(cid).ok_or("a directory's root node was not kept")?;
        if root != [0u8; 32] {
            subtree(&ev.nodes, &root, 36, &mut nodes, &mut Vec::new())?;
        }
        dirs.push(json!({ "cid": hx(cid), "root": hx(&root) }));
    }
    let mut cids: Vec<&H256> = tree.files.keys().collect();
    cids.sort();
    let mut files = Vec::new();
    for cid in cids {
        let f = &tree.files[cid];
        let body = f.content.as_ref().ok_or("a file's content was not read")?;
        let mut o = Map::new();
        o.insert("cid".into(), hx(cid));
        o.insert("root".into(), hx(&f.info.root));
        o.insert("mime".into(), out.bytes(&f.info.mime));
        o.insert("codec".into(), hx(&f.info.codec));
        o.insert("outputHash".into(), hx(&f.info.output_hash));
        if f.info.codec != [0u8; 32] {
            o.insert("content".into(), out.bytes(body));
        } else if f.info.root != [0u8; 32] {
            let mut leaves = Vec::new();
            subtree(&ev.nodes, &f.info.root, 42, &mut nodes, &mut leaves)?;
            let mut at = 0usize;
            for l in leaves {
                for i in (1..l.len()).step_by(38) {
                    let id: H256 = l[i..i + 32].try_into().unwrap();
                    let size = l[i + 32..i + 38].iter().fold(0usize, |v, &x| (v << 8) | x as usize);
                    let data = body.get(at..at + size).ok_or("a file's chunks run past its content")?;
                    at += size;
                    let (backend, ih) = ev.chunks.get(&id).ok_or("a chunk's record was not kept")?;
                    let v = json!({ "backend": hx(backend), "inputHash": hx(ih), "data": out.bytes(data) });
                    chunks.insert(id, v);
                }
            }
            if at != body.len() {
                return Err("a file's chunks do not cover its content".into());
            }
        }
        files.push(Value::Object(o));
    }
    let nodes: Map<String, Value> = nodes.iter().map(|(id, b)| (to_hex(id), out.bytes(b))).collect();
    let chunks: Map<String, Value> = chunks.into_iter().map(|(id, v)| (to_hex(&id), v)).collect();
    *out_blocks = out.blocks;
    let _ = Kind::File;
    Ok(json!({ "store": "abxfs", "dirs": dirs, "files": files, "nodes": nodes, "chunks": chunks }))
}

/// The content of a BAMFS root as section 8 or 9 lays it out.
pub fn bamfs_content(root: &H256, tree: &bamfs::Tree, out_blocks: &mut Vec<Vec<u8>>) -> Result<Value> {
    let mut out = Out { blocks: std::mem::take(out_blocks) };
    let ev = &tree.evidence;
    let g2 = tree.generation == 2;
    let mut nodes = BTreeMap::new();
    let mut chunks: BTreeMap<H256, Value> = BTreeMap::new();
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    // Walk as a verifier does, from the root, so only what it reaches is kept.
    let mut stack = vec![(*root, !tree.is_file)];
    let mut done: HashSet<H256> = HashSet::new();
    while let Some((cid, is_dir)) = stack.pop() {
        if !done.insert(cid) {
            continue;
        }
        if is_dir {
            if g2 {
                let r = *ev.dir_roots.get(&cid).ok_or("a directory's root node was not kept")?;
                let mut leaves = Vec::new();
                subtree(&ev.nodes, &r, 36, &mut nodes, &mut leaves)?;
                for l in leaves {
                    for (_, d, c) in entry_records(&l)? {
                        stack.push((c, d));
                    }
                }
                dirs.push(json!({ "cid": hx(&cid), "root": hx(&r) }));
            } else {
                let es = ev.dir_entries.get(&cid).ok_or("a directory's entries were not kept")?;
                let mut list = Vec::new();
                for (name, d, c) in es {
                    stack.push((*c, *d));
                    list.push(json!({ "name": out.bytes(name), "cid": hx(c), "isDir": d }));
                }
                dirs.push(json!({ "cid": hx(&cid), "entries": list }));
            }
            continue;
        }
        let f = ev.files.get(&cid).ok_or("a file's record was not kept")?;
        let mut o = Map::new();
        o.insert("cid".into(), hx(&cid));
        o.insert("mime".into(), out.bytes(&f.mime));
        o.insert("compression".into(), json!(f.compression));
        o.insert("outputHash".into(), hx(&f.output_hash));
        if g2 {
            o.insert("root".into(), hx(&f.root));
            o.insert("size".into(), json!(f.size));
        } else {
            o.insert("chunks".into(), Value::Array(f.chunk_ids.iter().map(|c| hx(c)).collect()));
        }
        if f.compression != 0 {
            let body = file_bytes(tree, &cid)?;
            o.insert("content".into(), out.bytes(&body));
        } else {
            let ids: Vec<H256> = if g2 {
                let mut leaves = Vec::new();
                subtree(&ev.nodes, &f.root, 42, &mut nodes, &mut leaves)?;
                leaves.iter().flat_map(|l| (1..l.len()).step_by(34).map(move |i| l[i..i + 32].try_into().unwrap())).collect()
            } else {
                f.chunk_ids.clone()
            };
            for id in ids {
                let data = ev.chunks.get(&id).ok_or("a chunk was not kept")?;
                let v = out.bytes(data);
                chunks.insert(id, v);
            }
        }
        files.push(Value::Object(o));
    }
    dirs.sort_by(|a, b| a["cid"].as_str().cmp(&b["cid"].as_str()));
    files.sort_by(|a, b| a["cid"].as_str().cmp(&b["cid"].as_str()));
    let chunks: Map<String, Value> = chunks.into_iter().map(|(id, v)| (to_hex(&id), v)).collect();
    let mut c = json!({ "store": if g2 { "bamfs2" } else { "bamfs1" }, "dirs": dirs, "files": files, "chunks": chunks });
    if g2 {
        let nodes: Map<String, Value> = nodes.iter().map(|(id, b)| (to_hex(id), out.bytes(b))).collect();
        c["nodes"] = Value::Object(nodes);
    }
    *out_blocks = out.blocks;
    Ok(c)
}

/// A BAMFS file's decoded bytes, found by its CID through the tree's paths.
fn file_bytes(tree: &bamfs::Tree, cid: &H256) -> Result<Vec<u8>> {
    // The evidence keys files by CID; the tree keys contents by path. Find any path whose file has this CID by
    // matching the output hash of the decoded bytes.
    let f = &tree.evidence.files[cid];
    for file in &tree.files {
        if crate::ids::keccak256(&file.content) == f.output_hash {
            return Ok(file.content.as_ref().clone());
        }
    }
    Err(format!("the content of file {} was not kept", to_hex(cid)))
}

fn entry_records(leaf: &[u8]) -> Result<Vec<(Vec<u8>, bool, H256)>> {
    let n = u16::from_be_bytes([leaf[1], leaf[2]]) as usize;
    let mut at = 3 + 2 * n;
    let mut out = Vec::new();
    for _ in 0..n {
        let len = leaf[at] as usize;
        let name = leaf[at + 1..at + 1 + len].to_vec();
        let d = leaf[at + 1 + len] == 1;
        let c: H256 = leaf[at + 2 + len..at + 34 + len].try_into().map_err(|_| "an entry leaf is short")?;
        out.push((name, d, c));
        at += 34 + len;
    }
    Ok(out)
}

/// The index and bundle bytes for one version.
pub fn assemble(chain: u64, org: &[u8; 20], token: &str, key: &str, root: &H256, proof: Value, content: Value, blocks: Vec<Vec<u8>>) -> Result<Vec<u8>> {
    let index = json!({
        "format": "abx-archive/1",
        "project": { "chain": chain, "org": hx(org), "token": token, "key": key },
        "root": hx(root),
        "proof": proof,
        "content": content,
    });
    // serde_json's map keeps keys in ascending order, and to_vec writes no whitespace.
    let bytes = serde_json::to_vec(&index).map_err(|e| e.to_string())?;
    // The blocks in the order a walk of the index first links them, which is the order IPFS exports them in.
    let by_cid: std::collections::HashMap<Vec<u8>, Vec<u8>> = blocks.into_iter().map(|b| (car::raw_cid(&b), b)).collect();
    let mut order = Vec::new();
    link_order(&index, &mut order);
    let mut seen = HashSet::new();
    let ordered: Vec<Vec<u8>> = order.into_iter().filter(|c| seen.insert(c.clone())).map(|c| by_cid.get(&c).cloned().ok_or("the index links a block that was not made")).collect::<std::result::Result<_, _>>()?;
    car::write(&bytes, &ordered)
}

fn link_order(v: &Value, out: &mut Vec<Vec<u8>>) {
    match v {
        Value::Object(o) if o.len() == 1 && o.contains_key("/") => {
            if let Some(c) = o["/"].as_str().and_then(car::cid_from_text) {
                out.push(c);
            }
        }
        Value::Object(o) => {
            let mut kv: Vec<(&String, &Value)> = o.iter().collect();
            kv.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            kv.into_iter().for_each(|x| link_order(x.1, out));
        }
        Value::Array(a) => a.iter().for_each(|x| link_order(x, out)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    /// The index is written with keys in ascending order and no whitespace: the bundle's bytes depend on it.
    #[test]
    fn index_form() {
        let v = serde_json::json!({ "b": 1, "a": { "z": [1, 2], "c": "x" } });
        assert_eq!(serde_json::to_string(&v).unwrap(), r#"{"a":{"c":"x","z":[1,2]},"b":1}"#);
    }
}
