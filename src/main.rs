use std::io::{self, BufWriter, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::Ordering;
use std::time::Instant;

use abxfs::chain::{chain_by_name, Client};
use abxfs::hex::{parse_h256, to_hex};
use abxfs::json::plan_json;
use abxfs::plan::{plan_folder, PlanOptions};
use abxfs::project::{bamfs_read, current_root, parse_label, Store};
use abxfs::read::{read_tree, write_tree, Kind};
use abxfs::scan::ScanOptions;
use abxfs::verify::{verify, DiffKind};

const USAGE: &str = "usage:
  abxfs-rs plan <folder> [--no-fastlz] [--include-hidden] [--no-empty-dirs] [--json]
  abxfs-rs read <root> --chain <name> [--rpc URL] [--out PATH] [--in-flight N]
  abxfs-rs read <project> [--rpc URL] [--out PATH] [--in-flight N]
  abxfs-rs root <project> [--rpc URL]
  abxfs-rs serve [--port N] [--rpc URL]
  abxfs-rs bundle <project> --key abxfs.cid|bamfs.cid --root <root> --proof <proof.json> --out <bundle.car> [--rpc URL]
  abxfs-rs verify-bundle <bundle.car> [--out DIR]
  abxfs-rs verify <root> <local folder or file> --chain <name> [--rpc URL] [--in-flight N] [--include-hidden] [--no-fastlz]

plan     Plans an ABX FS upload of <folder> offline: every chunk id, node, file CID, directory CID, the root,
         and each file's IPFS CIDv1. Files are selected as the official CLI selects them.
           --no-fastlz        store every chunk through the raw backend
           --include-hidden   include dot-files and .git (the CLI's --include-hidden)
           --no-empty-dirs    leave out empty directories (the CLI uploads them)
           --json             print the whole plan as JSON

read     Reads a file or directory root from chain, checking every directory CID, node id, file CID and chunk id
         against the bytes returned. With --out, writes a file root to PATH, or a directory root as a new
         directory at PATH; without it, prints a listing.

root     Prints a project's current root. A project is <chain id>-<org contract>-<project number>, as the ABX FS
         gateway names its hosts. The root is read from the chain's public endpoints at one block and taken only
         when at least two answer and all agree; with --rpc, that endpoint alone is believed. No hash covers which
         root is current: this says what the endpoints agree on, not a proof.

serve    Serves projects on this machine at http://<project>.localhost:<port>/ (default port 8090), each file read
         from chain and checked as read checks it. Answers only names under localhost.

bundle   Writes an archive bundle (archive/ARCHIVE.md) of one version of a project: the content of <root>, read
         and checked from chain, with the binding proof in <proof.json> (made by tools/archive/proof.mjs). The bundle
         is verified before it is written; its listing goes to standard output.

verify-bundle
         Checks a bundle offline, as archive/ARCHIVE.md defines, and prints its listing (exit 0), or one line
         reject <class> <message> (exit 1). With --out, writes its files under DIR.

verify   Plans the local folder or file offline and compares its root with <root>. When they match, checks that
         every chunk, node, file and directory the plan needs exists on chain; when they differ, reads the chain
         tree and lists the paths that are missing on chain, extra on chain, or changed. A changed file that the
         chain stores with a file codec is read, decoded and compared with the local file; equal content is
         listed as 'same' and is not a difference. Exit 0 only on a full match, or when the only differences
         are such codec-encoded files.

  --chain <name>     base, base-sepolia, ethereum, sepolia, arbitrum-one, arbitrum-sepolia, robinhood
  --rpc <URL>        JSON-RPC endpoint (default: the chain's public endpoint)
  --in-flight <N>    most HTTP requests open at once (default 8)
  --stats            print request counts and timing to stderr";

enum Fail {
    Error(String),
    Mismatch,
}

impl From<String> for Fail {
    fn from(s: String) -> Self {
        Fail::Error(s)
    }
}

impl From<&str> for Fail {
    fn from(s: &str) -> Self {
        Fail::Error(s.to_string())
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(Fail::Mismatch) => ExitCode::FAILURE,
        Err(Fail::Error(e)) => {
            eprintln!("abxfs-rs: {e}");
            ExitCode::from(2)
        }
    }
}

fn run(args: &[String]) -> Result<(), Fail> {
    let Some((cmd, rest)) = args.split_first() else {
        return Err(Fail::Error(USAGE.into()));
    };
    if rest.iter().any(|a| a == "-h" || a == "--help") || cmd == "-h" || cmd == "--help" {
        println!("{USAGE}");
        return Ok(());
    }
    match cmd.as_str() {
        "plan" => Ok(cmd_plan(rest)?),
        "read" | "verify" => chain_cmd(cmd, rest),
        "bundle" => Ok(cmd_bundle(rest)?),
        "verify-bundle" => cmd_verify_bundle(rest),
        "root" => Ok(cmd_root(rest)?),
        "serve" => Ok(cmd_serve(rest)?),
        _ => Err(Fail::Error(format!("unknown command \"{cmd}\"\n\n{USAGE}"))),
    }
}

fn cmd_plan(rest: &[String]) -> Result<(), String> {
    let mut folder: Option<PathBuf> = None;
    let mut opts = PlanOptions::default();
    let mut scan = ScanOptions::default();
    let mut json = false;
    let mut empty_dirs = true;
    for a in rest {
        match a.as_str() {
            "--no-fastlz" => opts.fastlz = false,
            "--include-hidden" => scan.include_hidden = true,
            "--no-empty-dirs" => empty_dirs = false,
            "--json" => json = true,
            s if s.starts_with('-') => return Err(format!("unknown option \"{s}\"\n\n{USAGE}")),
            s if folder.is_none() => folder = Some(PathBuf::from(s)),
            s => return Err(format!("unexpected argument \"{s}\"")),
        }
    }
    let folder = folder.ok_or_else(|| USAGE.to_string())?;
    let plan = plan_folder(&folder, &scan, &opts, empty_dirs)?;
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    if json {
        serde_json::to_writer_pretty(&mut out, &plan_json(&plan)).map_err(|e| e.to_string())?;
        writeln!(out).map_err(|e| e.to_string())?;
    } else {
        let chunks: usize = plan.files.iter().map(|f| f.chunks.len()).sum();
        writeln!(out, "root          {}", to_hex(&plan.root_cid)).map_err(|e| e.to_string())?;
        writeln!(out, "files         {}", plan.files.len()).map_err(|e| e.to_string())?;
        writeln!(out, "directories   {}", plan.directories.len()).map_err(|e| e.to_string())?;
        writeln!(out, "chunks        {chunks} ({} unique)", plan.unique_chunks).map_err(|e| e.to_string())?;
        writeln!(out, "logical bytes {}", plan.logical_bytes).map_err(|e| e.to_string())?;
        writeln!(out, "stored bytes  {}", plan.stored_bytes).map_err(|e| e.to_string())?;
    }
    out.flush().map_err(|e| e.to_string())
}

fn chain_cmd(cmd: &str, rest: &[String]) -> Result<(), Fail> {
    let mut pos: Vec<&str> = Vec::new();
    let mut chain: Option<&str> = None;
    let mut rpc: Option<&str> = None;
    let mut out: Option<PathBuf> = None;
    let mut in_flight = 8usize;
    let mut stats = false;
    let mut scan = ScanOptions::default();
    let mut opts = PlanOptions::default();
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        let mut value = |name: &str| it.next().map(String::as_str).ok_or_else(|| format!("{name} needs a value"));
        match a.as_str() {
            "--chain" | "-c" => chain = Some(value("--chain")?),
            "--rpc" => rpc = Some(value("--rpc")?),
            "--out" | "-o" if cmd == "read" => out = Some(PathBuf::from(value("--out")?)),
            "--in-flight" => {
                in_flight = value("--in-flight")?.parse().map_err(|_| "--in-flight takes a positive whole number".to_string())?;
                if in_flight == 0 {
                    return Err(Fail::Error("--in-flight takes a positive whole number".into()));
                }
            }
            "--stats" => stats = true,
            "--include-hidden" if cmd == "verify" => scan.include_hidden = true,
            "--no-fastlz" if cmd == "verify" => opts.fastlz = false,
            s if s.starts_with('-') => return Err(Fail::Error(format!("unknown option \"{s}\"\n\n{USAGE}"))),
            s => pos.push(s),
        }
    }
    let want = if cmd == "read" { 1 } else { 2 };
    if pos.len() != want {
        return Err(Fail::Error(USAGE.into()));
    }
    // A project name in place of a root: its current root, on its own chain.
    let (root, chain) = match parse_label(pos[0]) {
        Some(project) if cmd == "read" => {
            let c = current_root(&project, rpc)?;
            if c.root == [0u8; 32] {
                return Err(Fail::Error(format!("{} has published nothing", project.label())));
            }
            if c.store == Store::Bamfs {
                if out.is_none() {
                    return Err(Fail::Error(format!("{} is on BAMFS: give --out to read it", project.label())));
                }
                eprintln!("{} is BAMFS root {} as {} agree at block {} (not proved)", project.label(), to_hex(&c.root), c.sources.join(", "), c.block);
                return Ok(write_bamfs(&bamfs_read(&project, rpc, &c.root, abxfs::serve::MAX_TREE_BYTES)?, out.as_deref().expect("checked"))?);
            }
            eprintln!("{} is root {} as {} agree at block {} (not proved)", project.label(), to_hex(&c.root), c.sources.join(", "), c.block);
            (c.root, project.chain)
        }
        _ => (parse_h256(pos[0]).map_err(|e| format!("root {}: {e}", pos[0]))?, chain_by_name(chain.ok_or("--chain is required")?)?),
    };
    let t0 = Instant::now();
    let client = Client::connect(chain, rpc, in_flight)?;
    let result = if cmd == "read" { cmd_read(&client, &root, out) } else { cmd_verify(&client, &root, pos[1], &scan, &opts) };
    if stats {
        let s = &client.rpc.stats;
        eprintln!(
            "{:.2}s  rounds {}  views {}  eth_calls {}  codes {}  http {}  rpc items {}  retries {}  response {} bytes",
            t0.elapsed().as_secs_f64(),
            client.rounds.load(Ordering::Relaxed),
            client.views.load(Ordering::Relaxed),
            client.eth_calls.load(Ordering::Relaxed),
            client.codes.load(Ordering::Relaxed),
            s.http_requests.load(Ordering::Relaxed),
            s.items.load(Ordering::Relaxed),
            s.retries.load(Ordering::Relaxed),
            s.response_bytes.load(Ordering::Relaxed),
        );
    }
    result
}

fn write_bamfs(tree: &abxfs::bamfs::Tree, out: &std::path::Path) -> Result<(), String> {
    if tree.is_file {
        return std::fs::write(out, tree.files[0].content.as_slice()).map_err(|e| format!("{}: {e}", out.display()));
    }
    if out.exists() && std::fs::read_dir(out).map_err(|e| e.to_string())?.next().is_some() {
        return Err(format!("{} exists and is not empty", out.display()));
    }
    std::fs::create_dir_all(out).map_err(|e| format!("{}: {e}", out.display()))?;
    for d in &tree.dirs {
        std::fs::create_dir_all(out.join(d)).map_err(|e| format!("{d}: {e}"))?;
    }
    let mut bytes = 0;
    for f in &tree.files {
        std::fs::write(out.join(&f.path), f.content.as_slice()).map_err(|e| format!("{}: {e}", f.path))?;
        bytes += f.content.len();
    }
    for u in &tree.unusable {
        eprintln!("not written (its name cannot be a path part): {u}");
    }
    println!("verified and wrote BAMFS generation {} ({} files, {bytes} bytes) to {}", tree.generation, tree.files.len(), out.display());
    Ok(())
}

fn cmd_bundle(rest: &[String]) -> Result<(), String> {
    let (mut label, mut key, mut root, mut proof, mut out, mut rpc) = (None, None, None, None, None, None);
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        let mut value = |name: &str| it.next().cloned().ok_or_else(|| format!("{name} needs a value"));
        match a.as_str() {
            "--key" => key = Some(value("--key")?),
            "--root" => root = Some(value("--root")?),
            "--proof" => proof = Some(value("--proof")?),
            "--out" => out = Some(value("--out")?),
            "--rpc" => rpc = Some(value("--rpc")?),
            s if label.is_none() && !s.starts_with('-') => label = Some(s.to_string()),
            s => return Err(format!("unexpected argument \"{s}\"")),
        }
    }
    let (Some(label), Some(key), Some(root), Some(proof), Some(out)) = (label, key, root, proof, out) else { return Err(USAGE.to_string()) };
    let project = parse_label(&label).ok_or_else(|| format!("{label} is not <chain id>-<org contract>-<project number>"))?;
    let root = parse_h256(&root)?;
    let proof: serde_json::Value = serde_json::from_slice(&std::fs::read(&proof).map_err(|e| format!("{proof}: {e}"))?).map_err(|e| format!("the proof file is not JSON: {e}"))?;
    let mut blocks = Vec::new();
    let content = match key.as_str() {
        "abxfs.cid" => {
            let client = Client::connect(project.chain, rpc.as_deref(), 8)?;
            let tree = read_tree(&client, &root, true)?;
            abxfs::bundle::abxfs_content(&tree, &mut blocks)?
        }
        "bamfs.cid" => {
            let tree = bamfs_read(&project, rpc.as_deref(), &root, abxfs::serve::MAX_TREE_BYTES)?;
            abxfs::bundle::bamfs_content(&root, &tree, &mut blocks)?
        }
        k => return Err(format!("--key must be abxfs.cid or bamfs.cid, not {k}")),
    };
    let token = project.token.to_string();
    let bytes = abxfs::bundle::assemble(project.chain.id, &project.org, &token, &key, &root, proof, content, blocks)?;
    let v = abxfs::bundle_verify::verify(&bytes).map_err(|r| format!("the bundle made does not verify: {} {}", r.class, r.message))?;
    std::fs::write(&out, &bytes).map_err(|e| format!("{out}: {e}"))?;
    print!("{}", v.listing);
    eprintln!("wrote {out}: {} bytes, index {}", bytes.len(), abxfs::car::cid_text(&v.index_cid));
    Ok(())
}

fn cmd_verify_bundle(rest: &[String]) -> Result<(), Fail> {
    let (mut file, mut out) = (None, None);
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--out" => out = Some(PathBuf::from(it.next().ok_or_else(|| Fail::Error("--out needs a value".into()))?)),
            s if file.is_none() && !s.starts_with('-') => file = Some(s.to_string()),
            s => return Err(Fail::Error(format!("unexpected argument \"{s}\""))),
        }
    }
    let file = file.ok_or_else(|| Fail::Error(USAGE.into()))?;
    let bytes = std::fs::read(&file).map_err(|e| Fail::Error(format!("{file}: {e}")))?;
    match abxfs::bundle_verify::verify(&bytes) {
        Ok(v) => {
            if let Some(dir) = out {
                abxfs::bundle_verify::write_files(&v, &dir).map_err(Fail::Error)?;
            }
            print!("{}", v.listing);
            Ok(())
        }
        Err(r) => {
            println!("reject {} {}", r.class, r.message);
            std::process::exit(1);
        }
    }
}

