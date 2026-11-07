//! Compares `abxfs-rs plan` against reference outputs produced by Art Blocks' own SDK and CLI scanner
//! (`oracle/golden/*.json`, written by `oracle/golden.mjs`). Every field except the generator's tool label
//! must be equal.

use std::path::{Path, PathBuf};
use std::process::Command;

use abxfs::json::plan_json;
use abxfs::plan::{plan_folder, PlanOptions};
use abxfs::scan::ScanOptions;
use serde_json::Value;

fn oracle() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("oracle")
}

fn golden(name: &str, fastlz: bool) -> Value {
    let file = if fastlz { format!("{name}.json") } else { format!("{name}.nofastlz.json") };
    let text = std::fs::read_to_string(oracle().join("golden").join(file)).expect("golden file");
    serde_json::from_str(&text).expect("golden json")
}

/// First difference between `want` and `got`, as a JSON path with both values.
fn first_diff(path: &str, want: &Value, got: &Value) -> Option<String> {
    match (want, got) {
        (Value::Object(w), Value::Object(g)) => {
            for (k, wv) in w {
                let p = format!("{path}.{k}");
                match g.get(k) {
                    None => return Some(format!("{p}: missing (want {})", short(wv))),
                    Some(gv) => {
                        if let Some(d) = first_diff(&p, wv, gv) {
                            return Some(d);
                        }
                    }
                }
            }
            g.keys().find(|k| !w.contains_key(*k)).map(|k| format!("{path}.{k}: unexpected field"))
        }
        (Value::Array(w), Value::Array(g)) => {
            for (i, (wv, gv)) in w.iter().zip(g).enumerate() {
                if let Some(d) = first_diff(&format!("{path}[{i}]"), wv, gv) {
                    return Some(d);
                }
            }
            (w.len() != g.len()).then(|| format!("{path}: length {} want {}", g.len(), w.len()))
        }
        _ => (want != got).then(|| format!("{path}: got {} want {}", short(got), short(want))),
    }
}

fn short(v: &Value) -> String {
    let s = v.to_string();
    if s.len() > 120 {
        format!("{}…", &s[..120])
    } else {
        s
    }
}

fn check(name: &str, fastlz: bool) {
    let folder = oracle().join(format!("corpus-{name}"));
    let opts = PlanOptions { fastlz, ..PlanOptions::default() };
    let plan = plan_folder(&folder, &ScanOptions::default(), &opts, true).expect("plan");
    let mut got = serde_json::to_value(plan_json(&plan)).unwrap();
    let mut want = golden(name, fastlz);
    // The generator block names the producing tool; compare what it says about the plan, not who wrote it.
    let wg = want.as_object_mut().unwrap().remove("generator").unwrap();
    let gg = got.as_object_mut().unwrap().remove("generator").unwrap();
    assert_eq!(wg["fastLz"], gg["fastLz"], "{name}: generator.fastLz");
    assert_eq!(wg["backends"], gg["backends"], "{name}: generator.backends");
    // Files first: a chunk or node mismatch is reported where it starts, not at the directory it propagates to.
    let mode = if fastlz { "fastlz" } else { "no-fastlz" };
    for key in ["files", "directories", "rootCid", "uniqueChunks", "storedBytes", "logicalBytes"] {
        if let Some(d) = first_diff(&format!("$.{key}"), &want[key], &got[key]) {
            panic!("{name} ({mode}): {d}");
        }
    }
    if let Some(d) = first_diff("$", &want, &got) {
        panic!("{name} ({mode}): {d}");
    }
}

#[test]
fn abx_site() {
    check("abx-site", true);
}

#[test]
fn abx_site_nofastlz() {
    check("abx-site", false);
}

#[test]
fn find3r() {
    check("find3r", true);
}

#[test]
fn find3r_nofastlz() {
    check("find3r", false);
}

#[test]
fn edge() {
    check("edge", true);
}

#[test]
fn edge_nofastlz() {
    check("edge", false);
}

/// The binary prints the same plan as the library.
#[test]
fn cli_json_matches_golden_root() {
    let out = Command::new(env!("CARGO_BIN_EXE_abxfs-rs"))
        .args(["plan", oracle().join("corpus-find3r").to_str().unwrap(), "--no-fastlz", "--json"])
        .output()
        .expect("run abxfs-rs");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let got: Value = serde_json::from_slice(&out.stdout).unwrap();
    let want = golden("find3r", false);
    assert_eq!(got["rootCid"], want["rootCid"]);
    assert_eq!(got["files"], want["files"]);
    assert_eq!(got["directories"], want["directories"]);
}

/// Optional corpus from `scratch/make-extra.mjs` (reference output from `oracle/golden.mjs`): chunk-node branches,
/// UTF-16 vs byte name order, `Object.prototype` extensions, skipped names. Skipped when not generated.
fn check_extra(fastlz: bool) {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("scratch");
    let file = dir.join(if fastlz { "extra.json" } else { "extra.nofastlz.json" });
    let Ok(text) = std::fs::read_to_string(&file) else {
        eprintln!("skipping: {} not generated", file.display());
        return;
    };
    let mut want: Value = serde_json::from_str(&text).unwrap();
    let opts = PlanOptions { fastlz, ..PlanOptions::default() };
    // golden.mjs plans `scan.files` only, so the empty directory this corpus has (`sub`) is left out here too.
    let plan = plan_folder(&dir.join("extra"), &ScanOptions::default(), &opts, false).expect("plan");
    let mut got = serde_json::to_value(plan_json(&plan)).unwrap();
    want.as_object_mut().unwrap().remove("generator");
    got.as_object_mut().unwrap().remove("generator");
    for f in want["files"].as_array_mut().unwrap() {
        // A mime that is an `Object.prototype` member is not a string in the reference: JSON.stringify drops the
        // `constructor` function and writes the prototype object as `{}`. The CID commits to its String() form.
        match f.get("mimeType") {
            None => f["mimeType"] = Value::String("function Object() { [native code] }".into()),
            Some(Value::Object(_)) => f["mimeType"] = Value::String("[object Object]".into()),
            _ => {}
        }
    }
    for key in ["files", "directories", "rootCid", "uniqueChunks", "storedBytes", "logicalBytes"] {
        if let Some(d) = first_diff(&format!("$.{key}"), &want[key], &got[key]) {
            panic!("extra ({fastlz}): {d}");
        }
    }
}

#[test]
fn extra() {
    check_extra(true);
}

#[test]
fn extra_nofastlz() {
    check_extra(false);
}
