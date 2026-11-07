//! A small blocking JSON-RPC client: batch requests, a bounded pool of requests in flight, backoff on rate limits,
//! and splitting of a batch the endpoint refuses as too large.

use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use rayon::prelude::*;
use serde_json::{json, Value};

use crate::Result;

/// Tries per HTTP request before a transport failure or rate limit is reported.
const MAX_ATTEMPTS: u32 = 8;
/// Largest response body accepted.
const MAX_BODY_BYTES: u64 = 256 * 1024 * 1024;

/// An error object a JSON-RPC endpoint returned for one request.
#[derive(Clone, Debug)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    /// Revert data, when the endpoint returns it.
    pub data: Option<String>,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RPC error {}: {}", self.code, self.message)?;
        if let Some(d) = &self.data {
            write!(f, " (data {d})")?;
        }
        Ok(())
    }
}

impl RpcError {
    fn from_value(v: &Value) -> RpcError {
        RpcError {
            code: v.get("code").and_then(Value::as_i64).unwrap_or(0),
            message: v.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
            data: v.get("data").map(|d| d.as_str().map(str::to_string).unwrap_or_else(|| d.to_string())),
        }
    }

    /// The endpoint asked the client to slow down.
    pub fn is_rate_limit(&self) -> bool {
        let m = self.message.to_ascii_lowercase();
        matches!(self.code, 429 | -32005 | -32007 | -32016 | -32029)
            || m.contains("rate limit")
            || m.contains("too many requests")
            || m.contains("request limit")
            || m.contains("exceeded the quota")
    }
}

pub type ItemResult = std::result::Result<Value, RpcError>;

/// Counters for one client.
#[derive(Default, Debug)]
pub struct Stats {
    pub http_requests: AtomicU64,
    pub items: AtomicU64,
    pub retries: AtomicU64,
    pub response_bytes: AtomicU64,
}

pub struct Rpc {
    url: String,
    agent: ureq::Agent,
    pool: rayon::ThreadPool,
    pub stats: Stats,
}

enum Http {
    Ok(Value),
    /// The endpoint refused the body as a whole (too large, too many items, or batches unsupported).
    Refused(String),
}

impl Rpc {
    /// A client that keeps at most `in_flight` HTTP requests open at once.
    pub fn new(url: &str, in_flight: usize) -> Result<Rpc> {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .user_agent(concat!("abxfs-rs/", env!("CARGO_PKG_VERSION")))
            .build();
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(in_flight.max(1))
            .thread_name(|i| format!("rpc-{i}"))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Rpc { url: url.to_string(), agent, pool, stats: Stats::default() })
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    /// One request, its result or its error object.
    pub fn call(&self, method: &str, params: Value) -> Result<ItemResult> {
        let mut out = self.many(vec![json!({"method": method, "params": params})], 1)?;
        Ok(out.pop().expect("one result"))
    }

    /// Run every `{method, params}` in `items`, `per_request` to an HTTP batch, at most `in_flight` batches at a
    /// time. Results come back in the order of `items`. An item-level error is returned as that item's result; a
    /// transport failure that outlasts the retries is an `Err`.
    pub fn many(&self, items: Vec<Value>, per_request: usize) -> Result<Vec<ItemResult>> {
        let per = per_request.max(1);
        let groups: Vec<&[Value]> = items.chunks(per).collect();
        let results: Vec<Result<Vec<ItemResult>>> = self.pool.install(|| groups.par_iter().map(|g| self.batch(g)).collect());
        let mut out = Vec::with_capacity(items.len());
        for r in results {
            out.extend(r?);
        }
        Ok(out)
    }

    /// One batch, split in halves while the endpoint refuses it, with rate-limited items retried.
    fn batch(&self, items: &[Value]) -> Result<Vec<ItemResult>> {
        let mut results: Vec<Option<ItemResult>> = vec![None; items.len()];
        let mut todo: Vec<usize> = (0..items.len()).collect();
        let mut attempt = 0u32;
        while !todo.is_empty() {
            let reqs: Vec<Value> = todo.iter().map(|&i| items[i].clone()).collect();
            match self.post(&reqs)? {
                Http::Refused(why) => {
                    if reqs.len() == 1 {
                        return Err(format!("{} refused a single request: {why}", self.url));
                    }
                    let mid = todo.len() / 2;
                    let (a, b) = todo.split_at(mid);
                    for part in [a, b] {
                        let sub: Vec<Value> = part.iter().map(|&i| items[i].clone()).collect();
                        for (k, r) in self.batch(&sub)?.into_iter().enumerate() {
                            results[part[k]] = Some(r);
                        }
                    }
                    todo.clear();
                }
                Http::Ok(body) => {
                    let got = match_responses(&body, reqs.len())?;
                    let mut again = Vec::new();
                    for (k, r) in got.into_iter().enumerate() {
                        match r {
                            Err(e) if e.is_rate_limit() => again.push(todo[k]),
                            r => results[todo[k]] = Some(r),
                        }
                    }
                    if !again.is_empty() {
                        attempt += 1;
                        if attempt >= MAX_ATTEMPTS {
                            return Err(format!("{} kept rate-limiting {} requests", self.url, again.len()));
                        }
                        self.stats.retries.fetch_add(1, Ordering::Relaxed);
                        std::thread::sleep(backoff(attempt, None));
                    }
                    todo = again;
                }
            }
        }
        Ok(results.into_iter().map(|r| r.expect("every item answered")).collect())
    }

