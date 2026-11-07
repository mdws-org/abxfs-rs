//! The plan as JSON, in the field layout of the reference generator (`oracle/golden.mjs`).

use serde::Serialize;

use crate::dir::PlannedDirectory;
use crate::hex::to_hex;
use crate::nodes::{Node, Tree};
use crate::plan::{Plan, PlannedChunk, PlannedFile};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanJson {
    pub generator: GeneratorJson,
    pub root_cid: String,
    pub unique_chunks: usize,
    pub stored_bytes: u64,
    pub logical_bytes: u64,
    pub files: Vec<FileJson>,
    pub directories: Vec<DirectoryJson>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorJson {
    pub tool: String,
    pub fast_lz: bool,
    pub backends: BackendsJson,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendsJson {
    pub raw: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fast_lz: Option<String>,
    pub max_input_size: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileJson {
    pub path: String,
    pub cid: String,
    pub mime_type: String,
    pub codec: String,
    pub output_hash: String,
    pub logical_size: u64,
    pub data_size: u64,
    pub stored_size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ipfs_cid: Option<String>,
    pub chunks: Vec<ChunkJson>,
    pub tree: TreeJson,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkJson {
    pub id: String,
    pub backend: String,
    pub input_hash: String,
    pub data_hash: String,
    pub size: u64,
    pub input_len: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeJson {
    pub kind: &'static str,
    pub root: String,
    pub root_level: u8,
    pub count: u64,
    pub nodes: Vec<NodeJson>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeJson {
    pub id: String,
    pub level: u8,
    pub count: u64,
    pub size: u64,
    pub child_ids: Vec<String>,
    pub blob: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryJson {
    pub path: String,
    pub cid: String,
    pub height: u32,
    pub entries: Vec<EntryJson>,
    pub tree: TreeJson,
}

#[derive(Serialize)]
pub struct EntryJson {
    pub name: String,
    pub kind: &'static str,
    pub cid: String,
}

fn node(n: &Node) -> NodeJson {
    NodeJson {
        id: to_hex(&n.id),
        level: n.level,
        count: n.count,
        size: n.size,
        child_ids: n.child_ids.iter().map(|c| to_hex(c)).collect(),
        blob: to_hex(&n.blob),
    }
}

fn tree(t: &Tree) -> TreeJson {
    TreeJson { kind: t.kind.as_str(), root: to_hex(&t.root), root_level: t.root_level, count: t.count, nodes: t.nodes.iter().map(node).collect() }
}

fn chunk(c: &PlannedChunk) -> ChunkJson {
    ChunkJson {
        id: to_hex(&c.id),
        backend: c.backend.checksummed.to_string(),
        input_hash: to_hex(&c.input_hash),
        data_hash: to_hex(&c.data_hash),
        size: c.size,
        input_len: c.input_len,
    }
}

fn file(f: &PlannedFile) -> FileJson {
    FileJson {
        path: f.path.clone(),
        cid: to_hex(&f.cid),
        mime_type: f.mime_type.clone(),
        codec: to_hex(&f.codec),
        output_hash: to_hex(&f.output_hash),
        logical_size: f.logical_size,
        data_size: f.data_size,
        stored_size: f.stored_size,
        ipfs_cid: f.ipfs_cid.clone(),
        chunks: f.chunks.iter().map(chunk).collect(),
        tree: tree(&f.tree),
    }
}

fn directory(d: &PlannedDirectory) -> DirectoryJson {
    DirectoryJson {
        path: d.path.clone(),
        cid: to_hex(&d.cid),
        height: d.height,
        entries: d
            .entries
            .iter()
            .map(|e| EntryJson { name: e.name.clone(), kind: if e.is_directory { "directory" } else { "file" }, cid: to_hex(&e.cid) })
            .collect(),
        tree: tree(&d.tree),
    }
}

pub fn plan_json(p: &Plan) -> PlanJson {
    PlanJson {
        generator: GeneratorJson {
            tool: concat!("abxfs-rs@", env!("CARGO_PKG_VERSION")).to_string(),
            fast_lz: p.fastlz,
            backends: BackendsJson {
                raw: p.backends.raw.checksummed.to_string(),
                fast_lz: p.backends.fastlz.map(|b| b.checksummed.to_string()),
                max_input_size: p.backends.max_input_size,
            },
        },
        root_cid: to_hex(&p.root_cid),
        unique_chunks: p.unique_chunks,
        stored_bytes: p.stored_bytes,
        logical_bytes: p.logical_bytes,
        files: p.files.iter().map(file).collect(),
        directories: p.directories.iter().map(directory).collect(),
    }
}
