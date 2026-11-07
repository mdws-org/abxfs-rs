//! Browser entry points: plan files already in memory (a folder chosen in a file picker) with the same
//! selection rules and planner as the command line. Files arrive as relative paths, their sizes, and all
//! their bytes concatenated in that order.

use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::hex::to_hex;
use crate::json::plan_json;
use crate::plan::{plan_in_memory, Plan};

/// `dirs` are the dropped folder's directory paths (relative, no trailing slash); empty when the picker gave none.
fn plan_from(paths: Vec<String>, sizes: Vec<f64>, data: &[u8], fastlz: bool, include_hidden: bool, dirs: &[String]) -> Result<Plan, JsValue> {
    plan_in_memory(&paths, &sizes, data, fastlz, include_hidden, dirs).map_err(|e| JsValue::from_str(&e))
}

/// The complete plan, in the same JSON shape as `abxfs-rs plan --json`.
#[wasm_bindgen]
pub fn plan_files_json(paths: Vec<String>, sizes: Vec<f64>, data: &[u8], fastlz: bool, include_hidden: bool, dirs: Vec<String>) -> Result<String, JsValue> {
    let plan = plan_from(paths, sizes, data, fastlz, include_hidden, &dirs)?;
    serde_json::to_string(&plan_json(&plan)).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SummaryFile {
    path: String,
    cid: String,
    mime_type: String,
    logical_size: u64,
    stored_size: u64,
    ipfs_cid: Option<String>,
    chunk_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SummaryDir {
    path: String,
    cid: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    root_cid: String,
    unique_chunks: usize,
    stored_bytes: u64,
    logical_bytes: u64,
    files: Vec<SummaryFile>,
    directories: Vec<SummaryDir>,
}

/// What a page needs to show and check a plan: the root, each file's CID and chunk ids, each directory's CID.
#[wasm_bindgen]
pub fn plan_files_summary(paths: Vec<String>, sizes: Vec<f64>, data: &[u8], fastlz: bool, include_hidden: bool, dirs: Vec<String>) -> Result<String, JsValue> {
    let plan = plan_from(paths, sizes, data, fastlz, include_hidden, &dirs)?;
    let full = plan_json(&plan);
    let v = serde_json::to_value(&full).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let files = v["files"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|f| SummaryFile {
                    path: f["path"].as_str().unwrap_or_default().to_string(),
                    cid: f["cid"].as_str().unwrap_or_default().to_string(),
                    mime_type: f["mimeType"].as_str().unwrap_or_default().to_string(),
                    logical_size: f["logicalSize"].as_u64().unwrap_or(0),
                    stored_size: f["storedSize"].as_u64().unwrap_or(0),
                    ipfs_cid: f["ipfsCid"].as_str().map(str::to_string),
                    chunk_ids: f["chunks"]
                        .as_array()
                        .map(|c| c.iter().filter_map(|x| x["id"].as_str().map(str::to_string)).collect())
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    let directories = v["directories"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|d| SummaryDir {
                    path: d["path"].as_str().unwrap_or_default().to_string(),
                    cid: d["cid"].as_str().unwrap_or_default().to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    let s = Summary {
        root_cid: to_hex(&plan.root_cid),
        unique_chunks: v["uniqueChunks"].as_u64().unwrap_or(0) as usize,
        stored_bytes: v["storedBytes"].as_u64().unwrap_or(0),
        logical_bytes: v["logicalBytes"].as_u64().unwrap_or(0),
        files,
        directories,
    };
    serde_json::to_string(&s).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// The tool's version string, for the page footer.
#[wasm_bindgen]
pub fn version() -> String {
    concat!("abxfs-rs@", env!("CARGO_PKG_VERSION")).to_string()
}

/// The names an upload skips, as the page's folder walk needs them to avoid reading what the planner drops:
/// `ignore` always (hidden files are off on the page, so this includes `.git`), dot-names unless in `allow`.
#[wasm_bindgen]
pub fn upload_skip_rules() -> String {
    use crate::scan::{UPLOAD_DOT_ALLOWLIST, UPLOAD_IGNORE_NAMES, UPLOAD_VCS_NAMES};
    let ignore: Vec<&str> = UPLOAD_IGNORE_NAMES.iter().chain(UPLOAD_VCS_NAMES).copied().collect();
    serde_json::json!({ "ignore": ignore, "allow": UPLOAD_DOT_ALLOWLIST }).to_string()
}
