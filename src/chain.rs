//! Chains, canonical store addresses, and batched read-only views: many `eth_call`s packed into Multicall3
//! `aggregate3` calls, many of those (and `eth_getCode`s) packed into JSON-RPC batches.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde_json::{json, Value};

use crate::abi::{decode_aggregate3, encode_aggregate3, Address};
use crate::hex::{decode_const, from_hex, to_hex};
use crate::rpc::{ItemResult, Rpc};
use crate::Result;

pub const CHUNK_STORE: Address = decode_const::<20>("0x56317b1F45E4c15310135Ea72Fa4d768ca902BCc");
pub const FILE_STORE: Address = decode_const::<20>("0x8b6077a1d6953D96687005B9408D56A655b4d155");
pub const DIRECTORY_STORE: Address = decode_const::<20>("0x4273E4E078F47303Ca15b11959eeb61F3FC94c11");
pub const MULTICALL3: Address = decode_const::<20>("0xcA11bde05977b3631167028862bE2a173976CA11");

const PREFLIGHT_CODE: [(Address, &str); 4] =
    [(CHUNK_STORE, "ChunkStore"), (FILE_STORE, "FileStore"), (DIRECTORY_STORE, "DirectoryStore"), (MULTICALL3, "Multicall3")];

/// A chain with the canonical deployment, and the public endpoint the SDK lists first for it.
pub struct ChainInfo {
    pub name: &'static str,
    pub id: u64,
    pub rpc: &'static str,
}

pub const CHAINS: &[ChainInfo] = &[
    ChainInfo { name: "base", id: 8453, rpc: "https://mainnet.base.org" },
    ChainInfo { name: "base-sepolia", id: 84532, rpc: "https://sepolia.base.org" },
    ChainInfo { name: "ethereum", id: 1, rpc: "https://ethereum-rpc.publicnode.com" },
    ChainInfo { name: "sepolia", id: 11155111, rpc: "https://ethereum-sepolia-rpc.publicnode.com" },
    ChainInfo { name: "arbitrum-one", id: 42161, rpc: "https://arb1.arbitrum.io/rpc" },
    ChainInfo { name: "robinhood", id: 4663, rpc: "https://rpc.mainnet.chain.robinhood.com" },
    ChainInfo { name: "arbitrum-sepolia", id: 421614, rpc: "https://sepolia-rollup.arbitrum.io/rpc" },
];

pub fn chain_by_name(name: &str) -> Result<&'static ChainInfo> {
    CHAINS.iter().find(|c| c.name == name).ok_or_else(|| {
        let names: Vec<&str> = CHAINS.iter().map(|c| c.name).collect();
        format!("unknown chain \"{name}\"; one of: {}", names.join(", "))
    })
}

/// One read-only call, with what it is expected to cost and return (used only to size batches).
#[derive(Clone, Debug)]
pub struct View {
    pub to: Address,
    pub data: Vec<u8>,
    /// Upper estimate of the return data, bytes.
    pub ret: usize,
    /// Upper estimate of the gas the call uses.
    pub gas: u64,
}

/// A view's outcome: its return data, or its revert data.
#[derive(Clone, Debug)]
pub enum Out {
    Ok(Vec<u8>),
    Revert(Vec<u8>),
}

/// Most return data planned into one `aggregate3` call.
const GROUP_RET_BYTES: usize = 384 * 1024;
/// Most calls in one `aggregate3`.
const GROUP_MAX_CALLS: usize = 256;
/// Starting gas budget of one `aggregate3` (half the 50M most nodes simulate per `eth_call`).
const GROUP_GAS: u64 = 25_000_000;
/// Floor the gas budget is never halved below.
const GROUP_GAS_FLOOR: u64 = 1_000_000;
/// JSON-RPC items per HTTP request.
const ITEMS_PER_REQUEST: usize = 6;

pub struct Client {
    pub rpc: Rpc,
    pub chain: &'static ChainInfo,
    group_gas: AtomicU64,
    checked: AtomicBool,
    pub rounds: AtomicU64,
    pub eth_calls: AtomicU64,
    pub views: AtomicU64,
    pub codes: AtomicU64,
}

impl Client {
    /// A client for `chain`. Nothing is sent until the first round, which also checks that the endpoint is on
    /// `chain` and that the stores and Multicall3 have code there, before any of its results are used.
    pub fn connect(chain: &'static ChainInfo, url: Option<&str>, in_flight: usize) -> Result<Client> {
        Ok(Client {
            rpc: Rpc::new(url.unwrap_or(chain.rpc), in_flight)?,
            chain,
            group_gas: AtomicU64::new(GROUP_GAS),
            checked: AtomicBool::new(false),
            rounds: AtomicU64::new(0),
            eth_calls: AtomicU64::new(0),
            views: AtomicU64::new(0),
            codes: AtomicU64::new(0),
        })
    }

    fn preflight_items() -> Vec<Value> {
        let mut items = vec![json!({"method": "eth_chainId", "params": []})];
        for a in PREFLIGHT_CODE {
            items.push(json!({"method": "eth_getCode", "params": [to_hex(&a.0), "latest"]}));
        }
        items
    }

