//! A project's current root, as the chain's public endpoints agree on it. A project is named the way the ABX FS
//! gateway and the from-chain viewer name it: `<chain id>-<org contract>-<project number>`. Its current root is a
//! token parameter the project's owner can change, and no hash covers it, so it is read from every endpoint at one
//! block and taken only when at least two answer and all that answer agree. A reader's own endpoint, given with
//! `--rpc`, is believed alone.

use serde_json::{json, Value};

use crate::abi::Address;
use crate::chain::{ChainInfo, CHAINS};
use crate::hex::{from_hex, to_hex};
use crate::rpc::Rpc;
use crate::Result;

pub type H256 = [u8; 32];

/// `tokenParam(uint256,bytes32)`.
const TOKEN_PARAM: &str = "6bd39222";
/// The parameter names, as 32 bytes: "abxfs.cid" for ABX FS, "bamfs.cid" for the store before it.
const KEY_ABXFS: &str = "61627866732e636964";
const KEY_BAMFS: &str = "62616d66732e636964";
/// Blocks an endpoint may be from the middle of the others and still be asked (about two minutes).
fn max_lag(chain_id: u64) -> u64 {
    match chain_id {
        1 | 11155111 => 10,
        8453 | 84532 => 60,
        4663 => 1200,
        _ => 480,
    }
}

/// The public endpoints asked for a project's root, per chain (the from-chain viewer's list).
pub fn public_rpcs(chain_id: u64) -> &'static [&'static str] {
    match chain_id {
        8453 => &["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org"],
        42161 => &["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"],
        1 => &["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
        84532 => &["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com", "https://base-sepolia.drpc.org"],
        4663 => &["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com", "https://robinhood.drpc.org"],
        421614 => &["https://sepolia-rollup.arbitrum.io/rpc", "https://arbitrum-sepolia-rpc.publicnode.com", "https://arbitrum-sepolia.drpc.org"],
        11155111 => &["https://ethereum-sepolia-rpc.publicnode.com", "https://0xrpc.io/sep"],
        _ => &[],
    }
}

/// A project, by the name the gateway gives its host.
#[derive(Clone, Debug)]
pub struct Project {
    pub chain: &'static ChainInfo,
    pub org: Address,
    pub token: u64,
}

impl Project {
    pub fn label(&self) -> String {
        format!("{}-{}-{}", self.chain.id, to_hex(&self.org).trim_start_matches("0x"), self.token)
    }
}

/// `<chain id>-<org contract>-<project number>`, the contract with or without 0x, in any case. None for anything else.
pub fn parse_label(s: &str) -> Option<Project> {
    let mut parts = s.trim().split('-');
    let (id, org, token) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) || token.is_empty() || !token.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let org = org.strip_prefix("0x").unwrap_or(org);
    if org.len() != 40 || !org.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let chain = CHAINS.iter().find(|c| c.id.to_string() == id)?;
    let bytes = from_hex(org).ok()?;
    let mut a = [0u8; 20];
    a.copy_from_slice(&bytes);
    Some(Project { chain, org: a, token: token.parse().ok()? })
}

/// Which store the root belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Store {
    AbxFs,
    Bamfs,
}

/// A project's current root and how it was established.
#[derive(Clone, Debug)]
pub struct Current {
    /// All zeros when the project has published nothing.
    pub root: H256,
    pub store: Store,
    pub block: u64,
    /// The endpoints whose answers it rests on.
    pub sources: Vec<String>,
}

fn host(url: &str) -> String {
    url.split("://").nth(1).unwrap_or(url).split('/').next().unwrap_or(url).to_string()
}

fn quantity(v: &Value, what: &str) -> Result<u64> {
    let s = v.as_str().ok_or_else(|| format!("{what} is not a string"))?;
    u64::from_str_radix(s.strip_prefix("0x").ok_or_else(|| format!("{what} is not a quantity"))?, 16).map_err(|e| format!("{what}: {e}"))
}

/// The endpoints to ask, each on the project's chain and near the others' block, with the block to read at.
fn endpoints(project: &Project, own: Option<&str>) -> Result<(Vec<(Rpc, String)>, u64)> {
    let urls: Vec<String> = match own {
        Some(u) => vec![u.to_string()],
        None => public_rpcs(project.chain.id).iter().map(|s| s.to_string()).collect(),
    };
    let mut up = Vec::new();
    for url in urls {
        let rpc = match Rpc::new(&url, 2) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let id = rpc.call("eth_chainId", json!([])).ok().and_then(|r| r.ok()).and_then(|v| quantity(&v, "the chain id").ok());
        if id != Some(project.chain.id) {
            continue;
        }
        if let Some(block) = rpc.call("eth_blockNumber", json!([])).ok().and_then(|r| r.ok()).and_then(|v| quantity(&v, "the block number").ok()) {
            up.push((rpc, url, block));
        }
    }
    let need = if own.is_some() { 1 } else { 2 };
    let mut blocks: Vec<u64> = up.iter().map(|u| u.2).collect();
    blocks.sort_unstable();
    let middle = *blocks.get(blocks.len().saturating_sub(1) / 2).ok_or_else(|| format!("no endpoint for {} answered", project.chain.name))?;
    let near: Vec<(Rpc, String, u64)> = up.into_iter().filter(|u| u.2.abs_diff(middle) <= max_lag(project.chain.id)).collect();
    if near.len() < need {
        return Err(format!("fewer than two endpoints for {} are at the same height, and a project's current version needs two that agree", project.chain.name));
    }
    let block = near.iter().map(|u| u.2).min().expect("at least one");
    Ok((near.into_iter().map(|(r, u, _)| (r, u)).collect(), block))
}

