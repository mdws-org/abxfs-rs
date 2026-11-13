//! A project's files over HTTP on this machine, at `http://<project>.localhost:<port>/`, read from chain and
//! checked byte by byte as `read` checks them. Browsers send `*.localhost` to this machine and treat it as a secure
//! context, so each project gets an origin of its own and its scripts run as they would on a gateway, with no
//! public hostname and no server in between.
//!
//! Only names under `localhost` are answered, which keeps a page on another site from reaching this server through
//! a name of its own (DNS rebinding), and a request a browser marks as coming from another site is refused before
//! any chain read, so a web page cannot set this server reading. Connections, memory and the caches are bounded.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::chain::Client;
use crate::hex::to_hex;
use crate::project::{bamfs_read, current_root, parse_label, Current, Project, Store};
use crate::read::{read_tree, Kind};
use crate::Result;

/// How long a project's current root is used before it is asked for again.
const ROOT_TTL: Duration = Duration::from_secs(60);
/// Most trees, and most bytes across them, kept in memory.
const MAX_TREES: usize = 16;
pub const MAX_TREE_BYTES: usize = 1024 * 1024 * 1024;
/// Most project roots remembered.
const MAX_ROOTS: usize = 1024;
/// Connections handled at once; more are closed at once.
const MAX_CONNECTIONS: usize = 64;
/// A request's head is a few hundred bytes; past this it is not read.
const MAX_HEAD_BYTES: u64 = 16 * 1024;
/// The whole request head must arrive within this.
const HEAD_DEADLINE: Duration = Duration::from_secs(10);
/// Each write must make progress within this.
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);

/// One root's files: path (no leading slash) to (media type, bytes). A file root is kept under "".
struct Served {
    kind: Kind,
    files: HashMap<Vec<u8>, (String, Arc<Vec<u8>>)>,
    bytes: usize,
}

type TreeKey = ([u8; 32], Store);

struct State {
    own_rpc: Option<String>,
    roots: Mutex<HashMap<String, (Instant, Current)>>,
    trees: Mutex<HashMap<TreeKey, Arc<Served>>>,
    /// Reads under way, so that two requests for one root read it once.
    reading: Mutex<HashMap<TreeKey, Arc<Mutex<()>>>>,
    connections: AtomicUsize,
}

/// A lock that a panic elsewhere does not make unusable: every value behind these locks is a cache, whole after
/// any single insert.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Serve until the process is stopped, on 127.0.0.1 and, where the machine has it, [::1]. `own_rpc` is the
/// reader's own endpoint, believed alone for roots and used for every read; without it, roots need two public
/// endpoints that agree.
pub fn serve(port: u16, own_rpc: Option<String>) -> Result<()> {
    let v4 = TcpListener::bind(("127.0.0.1", port)).map_err(|e| format!("127.0.0.1:{port}: {e}"))?;
    let v6 = TcpListener::bind(("::1", port)).ok();
    eprintln!("serving ABX projects at http://<chain id>-<org>-<project>.localhost:{port}/ (stop with Ctrl-C)");
    let state = Arc::new(State {
        own_rpc,
        roots: Mutex::new(HashMap::new()),
        trees: Mutex::new(HashMap::new()),
        reading: Mutex::new(HashMap::new()),
        connections: AtomicUsize::new(0),
    });
    if let Some(v6) = v6 {
        let state = Arc::clone(&state);
        std::thread::spawn(move || accept(v6, state, port));
    }
    accept(v4, state, port);
    Ok(())
}

fn accept(listener: TcpListener, state: Arc<State>, port: u16) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        if state.connections.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            state.connections.fetch_sub(1, Ordering::SeqCst);
            continue;
        }
        let st = Arc::clone(&state);
        let spawned = std::thread::Builder::new().spawn(move || {
            let _ = handle(stream, &st, port);
            st.connections.fetch_sub(1, Ordering::SeqCst);
        });
        if spawned.is_err() {
            state.connections.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

struct Request {
    method: String,
    path: String,
    host: String,
    cross_site: bool,
}

/// One line of the request head, or None when the head is over its size or past its deadline.
fn head_line(stream: &TcpStream, r: &mut impl BufRead, start: Instant) -> Option<String> {
    let left = HEAD_DEADLINE.checked_sub(start.elapsed()).filter(|d| !d.is_zero())?;
    stream.set_read_timeout(Some(left)).ok()?;
    let mut line = String::new();
    match r.read_line(&mut line) {
        Ok(n) if n > 0 && line.ends_with('\n') => Some(line),
        _ => None,
    }
}

fn read_request(stream: &TcpStream) -> Option<Request> {
    let start = Instant::now();
    let mut r = BufReader::new(stream.take(MAX_HEAD_BYTES));
    let line = head_line(stream, &mut r, start)?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next()?.to_string(), parts.next()?.to_string());
    let (mut host, mut cross_site) = (String::new(), false);
    loop {
        let h = head_line(stream, &mut r, start)?;
        if h == "\r\n" || h == "\n" {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            let k = k.trim();
            if k.eq_ignore_ascii_case("host") {
                host = v.trim().to_ascii_lowercase();
            } else if k.eq_ignore_ascii_case("sec-fetch-site") {
                cross_site = v.trim().eq_ignore_ascii_case("cross-site");
            }
        }
    }
    let path = target.split(['?', '#']).next().unwrap_or("/").to_string();
    Some(Request { method, path, host, cross_site })
}