    /// One HTTP POST of a JSON-RPC batch, retried on transport failures, 429 and 5xx.
    fn post(&self, reqs: &[Value]) -> Result<Http> {
        let body: Vec<Value> = reqs
            .iter()
            .enumerate()
            .map(|(i, r)| json!({"jsonrpc": "2.0", "id": i, "method": r["method"], "params": r["params"]}))
            .collect();
        let text = serde_json::to_string(&body).map_err(|e| e.to_string())?;
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            self.stats.http_requests.fetch_add(1, Ordering::Relaxed);
            let res = self.agent.post(&self.url).set("content-type", "application/json").send_string(&text);
            let retry_after = match res {
                Ok(resp) => {
                    let mut buf = Vec::new();
                    match resp.into_reader().take(MAX_BODY_BYTES).read_to_end(&mut buf) {
                        Ok(_) => {
                            self.stats.response_bytes.fetch_add(buf.len() as u64, Ordering::Relaxed);
                            self.stats.items.fetch_add(reqs.len() as u64, Ordering::Relaxed);
                            let v: Value = serde_json::from_slice(&buf)
                                .map_err(|e| format!("{} returned a body that is not JSON ({e})", self.url))?;
                            if let Some(err) = v.as_object().and_then(|o| o.get("error")) {
                                let e = RpcError::from_value(err);
                                if e.is_rate_limit() {
                                    Some(None)
                                } else if reqs.len() > 1 {
                                    return Ok(Http::Refused(e.to_string()));
                                } else {
                                    return Ok(Http::Ok(Value::Array(vec![v])));
                                }
                            } else {
                                return Ok(Http::Ok(v));
                            }
                        }
                        Err(e) => {
                            if attempt >= MAX_ATTEMPTS {
                                return Err(format!("{}: reading the response failed: {e}", self.url));
                            }
                            Some(None)
                        }
                    }
                }
                Err(ureq::Error::Status(code, resp)) => {
                    let ra = resp.header("retry-after").and_then(|s| s.trim().parse::<u64>().ok());
                    let detail = resp.into_string().unwrap_or_default();
                    if code == 429 || code >= 500 {
                        if attempt >= MAX_ATTEMPTS {
                            return Err(format!("{}: HTTP {code} after {attempt} tries: {}", self.url, clip(&detail)));
                        }
                        Some(ra)
                    } else if reqs.len() > 1 {
                        return Ok(Http::Refused(format!("HTTP {code}: {}", clip(&detail))));
                    } else {
                        return Err(format!("{}: HTTP {code}: {}", self.url, clip(&detail)));
                    }
                }
                Err(ureq::Error::Transport(t)) => {
                    if attempt >= MAX_ATTEMPTS {
                        return Err(format!("{}: {t}", self.url));
                    }
                    Some(None)
                }
            };
            if let Some(ra) = retry_after {
                self.stats.retries.fetch_add(1, Ordering::Relaxed);
                std::thread::sleep(backoff(attempt, ra));
            }
        }
    }
}

fn backoff(attempt: u32, retry_after_secs: Option<u64>) -> Duration {
    if let Some(s) = retry_after_secs {
        return Duration::from_secs(s.min(30));
    }
    let base = (250u64 << attempt.min(5)).min(8_000);
    let jitter = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos() as u64 % (base / 2 + 1));
    Duration::from_millis(base + jitter)
}

fn clip(s: &str) -> String {
    s.chars().take(300).collect()
}

/// Pair a batch response with its requests by id.
fn match_responses(body: &Value, n: usize) -> Result<Vec<ItemResult>> {
    let arr = body.as_array().ok_or_else(|| format!("batch response is not an array: {}", clip(&body.to_string())))?;
    let mut out: Vec<Option<ItemResult>> = vec![None; n];
    for item in arr {
        let id = item.get("id").and_then(Value::as_u64);
        let r = if let Some(e) = item.get("error") {
            Err(RpcError::from_value(e))
        } else if let Some(v) = item.get("result") {
            Ok(v.clone())
        } else {
            return Err(format!("batch response item has neither result nor error: {}", clip(&item.to_string())));
        };
        match id {
            Some(i) if (i as usize) < n => out[i as usize] = Some(r),
            _ if n == 1 => out[0] = Some(r),
            _ => return Err(format!("batch response item has an unknown id: {}", clip(&item.to_string()))),
        }
    }
    out.into_iter()
        .enumerate()
        .map(|(i, r)| r.ok_or_else(|| format!("batch response is missing request {i} of {n}")))
        .collect()
}