    fn check_preflight(&self, got: &[ItemResult]) -> Result<()> {
        let id = got[0].as_ref().map_err(|e| format!("eth_chainId: {e}"))?;
        let id = id.as_str().and_then(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16).ok());
        if id != Some(self.chain.id) {
            let shown = id.map_or("unknown".into(), |i| i.to_string());
            return Err(format!("{} is chain {shown}, not {} ({})", self.rpc.url(), self.chain.name, self.chain.id));
        }
        for (r, (_, name)) in got[1..].iter().zip(PREFLIGHT_CODE) {
            let code = r.as_ref().map_err(|e| format!("eth_getCode {name}: {e}"))?;
            if code.as_str().map_or(true, |s| s.len() <= 2) {
                return Err(format!("{name} has no code on {} at {}", self.chain.name, self.rpc.url()));
            }
        }
        self.checked.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Run `views` and fetch the code of `codes`, all at once. Each view's outcome and each account's code come
    /// back in order. A group the node refuses is split until it passes; a single view the node refuses is an error.
    pub fn round(&self, views: &[View], codes: &[Address]) -> Result<(Vec<Out>, Vec<Vec<u8>>)> {
        self.rounds.fetch_add(1, Ordering::Relaxed);
        self.views.fetch_add(views.len() as u64, Ordering::Relaxed);
        self.codes.fetch_add(codes.len() as u64, Ordering::Relaxed);
        let mut outs: Vec<Option<Out>> = vec![None; views.len()];
        let mut code_out: Vec<Vec<u8>> = Vec::with_capacity(codes.len());
        let mut groups = self.pack(&(0..views.len()).collect::<Vec<_>>(), views);
        let mut first = true;
        while !groups.is_empty() || first {
            let mut items: Vec<Value> = groups
                .iter()
                .map(|g| {
                    let calls: Vec<(Address, &[u8])> = g.iter().map(|&i| (views[i].to, views[i].data.as_slice())).collect();
                    json!({"method": "eth_call", "params": [{"to": to_hex(&MULTICALL3), "data": to_hex(&encode_aggregate3(&calls))}, "latest"]})
                })
                .collect();
            let preflight = !self.checked.load(Ordering::Relaxed);
            if first {
                for a in codes {
                    items.push(json!({"method": "eth_getCode", "params": [to_hex(a), "latest"]}));
                }
                if preflight {
                    items.extend(Self::preflight_items());
                }
            }
            self.eth_calls.fetch_add(groups.len() as u64, Ordering::Relaxed);
            let mut got = self.rpc.many(items, ITEMS_PER_REQUEST)?;
            if first && preflight {
                let tail = got.split_off(got.len() - 1 - PREFLIGHT_CODE.len());
                self.check_preflight(&tail)?;
            }
            let (call_res, code_res) = got.split_at(groups.len());
            if first {
                for (a, r) in codes.iter().zip(code_res) {
                    let v = r.as_ref().map_err(|e| format!("eth_getCode {}: {e}", to_hex(a)))?;
                    code_out.push(from_hex(v.as_str().ok_or("eth_getCode result is not a string")?)?);
                }
                first = false;
            }
            let mut next: Vec<Vec<usize>> = Vec::new();
            for (g, r) in groups.iter().zip(call_res) {
                match r {
                    Ok(v) => {
                        let ret = from_hex(v.as_str().ok_or("eth_call result is not a string")?)?;
                        let res = decode_aggregate3(&ret, g.len())?;
                        for (&i, (ok, data)) in g.iter().zip(res) {
                            if ok {
                                outs[i] = Some(Out::Ok(data));
                            } else if data.is_empty() && g.len() > 1 {
                                // An empty revert inside a group can be the group running out of gas: run it alone.
                                next.push(vec![i]);
                            } else {
                                outs[i] = Some(Out::Revert(data));
                            }
                        }
                    }
                    Err(e) => {
                        if g.len() == 1 {
                            let v = &views[g[0]];
                            return Err(format!("eth_call to {} via Multicall3 failed alone: {e}", to_hex(&v.to)));
                        }
                        if e.message.to_ascii_lowercase().contains("gas") {
                            let cur = self.group_gas.load(Ordering::Relaxed);
                            self.group_gas.store((cur / 2).max(GROUP_GAS_FLOOR), Ordering::Relaxed);
                        }
                        let mid = g.len() / 2;
                        next.push(g[..mid].to_vec());
                        next.push(g[mid..].to_vec());
                    }
                }
            }
            groups = next;
        }
        Ok((outs.into_iter().map(|o| o.expect("every view answered")).collect(), code_out))
    }

    /// Greedy groups of view indices within the return, gas and count budgets.
    fn pack(&self, idx: &[usize], views: &[View]) -> Vec<Vec<usize>> {
        let gas_cap = self.group_gas.load(Ordering::Relaxed);
        let mut groups = Vec::new();
        let mut cur: Vec<usize> = Vec::new();
        let (mut ret, mut gas) = (0usize, 0u64);
        for &i in idx {
            let v = &views[i];
            if !cur.is_empty() && (cur.len() >= GROUP_MAX_CALLS || ret + v.ret > GROUP_RET_BYTES || gas + v.gas > gas_cap) {
                groups.push(std::mem::take(&mut cur));
                ret = 0;
                gas = 0;
            }
            cur.push(i);
            ret += v.ret;
            gas += v.gas;
        }
        if !cur.is_empty() {
            groups.push(cur);
        }
        groups
    }
}