fn respond(stream: &mut TcpStream, status: &str, kind: &str, body: &[u8], head: bool, extra: &[(&str, String)]) -> std::io::Result<()> {
    stream.set_write_timeout(Some(WRITE_TIMEOUT))?;
    let mut h = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n",
        body.len()
    );
    for (k, v) in extra {
        h.push_str(&format!("{k}: {v}\r\n"));
    }
    h.push_str("\r\n");
    stream.write_all(h.as_bytes())?;
    if !head {
        stream.write_all(body)?;
    }
    stream.flush()
}

fn text(stream: &mut TcpStream, status: &str, msg: &str, head: bool) -> std::io::Result<()> {
    respond(stream, status, "text/plain; charset=utf-8", msg.as_bytes(), head, &[])
}

/// `%XX` decoded to bytes; anything malformed is left as it is.
fn percent_decode(s: &str) -> Vec<u8> {
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

/// The host name without its port or a trailing dot.
fn host_name(host: &str) -> &str {
    let name = match host.rsplit_once(':') {
        Some((h, p)) if p.bytes().all(|b| b.is_ascii_digit()) && (h.ends_with(']') || !h.contains(':')) => h,
        _ => host,
    };
    name.strip_suffix('.').unwrap_or(name)
}

fn handle(mut stream: TcpStream, state: &State, port: u16) -> std::io::Result<()> {
    let Some(req) = read_request(&stream) else { return Ok(()) };
    let head = req.method == "HEAD";
    if req.method != "GET" && !head {
        return text(&mut stream, "405 Method Not Allowed", "Only GET and HEAD.", false);
    }
    if req.cross_site {
        return text(&mut stream, "403 Forbidden", "Requests from other sites are not served.", head);
    }
    let name = host_name(&req.host);
    if name == "localhost" || name == "127.0.0.1" || name == "[::1]" {
        let page = format!("ABX projects read from chain on this machine.\n\nOpen http://<chain id>-<org contract>-<project number>.localhost:{port}/\nfor example http://8453-ab025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6-0.localhost:{port}/\n");
        return text(&mut stream, "200 OK", &page, head);
    }
    let Some(label) = name.strip_suffix(".localhost") else {
        return text(&mut stream, "421 Misdirected Request", "This server answers only names under localhost.", head);
    };
    let Some(project) = parse_label(label) else {
        return text(&mut stream, "404 Not Found", "Not a project name: use <chain id>-<org contract>-<project number>.", head);
    };
    let current = match root_for(state, &project) {
        Ok(c) => c,
        Err(e) => return text(&mut stream, "502 Bad Gateway", &format!("The project's current version could not be read: {e}"), head),
    };
    if current.root == [0u8; 32] {
        return text(&mut stream, "404 Not Found", "This project has published nothing to ABX FS or BAMFS.", head);
    }
    let served = match tree_for(state, &project, &current) {
        Ok(t) => t,
        Err(e) => return text(&mut stream, "502 Bad Gateway", &format!("The project's files could not be read and checked: {e}"), head),
    };
    let mut path = percent_decode(req.path.trim_start_matches('/'));
    if served.kind == Kind::File {
        path.clear();
    } else if path.is_empty() || path.ends_with(b"/") {
        path.extend_from_slice(b"index.html");
    } else if !served.files.contains_key(&path) && served.files.contains_key(&[path.as_slice(), b"/index.html"].concat()) {
        // A directory named without its slash: send the browser to the slashed form, so relative links resolve.
        return respond(&mut stream, "301 Moved Permanently", "text/plain; charset=utf-8", b"", head, &[("Location", format!("{}/", req.path))]);
    }
    let (status, found) = match served.files.get(&path) {
        Some(f) => ("200 OK", Some(f)),
        None => ("404 Not Found", served.files.get(b"404.html".as_slice())),
    };
    let extra = [("X-ABXFS-Root", to_hex(&current.root)), ("X-ABXFS-Agreed", format!("{} at block {}", current.sources.join(", "), current.block))];
    match found {
        Some((mime, bytes)) => respond(&mut stream, status, mime, bytes, head, &extra),
        None => text(&mut stream, "404 Not Found", "Not in this project.", head),
    }
}

fn root_for(state: &State, project: &Project) -> Result<Current> {
    let label = project.label();
    if let Some((at, c)) = lock(&state.roots).get(&label) {
        if at.elapsed() < ROOT_TTL {
            return Ok(c.clone());
        }
    }
    let c = current_root(project, state.own_rpc.as_deref())?;
    let mut roots = lock(&state.roots);
    if roots.len() >= MAX_ROOTS {
        roots.retain(|_, (at, _)| at.elapsed() < ROOT_TTL);
        if roots.len() >= MAX_ROOTS {
            roots.clear();
        }
    }
    roots.insert(label, (Instant::now(), c.clone()));
    Ok(c)
}

fn tree_for(state: &State, project: &Project, current: &Current) -> Result<Arc<Served>> {
    let key: TreeKey = (current.root, current.store);
    if let Some(t) = lock(&state.trees).get(&key) {
        return Ok(Arc::clone(t));
    }
    let gate = Arc::clone(lock(&state.reading).entry(key).or_default());
    let result = (|| {
        let _one = lock(&gate);
        if let Some(t) = lock(&state.trees).get(&key) {
            return Ok(Arc::clone(t));
        }
        let served = Arc::new(if current.store == Store::Bamfs { read_bamfs(state, project, &current.root)? } else { read_abxfs(state, project, &current.root)? });
        let mut trees = lock(&state.trees);
        let held: usize = trees.values().map(|t| t.bytes).sum();
        if trees.len() >= MAX_TREES || held + served.bytes > MAX_TREE_BYTES {
            trees.clear();
        }
        trees.insert(key, Arc::clone(&served));
        Ok(served)
    })();
    lock(&state.reading).remove(&key);
    result
}

fn media_type(raw: &[u8]) -> String {
    let mime = String::from_utf8_lossy(raw).trim().to_string();
    if mime.is_empty() || mime.contains(['\r', '\n']) {
        "application/octet-stream".to_string()
    } else {
        mime
    }
}

fn read_bamfs(state: &State, project: &Project, root: &[u8; 32]) -> Result<Served> {
    let tree = bamfs_read(project, state.own_rpc.as_deref(), root, MAX_TREE_BYTES)?;
    let kind = if tree.is_file { Kind::File } else { Kind::Directory };
    let bytes = tree.bytes;
    let files = tree.files.into_iter().map(|f| (f.path.into_bytes(), (media_type(f.mime.as_bytes()), f.content))).collect();
    Ok(Served { kind, files, bytes })
}

fn read_abxfs(state: &State, project: &Project, root: &[u8; 32]) -> Result<Served> {
    let client = Client::connect(project.chain, state.own_rpc.as_deref(), 8)?;
    let tree = read_tree(&client, root, true)?;
    let mut shared: HashMap<[u8; 32], Arc<Vec<u8>>> = HashMap::new();
    let mut bytes = 0usize;
    let mut files = HashMap::new();
    for p in tree.paths()? {
        if p.kind != Kind::File {
            continue;
        }
        let f = tree.files.get(&p.cid).ok_or("a file was listed but not read")?;
        let content = match shared.get(&p.cid) {
            Some(c) => Arc::clone(c),
            None => {
                let c = Arc::new(f.content.clone().ok_or("a file's content was not read")?);
                bytes += c.len();
                if bytes > MAX_TREE_BYTES {
                    return Err(format!("the project holds more than {} MiB, more than this server keeps", MAX_TREE_BYTES / 1048576));
                }
                shared.insert(p.cid, Arc::clone(&c));
                c
            }
        };
        files.insert(p.path.clone(), (media_type(&f.info.mime), content));
    }
    Ok(Served { kind: tree.kind, files, bytes })
}

#[cfg(test)]
mod tests {
    use super::{host_name, percent_decode};

    #[test]
    fn decoding() {
        assert_eq!(percent_decode("a%20b"), b"a b");
        assert_eq!(percent_decode("%E2%9C%93"), "✓".as_bytes());
        assert_eq!(percent_decode("100%"), b"100%");
        assert_eq!(percent_decode("%zz"), b"%zz");
        assert_eq!(percent_decode("%4"), b"%4");
    }

    #[test]
    fn hosts() {
        assert_eq!(host_name("1-ab-0.localhost:8090"), "1-ab-0.localhost");
        assert_eq!(host_name("1-ab-0.localhost.:8090"), "1-ab-0.localhost");
        assert_eq!(host_name("1-ab-0.localhost"), "1-ab-0.localhost");
        assert_eq!(host_name("[::1]:8090"), "[::1]");
        assert_eq!(host_name("evil.example"), "evil.example");
    }
}
