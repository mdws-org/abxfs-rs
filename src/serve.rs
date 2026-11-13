//! A project's files over HTTP on this machine, at `http://<project>.localhost:<port>/`, read from chain and
//! checked byte by byte as `read` checks them. Browsers send `*.localhost` to this machine and treat it as a secure
//! context, so each project gets an origin of its own and its scripts run as they would on a gateway, with no
//! public hostname and no server in between. Only names under `localhost` are answered, which keeps a page on
//! another site from reaching this server through a name of its own (DNS rebinding).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::chain::Client;
use crate::hex::to_hex;
use crate::project::{current_root, parse_label, Current, Store};
use crate::read::{read_tree, Kind};
use crate::Result;

/// How long a project's current root is used before it is asked for again.
const ROOT_TTL: Duration = Duration::from_secs(60);
/// Most trees kept in memory.
const MAX_TREES: usize = 16;

/// One root's files: path (no leading slash) to (media type, bytes). A file root is kept under "".
struct Served {
    kind: Kind,
    files: HashMap<Vec<u8>, (String, Arc<Vec<u8>>)>,
}

struct State {
    own_rpc: Option<String>,
    roots: Mutex<HashMap<String, (Instant, Current)>>,
    trees: Mutex<HashMap<[u8; 32], Arc<Served>>>,
    /// Reads under way, so that two requests for one root read it once.
    reading: Mutex<HashMap<[u8; 32], Arc<Mutex<()>>>>,
}

/// Serve until the process is stopped. `own_rpc` is the reader's own endpoint, believed alone for roots and
/// used for every read; without it, roots need two public endpoints that agree.
pub fn serve(port: u16, own_rpc: Option<String>) -> Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| format!("127.0.0.1:{port}: {e}"))?;
    eprintln!("serving ABX projects at http://<chain id>-<org>-<project>.localhost:{port}/ (stop with Ctrl-C)");
    let state = Arc::new(State { own_rpc, roots: Mutex::new(HashMap::new()), trees: Mutex::new(HashMap::new()), reading: Mutex::new(HashMap::new()) });
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let state = Arc::clone(&state);
        std::thread::spawn(move || {
            let _ = handle(stream, &state, port);
        });
    }
    Ok(())
}

struct Request {
    method: String,
    path: String,
    host: String,
}

fn read_request(stream: &TcpStream) -> Option<Request> {
    stream.set_read_timeout(Some(Duration::from_secs(10))).ok()?;
    let mut r = BufReader::new(stream);
    let mut line = String::new();
    r.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next()?.to_string(), parts.next()?.to_string());
    let mut host = String::new();
    for _ in 0..100 {
        let mut h = String::new();
        if r.read_line(&mut h).ok()? == 0 || h == "\r\n" || h == "\n" {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.trim().eq_ignore_ascii_case("host") {
                host = v.trim().to_ascii_lowercase();
            }
        }
    }
    let path = target.split(['?', '#']).next().unwrap_or("/").to_string();
    Some(Request { method, path, host })
}

fn respond(stream: &mut TcpStream, status: &str, kind: &str, body: &[u8], head: bool, extra: &[(&str, String)]) -> std::io::Result<()> {
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

fn handle(mut stream: TcpStream, state: &State, port: u16) -> std::io::Result<()> {
    let Some(req) = read_request(&stream) else { return Ok(()) };
    let head = req.method == "HEAD";
    if req.method != "GET" && !head {
        return text(&mut stream, "405 Method Not Allowed", "Only GET and HEAD.", false);
    }
    let name = req.host.rsplit_once(':').map_or(req.host.as_str(), |(h, _)| h);
    if name == "localhost" || name == "127.0.0.1" {
        let page = format!("ABX projects read from chain on this machine.\n\nOpen http://<chain id>-<org contract>-<project number>.localhost:{port}/\nfor example http://8453-ab025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6-0.localhost:{port}/\n");
        return text(&mut stream, "200 OK", &page, head);
    }
    let Some(label) = name.strip_suffix(".localhost") else {
        return text(&mut stream, "421 Misdirected Request", "This server answers only names under localhost.", head);
    };
    let Some(project) = parse_label(label) else {
        return text(&mut stream, "404 Not Found", "Not a project name: use <chain id>-<org contract>-<project number>.", head);
    };
    let current = match root_for(state, label, &project) {
        Ok(c) => c,
        Err(e) => return text(&mut stream, "502 Bad Gateway", &format!("The project's current version could not be read: {e}"), head),
    };
    if current.root == [0u8; 32] {
        return text(&mut stream, "404 Not Found", "This project has published nothing to ABX FS or BAMFS.", head);
    }
    if current.store == Store::Bamfs {
        return text(&mut stream, "501 Not Implemented", "This project is on BAMFS, which this server does not read yet.", head);
    }
    let served = match tree_for(state, &project, &current.root) {
        Ok(t) => t,
        Err(e) => return text(&mut stream, "502 Bad Gateway", &format!("The project's files could not be read and checked: {e}"), head),
    };
    let mut path = percent_decode(req.path.trim_start_matches('/'));
    if served.kind == Kind::File {
        path.clear();
    } else if path.is_empty() || path.ends_with(b"/") {
        path.extend_from_slice(b"index.html");
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

fn root_for(state: &State, label: &str, project: &crate::project::Project) -> Result<Current> {
    if let Some((at, c)) = state.roots.lock().unwrap().get(label) {
        if at.elapsed() < ROOT_TTL {
            return Ok(c.clone());
        }
    }
    let c = current_root(project, state.own_rpc.as_deref())?;
    state.roots.lock().unwrap().insert(label.to_string(), (Instant::now(), c.clone()));
    Ok(c)
}

fn tree_for(state: &State, project: &crate::project::Project, root: &[u8; 32]) -> Result<Arc<Served>> {
    if let Some(t) = state.trees.lock().unwrap().get(root) {
        return Ok(Arc::clone(t));
    }
    let gate = Arc::clone(state.reading.lock().unwrap().entry(*root).or_default());
    let _one = gate.lock().unwrap();
    if let Some(t) = state.trees.lock().unwrap().get(root) {
        return Ok(Arc::clone(t));
    }
    let client = Client::connect(project.chain, state.own_rpc.as_deref(), 8)?;
    let tree = read_tree(&client, root, true)?;
    let mut files = HashMap::new();
    for p in tree.paths()? {
        if p.kind != Kind::File {
            continue;
        }
        let f = &tree.files[&p.cid];
        let mime = String::from_utf8_lossy(&f.info.mime).trim().to_string();
        let mime = if mime.is_empty() || mime.contains(['\r', '\n']) { "application/octet-stream".to_string() } else { mime };
        let content = f.content.clone().ok_or("a file's content was not read")?;
        files.insert(p.path.clone(), (mime, Arc::new(content)));
    }
    let served = Arc::new(Served { kind: tree.kind, files });
    let mut trees = state.trees.lock().unwrap();
    if trees.len() >= MAX_TREES {
        trees.clear();
    }
    trees.insert(*root, Arc::clone(&served));
    Ok(served)
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn decoding() {
        assert_eq!(percent_decode("a%20b"), b"a b");
        assert_eq!(percent_decode("%E2%9C%93"), "✓".as_bytes());
        assert_eq!(percent_decode("100%"), b"100%");
        assert_eq!(percent_decode("%zz"), b"%zz");
        assert_eq!(percent_decode("%4"), b"%4");
    }
}