fn cmd_root(rest: &[String]) -> Result<(), String> {
    let mut rpc: Option<&str> = None;
    let mut label: Option<&str> = None;
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--rpc" => rpc = Some(it.next().ok_or("--rpc needs a value")?),
            s if label.is_none() && !s.starts_with('-') => label = Some(s),
            s => return Err(format!("unexpected argument \"{s}\"")),
        }
    }
    let label = label.ok_or_else(|| USAGE.to_string())?;
    let project = parse_label(label).ok_or_else(|| format!("{label} is not <chain id>-<org contract>-<project number>"))?;
    let c = current_root(&project, rpc)?;
    let store = if c.store == Store::Bamfs { "bamfs" } else { "abxfs" };
    println!("{} {store} {}", to_hex(&c.root), c.block);
    eprintln!("{}: {} root at block {}, as {} agree (not proved)", project.label(), store, c.block, c.sources.join(", "));
    Ok(())
}

fn cmd_serve(rest: &[String]) -> Result<(), String> {
    let mut port = 8090u16;
    let mut rpc: Option<String> = None;
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--port" => port = it.next().ok_or("--port needs a value")?.parse().map_err(|_| "--port takes a number".to_string())?,
            "--rpc" => rpc = Some(it.next().ok_or("--rpc needs a value")?.clone()),
            s => return Err(format!("unexpected argument \"{s}\"")),
        }
    }
    abxfs::serve::serve(port, rpc)
}

