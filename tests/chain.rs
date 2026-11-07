//! Chain integration tests: each root is read with the official CLI (`tests/oracle_read.py`, which only calls
//! `abxfs read`) and with `abxfs-rs read`, and the two trees must be byte-identical. Then `abxfs-rs verify` must
//! accept the CLI's tree and report the one known difference between two related roots.
//!
//! Skipped unless `ABXFS_RS_CHAIN_TESTS=1`. Needs network access and the official CLI (`ABXFS_CLI` overrides its
//! path). Roots and chains: `tests/README-chain.md`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

const ROOTS: &[(&str, &str)] = &[
    ("base-sepolia", "0xc63421c7cdd9644ade5fcf2ea1605b40b603486dabdf12433165f2e8d0a21944"),
    ("base-sepolia", "0x6a905f037744a4240660ed7bf5e11a48832a1c8c7b0f24cedc07a8915bfb60b5"),
    ("base-sepolia", "0x074dcfcdd0ad8852450742ab0725b606eaa12b6ec15e5708aa95b6b2c3d75c2b"),
    ("base", "0x8cd42455acde236bc9ee195565ad2f38e97778850d0be4792e82655b0200f522"),
    ("base", "0xa3c966cf8a3122c3f882bf365a3cd9f08de512f2402d8c52cfcbb925fe4cb0b0"),
];

fn enabled() -> bool {
    std::env::var("ABXFS_RS_CHAIN_TESTS").as_deref() == Ok("1")
}

fn scratch(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("abxfs-rs-chain-{}-{tag}", std::process::id()));
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_abxfs-rs")
}

/// `relative path → Some(bytes)` for files, `None` for directories.
fn snapshot(root: &Path) -> BTreeMap<String, Option<Vec<u8>>> {
    let mut out = BTreeMap::new();
    if root.is_file() {
        out.insert(String::new(), Some(std::fs::read(root).unwrap()));
        return out;
    }
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, Option<Vec<u8>>>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            let rel = p.strip_prefix(base).unwrap().to_string_lossy().into_owned();
            if p.is_dir() {
                out.insert(rel, None);
                walk(base, &p, out);
            } else {
                out.insert(rel, Some(std::fs::read(&p).unwrap()));
            }
        }
    }
    walk(root, root, &mut out);
    out
}

fn official_read(chain: &str, root: &str, out: &Path) {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/oracle_read.py");
    let st = Command::new("/opt/homebrew/bin/python3").arg(script).args([root, chain]).arg(out).status().unwrap();
    assert!(st.success(), "official CLI read of {root} failed");
}

#[test]
fn read_matches_official_cli() {
    if !enabled() {
        eprintln!("skipped: set ABXFS_RS_CHAIN_TESTS=1");
        return;
    }
    let dir = scratch("read");
    for (i, (chain, root)) in ROOTS.iter().enumerate() {
        let off = dir.join(format!("official-{i}"));
        let ours = dir.join(format!("ours-{i}"));
        official_read(chain, root, &off);
        let st = Command::new(bin()).args(["read", root, "--chain", chain, "--out"]).arg(&ours).status().unwrap();
        assert!(st.success(), "abxfs-rs read {root} failed");
        let (a, b) = (snapshot(&off), snapshot(&ours));
        assert_eq!(a.keys().collect::<Vec<_>>(), b.keys().collect::<Vec<_>>(), "{root}: paths differ");
        for (k, v) in &a {
            assert!(b[k] == *v, "{root}: {k} differs");
        }
        assert!(!a.is_empty());
    }
}

#[test]
fn verify_against_official_trees() {
    if !enabled() {
        eprintln!("skipped: set ABXFS_RS_CHAIN_TESTS=1");
        return;
    }
    let dir = scratch("verify");
    let c634 = "0xc63421c7cdd9644ade5fcf2ea1605b40b603486dabdf12433165f2e8d0a21944";
    let a289 = "0xa2893e53b3067fce8bfac986427ee0e0195b82f2d1cf86ef7b307f914df18ab8";
    let local = dir.join("a289");
    official_read("base-sepolia", a289, &local);

    let ok = Command::new(bin()).args(["verify", a289]).arg(&local).args(["--chain", "base-sepolia"]).output().unwrap();
    assert!(ok.status.success(), "verify of the official tree failed: {}", String::from_utf8_lossy(&ok.stdout));

    // The CLI lists the two roots with the same entries except style.css; the root directory, which holds it,
    // differs too.
    let diff = Command::new(bin()).args(["verify", c634]).arg(&local).args(["--chain", "base-sepolia"]).output().unwrap();
    assert_eq!(diff.status.code(), Some(1));
    let text = String::from_utf8_lossy(&diff.stdout);
    let lines: Vec<&str> = text.lines().filter(|l| l.starts_with("missing") || l.starts_with("extra") || l.starts_with("changed")).collect();
    assert_eq!(lines.len(), 2, "{text}");
    assert!(lines[0].starts_with("changed .  "), "{text}");
    assert!(lines[1].starts_with("changed style.css"), "{text}");

    // Same content on a chain that does not hold it: roots equal, objects absent.
    let absent = Command::new(bin()).args(["verify", a289]).arg(&local).args(["--chain", "arbitrum-sepolia"]).output().unwrap();
    assert_eq!(absent.status.code(), Some(1));
}