/// One token parameter from every endpoint at `block`. A revert is an answer: the contract has no such
/// parameter, recorded as the zero root.
fn param(eps: &[(Rpc, String)], project: &Project, key: &str, block: u64, need: usize) -> Result<(H256, Vec<String>)> {
    let data = format!("0x{TOKEN_PARAM}{:064x}{key:0<64}", project.token);
    let mut got: Vec<(String, H256)> = Vec::new();
    for (rpc, url) in eps {
        let reply = match rpc.call("eth_call", json!([{"to": to_hex(&project.org), "data": data}, format!("0x{block:x}")])) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let root = match reply {
            Ok(v) => {
                let bytes = from_hex(v.as_str().unwrap_or("")).map_err(|e| format!("{}: {e}", host(url)))?;
                if bytes.len() < 32 {
                    return Err(format!("{} returned too little for tokenParam", host(url)));
                }
                let mut r = [0u8; 32];
                r.copy_from_slice(&bytes[..32]);
                r
            }
            Err(e) if e.message.to_ascii_lowercase().contains("revert") || e.data.is_some() => [0u8; 32],
            Err(_) => continue,
        };
        got.push((url.clone(), root));
    }
    if got.len() < need {
        return Err(format!("fewer than two endpoints answered at block {block}"));
    }
    if got.iter().any(|g| g.1 != got[0].1) {
        let who: Vec<String> = got.iter().map(|(u, r)| format!("{} {}", host(u), &to_hex(r)[..14])).collect();
        return Err(format!("the endpoints disagree about this project's current version at block {block}: {}", who.join(", ")));
    }
    Ok((got[0].1, got.into_iter().map(|(u, _)| host(&u)).collect()))
}

/// The endpoint a BAMFS read uses: the reader's own, or the last public one (the one the viewer's tests use).
pub fn bamfs_rpc(project: &Project, own: Option<&str>) -> Result<Rpc> {
    let url = own.or_else(|| public_rpcs(project.chain.id).last().copied()).ok_or_else(|| format!("no endpoint for {}", project.chain.name))?;
    Rpc::new(url, 4)
}

/// The project's current root: its ABX FS root, or its BAMFS root when it has none.
pub fn current_root(project: &Project, own: Option<&str>) -> Result<Current> {
    let (eps, block) = endpoints(project, own)?;
    let need = if own.is_some() { 1 } else { 2 };
    let (root, sources) = param(&eps, project, KEY_ABXFS, block, need)?;
    if root != [0u8; 32] {
        return Ok(Current { root, store: Store::AbxFs, block, sources });
    }
    if let Ok((older, src)) = param(&eps, project, KEY_BAMFS, block, need) {
        if older != [0u8; 32] {
            return Ok(Current { root: older, store: Store::Bamfs, block, sources: src });
        }
    }
    Ok(Current { root, store: Store::AbxFs, block, sources })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels() {
        let p = parse_label("8453-ab025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6-0").expect("a project");
        assert_eq!(p.chain.id, 8453);
        assert_eq!(p.token, 0);
        assert_eq!(p.label(), "8453-ab025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6-0");
        assert_eq!(parse_label("1-0xAB025E1F9F469AE55E5F193ECDDDAA1E0F4E2FF6-12").map(|p| p.token), Some(12));
        for bad in ["", "8453", "8453-ab02-0", "8453-ab025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6", "8453-ab025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6-x", "9-ab025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6-0", "8453-ab025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6-0-1", "8453-zz025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6-0"] {
            assert!(parse_label(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn call_data() {
        let p = parse_label("8453-ab025e1f9f469ae55e5f193ecdddaa1e0f4e2ff6-5").unwrap();
        let data = format!("0x{TOKEN_PARAM}{:064x}{KEY_ABXFS:0<64}", p.token);
        assert_eq!(data.len(), 2 + 8 + 64 + 64);
        assert_eq!(&data[10..74], &format!("{:064x}", 5));
        assert_eq!(&data[74..92], KEY_ABXFS);
    }
}