fn lossy(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

fn cmd_read(client: &Client, root: &[u8; 32], out: Option<PathBuf>) -> Result<(), Fail> {
    let tree = read_tree(client, root, true)?;
    if let Some(out) = out {
        write_tree(&tree, &out)?;
        let files = tree.paths()?.iter().filter(|p| p.kind == Kind::File).count();
        let bytes: u64 = tree.files.values().map(|f| f.content.as_ref().map_or(0, |c| c.len() as u64)).sum();
        eprintln!("verified and wrote {} ({files} files, {bytes} bytes in {} unique files) to {}", to_hex(root), tree.files.len(), out.display());
        return Ok(());
    }
    let stdout = io::stdout();
    let mut w = BufWriter::new(stdout.lock());
    let io = |e: io::Error| Fail::Error(e.to_string());
    for p in tree.paths()? {
        match p.kind {
            Kind::Directory => writeln!(w, "d {} {}", to_hex(&p.cid), if p.path.is_empty() { ".".into() } else { lossy(&p.path) + "/" }).map_err(io)?,
            Kind::File => {
                let f = &tree.files[&p.cid];
                writeln!(w, "f {} {:>10} {} {}", to_hex(&p.cid), f.content.as_ref().map_or(0, |c| c.len()), lossy(&f.info.mime), if p.path.is_empty() { ".".into() } else { lossy(&p.path) })
                    .map_err(io)?
            }
        }
    }
    w.flush().map_err(io)
}

fn cmd_verify(client: &Client, root: &[u8; 32], local: &str, scan: &ScanOptions, opts: &PlanOptions) -> Result<(), Fail> {
    let r = verify(client, root, std::path::Path::new(local), scan, opts)?;
    println!("local root {}", to_hex(&r.local_root));
    println!("chain root {}", to_hex(&r.chain_root));
    if r.local_root == r.chain_root {
        if r.absent.is_empty() {
            println!("match: roots equal, all {} objects present on {}", r.probed, client.chain.name);
            return Ok(());
        }
        for (what, id) in &r.absent {
            println!("absent {what} {}", to_hex(id));
        }
        println!("roots equal, but {} of {} objects are not on {}", r.absent.len(), r.probed, client.chain.name);
        return Err(Fail::Mismatch);
    }
    let fmt = |x: &Option<(Kind, [u8; 32])>| match x {
        Some((Kind::File, c)) => format!("file {}", to_hex(c)),
        Some((Kind::Directory, c)) => format!("dir {}", to_hex(c)),
        None => "-".into(),
    };
    for d in &r.diffs {
        let tag = match d.kind {
            DiffKind::Missing => "missing",
            DiffKind::Extra => "extra  ",
            DiffKind::Changed => "changed",
        };
        let path = if d.path.is_empty() { ".".to_string() } else { lossy(&d.path) };
        println!("{tag} {path}  local: {}  chain: {}", fmt(&d.local), fmt(&d.chain));
    }
    for (p, codec) in &r.encoded_same {
        let path = if p.is_empty() { ".".to_string() } else { lossy(p) };
        println!("same    {path}  same content (stored {codec}-encoded)");
    }
    if r.ok() {
        println!(
            "content match: {} file(s) stored codec-encoded on chain, decoded content equal; the roots differ only because of that encoding, so a plain root comparison will not match",
            r.encoded_same.len()
        );
        return Ok(());
    }
    println!("roots differ: {} paths differ", r.diffs.len());
    Err(Fail::Mismatch)
}
