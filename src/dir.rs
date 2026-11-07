//! Fold `path → file CID` pairs into directories (SDK `plan.ts` `planDirectoryTree`).

use std::collections::HashMap;

use crate::ids::{directory_cid, H256};
use crate::nodes::{pack_entry_tree, sort_entries, Entry, Tree};
use crate::Result;

#[derive(Clone, Debug)]
pub struct PlannedDirectory {
    pub cid: H256,
    /// POSIX path, `""` for the root.
    pub path: String,
    /// Sorted by unsigned name bytes.
    pub entries: Vec<Entry>,
    pub tree: Tree,
    /// 0 with no subdirectory, else 1 + the tallest subdirectory's height.
    pub height: u32,
}

/// Insertion-ordered map, matching the JS `Map` iteration the SDK walks in.
#[derive(Default)]
struct Ordered<T> {
    items: Vec<(String, T)>,
    index: HashMap<String, usize>,
}

impl<T> Ordered<T> {
    fn has(&self, k: &str) -> bool {
        self.index.contains_key(k)
    }
    fn get_or_insert_with(&mut self, k: &str, f: impl FnOnce() -> T) -> &mut T {
        let i = match self.index.get(k) {
            Some(&i) => i,
            None => {
                self.items.push((k.to_string(), f()));
                self.index.insert(k.to_string(), self.items.len() - 1);
                self.items.len() - 1
            }
        };
        &mut self.items[i].1
    }
    fn insert(&mut self, k: &str, v: T) {
        self.index.insert(k.to_string(), self.items.len());
        self.items.push((k.to_string(), v));
    }
}

#[derive(Default)]
struct TreeNode {
    files: Ordered<H256>,
    dirs: Ordered<TreeNode>,
}

fn descend<'a>(root: &'a mut TreeNode, parts: &[&str]) -> Result<&'a mut TreeNode> {
    let mut cur = root;
    for seg in parts {
        if cur.files.has(seg) {
            return Err(format!("\"{seg}\" is both a file and a directory"));
        }
        cur = cur.dirs.get_or_insert_with(seg, TreeNode::default);
    }
    Ok(cur)
}

/// `validateRelativePath`: non-empty, relative, no empty, `.` or `..` segment.
pub fn validate_relative_path(path: &str) -> Result<()> {
    if path.is_empty() {
        return Err("path is empty".into());
    }
    if path.starts_with('/') {
        return Err(format!("path must be relative: {path}"));
    }
    if let Some(p) = path.split('/').find(|p| p.is_empty() || *p == "." || *p == "..") {
        return Err(format!("invalid path component \"{p}\" in {path}"));
    }
    Ok(())
}

/// Returns the root CID and every directory, children first (the root, path `""`, last).
pub fn plan_directory_tree(files: &[(String, H256)], empty_directories: &[String]) -> Result<(H256, Vec<PlannedDirectory>)> {
    let mut root = TreeNode::default();
    for (path, cid) in files {
        let parts: Vec<&str> = path.split('/').collect();
        let (name, dirs) = parts.split_last().expect("split yields one part");
        let dir = descend(&mut root, dirs)?;
        if dir.dirs.has(name) {
            return Err(format!("\"{path}\" is both a file and a directory"));
        }
        if dir.files.has(name) {
            return Err(format!("\"{path}\" is in this tree twice; every path must be unique"));
        }
        dir.files.insert(name, *cid);
    }
    for d in empty_directories {
        validate_relative_path(d)?;
        let parts: Vec<&str> = d.split('/').collect();
        descend(&mut root, &parts)?;
    }
    let mut out = Vec::new();
    let cid = walk(&root, "", &mut out)?;
    Ok((cid, out))
}

fn walk(node: &TreeNode, path: &str, out: &mut Vec<PlannedDirectory>) -> Result<H256> {
    let mut entries = Vec::with_capacity(node.files.items.len() + node.dirs.items.len());
    for (name, cid) in &node.files.items {
        entries.push(Entry { name: name.clone(), cid: *cid, is_directory: false });
    }
    let mut height: Option<u32> = None;
    for (name, child) in &node.dirs.items {
        let child_path = if path.is_empty() { name.clone() } else { format!("{path}/{name}") };
        let child_cid = walk(child, &child_path, out)?;
        let h = out.last().expect("child pushed").height;
        height = Some(height.map_or(h, |m| m.max(h)));
        entries.push(Entry { name: name.clone(), cid: child_cid, is_directory: true });
    }
    sort_entries(&mut entries)?;
    let tree = pack_entry_tree(&entries, path)?;
    let cid = directory_cid(&tree.root);
    out.push(PlannedDirectory { cid, path: path.to_string(), entries, tree, height: height.map_or(0, |h| h + 1) });
    Ok(cid)
}
