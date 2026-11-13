//! Offline verification of an archive bundle, following archive/ARCHIVE.md and nothing else: the container, the
//! index, the binding proof up to the anchor block, and every byte of content. The result is the listing of
//! section 11, which other verifiers must reproduce byte for byte.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use serde_json::{Map, Value};

use crate::car;
use crate::ids::keccak256;
use crate::mpt::{self, Header, H256};

/// A rejection: its class (section 11) and a message.
#[derive(Debug)]
pub struct Reject {
    pub class: &'static str,
    pub message: String,
}

type R<T> = std::result::Result<T, Reject>;

fn fail<T>(class: &'static str, message: impl Into<String>) -> R<T> {
    Err(Reject { class, message: message.into() })
}

trait Class<T> {
    fn class(self, c: &'static str) -> R<T>;
}
impl<T> Class<T> for std::result::Result<T, String> {
    fn class(self, c: &'static str) -> R<T> {
        self.map_err(|message| Reject { class: c, message })
    }
}

const MAX_TOTAL: usize = 1 << 30;
const MAX_DEPTH: usize = 64;
const MAX_ENTRIES: usize = 65_536;
const MAX_READS: usize = 1_048_576;

fn h(x: &[u8]) -> String {
    crate::hex::to_hex(x)
}

/* ── JSON helpers (class index unless a value names a missing block) ── */

struct Ix<'a> {
    blocks: &'a BTreeMap<Vec<u8>, &'a [u8]>,
}

fn obj<'v>(v: &'v Value, keys: &[&str], optional: &[&str], what: &str) -> R<&'v Map<String, Value>> {
    let o = v.as_object().ok_or_else(|| Reject { class: "index", message: format!("{what} is not an object") })?;
    for k in o.keys() {
        if !keys.contains(&k.as_str()) && !optional.contains(&k.as_str()) {
            return fail("index", format!("{what} has an unknown key {k}"));
        }
    }
    for k in keys {
        if !o.contains_key(*k) {
            return fail("index", format!("{what} lacks {k}"));
        }
    }
    Ok(o)
}

fn hex_bytes(s: &str, what: &str) -> R<Vec<u8>> {
    let body = s.strip_prefix("0x").ok_or_else(|| Reject { class: "index", message: format!("{what} is not 0x hex") })?;
    if body.len() % 2 != 0 || !body.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
        return fail("index", format!("{what} is not lowercase hex of whole bytes"));
    }
    Ok((0..body.len()).step_by(2).map(|i| u8::from_str_radix(&body[i..i + 2], 16).unwrap()).collect())
}

fn fixed<const N: usize>(v: &Value, what: &str) -> R<[u8; N]> {
    let s = v.as_str().ok_or_else(|| Reject { class: "index", message: format!("{what} is not a string") })?;
    hex_bytes(s, what)?.try_into().map_err(|_| Reject { class: "index", message: format!("{what} is not {N} bytes") })
}

fn uint(v: &Value, what: &str) -> R<u64> {
    v.as_u64().filter(|&n| n < (1 << 53)).ok_or_else(|| Reject { class: "index", message: format!("{what} is not an integer below 2^53") })
}

impl Ix<'_> {
    /// A byte string: hex, or an array of links whose blocks concatenate to it.
    fn bytes(&self, v: &Value, what: &str) -> R<Vec<u8>> {
        match v {
            Value::String(s) => hex_bytes(s, what),
            Value::Array(a) => {
                let mut out = Vec::new();
                for l in a {
                    let cid = link(l).ok_or_else(|| Reject { class: "index", message: format!("{what} holds something that is not a link") })?;
                    let b = self.blocks.get(&cid).ok_or_else(|| Reject { class: "container", message: format!("{what} links a block the bundle lacks") })?;
                    // One block may be linked many times: stop before the value outgrows what any bundle may hold.
                    if out.len() + b.len() > MAX_TOTAL {
                        return fail("content", format!("{what} is more than 1 GiB"));
                    }
                    out.extend_from_slice(b);
                }
                Ok(out)
            }
            _ => fail("index", format!("{what} is not a byte string")),
        }
    }
}

fn link(v: &Value) -> Option<Vec<u8>> {
    let o = v.as_object()?;
    if o.len() != 1 {
        return None;
    }
    car::cid_from_text(o.get("/")?.as_str()?)
}

/// The index as JSON, refusing what section 2 refuses: a key twice in one object, and a number with a fraction or
/// an exponent (or too large for an integer).
fn parse_index(b: &[u8]) -> std::result::Result<Value, String> {
    use serde::de::{DeserializeSeed, Deserializer, Error, MapAccess, SeqAccess, Visitor};
    struct Strict;
    impl<'de> DeserializeSeed<'de> for Strict {
        type Value = Value;
        fn deserialize<D: Deserializer<'de>>(self, d: D) -> std::result::Result<Value, D::Error> {
            d.deserialize_any(Strict)
        }
    }
    impl<'de> Visitor<'de> for Strict {
        type Value = Value;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("JSON")
        }
        fn visit_bool<E>(self, v: bool) -> std::result::Result<Value, E> {
            Ok(Value::Bool(v))
        }
        fn visit_u64<E>(self, v: u64) -> std::result::Result<Value, E> {
            Ok(Value::from(v))
        }
        fn visit_i64<E>(self, v: i64) -> std::result::Result<Value, E> {
            Ok(Value::from(v))
        }
        fn visit_f64<E: Error>(self, _: f64) -> std::result::Result<Value, E> {
            Err(E::custom("a number has a fraction or an exponent, or is too large"))
        }
        fn visit_str<E>(self, v: &str) -> std::result::Result<Value, E> {
            Ok(Value::String(v.to_string()))
        }
        fn visit_unit<E>(self) -> std::result::Result<Value, E> {
            Ok(Value::Null)
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> std::result::Result<Value, A::Error> {
            let mut out = Vec::new();
            while let Some(v) = a.next_element_seed(Strict)? {
                out.push(v);
            }
            Ok(Value::Array(out))
        }
        fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> std::result::Result<Value, A::Error> {
            let mut out = Map::new();
            while let Some(k) = a.next_key::<String>()? {
                if out.contains_key(&k) {
                    return Err(A::Error::custom(format!("the key {k:?} appears twice in one object")));
                }
                let v = a.next_value_seed(Strict)?;
                out.insert(k, v);
            }
            Ok(Value::Object(out))
        }
    }
    let mut de = serde_json::Deserializer::from_slice(b);
    let v = Strict.deserialize(&mut de).map_err(|e| e.to_string())?;
    de.end().map_err(|e| e.to_string())?;
    Ok(v)
}

/// An object's values in ascending order of their keys' bytes, whatever order the map keeps them in.
fn sorted_values(o: &Map<String, Value>) -> Vec<&Value> {
    let mut kv: Vec<(&String, &Value)> = o.iter().collect();
    kv.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    kv.into_iter().map(|x| x.1).collect()
}

/// Every link anywhere in the index (section 1: each must name a block, and each block must be named).
fn links(v: &Value, out: &mut Vec<Vec<u8>>) -> R<()> {
    match v {
        Value::Object(o) if o.contains_key("/") => match link(v) {
            Some(c) => out.push(c),
            None => return fail("container", "a link is not a CID in text form"),
        },
        Value::Object(o) => sorted_values(o).into_iter().try_for_each(|x| links(x, out))?,
        Value::Array(a) => a.iter().try_for_each(|x| links(x, out))?,
        _ => {}
    }
    Ok(())
}

/* ── 256-bit words ── */

fn word_u64(n: u64) -> H256 {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&n.to_be_bytes());
    w
}

fn word_addr(a: &[u8; 20]) -> H256 {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

fn add_one(mut w: H256) -> H256 {
    for b in w.iter_mut().rev() {
        let (v, carry) = b.overflowing_add(1);
        *b = v;
        if !carry {
            break;
        }
    }
    w
}

/// A decimal token number as a 256-bit word.
fn decimal_word(s: &str) -> Option<H256> {
    if s.is_empty() || s.len() > 78 || (s.len() > 1 && s.starts_with('0')) || !s.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let mut w = [0u8; 32];
    for c in s.bytes() {
        let mut carry = (c - b'0') as u32;
        for b in w.iter_mut().rev() {
            let v = *b as u32 * 10 + carry;
            *b = v as u8;
            carry = v >> 8;
        }
        if carry != 0 {
            return None;
        }
    }
    Some(w)
}

fn bits(w: &H256, from: u32, n: u32) -> u128 {
    // `n` ≤ 64 bits starting at bit `from` (bit 0 the least significant).
    let v = num_bigint_free_shift(w, from);
    if n >= 128 { v } else { v & ((1u128 << n) - 1) }
}

fn num_bigint_free_shift(w: &H256, from: u32) -> u128 {
    let mut out: u128 = 0;
    for i in 0..128u32 {
        let bit = from + i;
        if bit >= 256 {
            break;
        }
        let byte = w[31 - (bit / 8) as usize];
        if byte >> (bit % 8) & 1 == 1 {
            out |= 1u128 << i;
        }
    }
    out
}

fn addr_of(w: &H256) -> [u8; 20] {
    w[12..].try_into().unwrap()
}

/* ── account evidence ── */

struct Accounts {
    /// address → (code hash, slot → word); None when the account does not exist.
    map: HashMap<[u8; 20], Option<(H256, HashMap<H256, H256>)>>,
}

impl Accounts {
    fn read(v: &Value, state_root: &H256, what: &str) -> R<Accounts> {
        let list = v.as_array().ok_or_else(|| Reject { class: "index", message: format!("{what} is not a list") })?;
        let mut map = HashMap::new();
        for a in list {
            let o = obj(a, &["address", "proof", "storage"], &[], "account evidence")?;
            let address: [u8; 20] = fixed(&o["address"], "an address")?;
            let proof = nodes(&o["proof"])?;
            let acct = mpt::account(state_root, &address, &proof).class("proof")?;
            let storage = o["storage"].as_array().ok_or_else(|| Reject { class: "index", message: "storage is not a list".into() })?;
            let entry = match acct {
                None => {
                    if !storage.is_empty() {
                        return fail("proof", format!("storage of {} is given, but the account does not exist", h(&address)));
                    }
                    None
                }
                Some((sroot, code)) => {
                    let mut words = HashMap::new();
                    for s in storage {
                        let so = obj(s, &["slot", "proof"], &[], "storage evidence")?;
                        let slot: H256 = fixed(&so["slot"], "a slot")?;
                        let w = mpt::storage(&sroot, &slot, &nodes(&so["proof"])?).class("proof")?;
                        if words.insert(slot, w).is_some() {
                            return fail("proof", format!("slot {} of {} is given twice", h(&slot), h(&address)));
                        }
                    }
                    Some((code, words))
                }
            };
            if map.insert(address, entry).is_some() {
                return fail("proof", format!("{} appears twice in one list", h(&address)));
            }
        }
        Ok(Accounts { map })
    }

    fn exists(&self, a: &[u8; 20]) -> R<bool> {
        match self.map.get(a) {
            Some(e) => Ok(e.is_some()),
            None => fail("proof", format!("no evidence for {}", h(a))),
        }
    }

    fn code_hash(&self, a: &[u8; 20]) -> R<H256> {
        match self.map.get(a) {
            Some(Some((c, _))) => Ok(*c),
            Some(None) => fail("binding", format!("{} does not exist", h(a))),
            None => fail("proof", format!("no evidence for {}", h(a))),
        }
    }

    fn word(&self, a: &[u8; 20], slot: &H256) -> R<H256> {
        match self.map.get(a) {
            Some(Some((_, w))) => w.get(slot).copied().ok_or_else(|| Reject { class: "proof", message: format!("no evidence for slot {} of {}", h(slot), h(a)) }),
            Some(None) => fail("binding", format!("{} does not exist", h(a))),
            None => fail("proof", format!("no evidence for {}", h(a))),
        }
    }
}

fn nodes(v: &Value) -> R<Vec<Vec<u8>>> {
    let a = v.as_array().ok_or_else(|| Reject { class: "index", message: "a proof is not a list".into() })?;
    a.iter().map(|n| hex_bytes(n.as_str().ok_or_else(|| Reject { class: "index", message: "a proof node is not a string".into() })?, "a proof node")).collect()
}

fn header_of(v: &Value) -> R<Header> {
    let s = v.as_str().ok_or_else(|| Reject { class: "index", message: "a header is not a string".into() })?;
    mpt::header(&hex_bytes(s, "a header")?).class("proof")
}

/* ── the token parameter (section 4) ── */

const IMPLEMENTATION: [u8; 20] = hex20("785cd3f74e86e4495c178b5ffcd047c57e699270");

const fn hex20(s: &str) -> [u8; 20] {
    let b = s.as_bytes();
    let mut out = [0u8; 20];
    let mut i = 0;
    while i < 20 {
        out[i] = (nib(b[2 * i]) << 4) | nib(b[2 * i + 1]);
        i += 1;
    }
    out
}
const fn nib(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        _ => c - b'a' + 10,
    }
}

fn collection_code_hash() -> H256 {
    let code = [&crate::hex::from_hex("3d3d3d3d363d3d37363d73").unwrap()[..], &IMPLEMENTATION, &crate::hex::from_hex("5af43d3d93803e602a57fd5bf3").unwrap()].concat();
    keccak256(&code)
}

/// (value slot, flags slot) of a token parameter.
pub fn param_slots(token: &H256, key: &str) -> (H256, H256) {
    let ns = keccak256(b"abx.storage.params");
    let mut m = ns;
    // ns - 1
    for b in m.iter_mut().rev() {
        let (v, borrow) = b.overflowing_sub(1);
        *b = v;
        if !borrow {
            break;
        }
    }
    let mut base = keccak256(&m);
    base[31] = 0;
    let mut k = [0u8; 32];
    k[..key.len()].copy_from_slice(key.as_bytes());
    let value = keccak256(&[&k[..], &keccak256(&[&token[..], &base[..]].concat())].concat());
    (value, add_one(value))
}

fn param_rule(acc: &Accounts, org: &[u8; 20], token: &H256, key: &str, root: &H256) -> R<()> {
    // An account the proofs show absent fails the rule (param); an account with no evidence at all is a proof gap.
    let code = acc.code_hash(org).map_err(|e| Reject { class: if e.class == "binding" { "param" } else { e.class }, message: e.message })?;
    if code != collection_code_hash() {
        return fail("param", "the project's contract is not an ABX collection");
    }
    let (vs, fs) = param_slots(token, key);
    let flags = acc.word(org, &fs)?;
    if flags != word_u64(0x0100) {
        return fail("param", format!("the parameter's flags are {}, not set-and-not-a-hash (0x0100)", h(&flags)));
    }
    let v = acc.word(org, &vs)?;
    if v != *root {
        return fail("param", format!("the parameter holds {}, not the bundle's root", h(&v)));
    }
    Ok(())
}

/* ── binding proofs (section 6) ── */

const IMPL_SLOT: &str = "360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const PORTAL: [u8; 20] = hex20("49048044d57e1c92a77f79988d21fa8faf74e97e");
const PORTAL_IMPL: [u8; 20] = hex20("03863ab7f64b733cff85c8ff44a86601c568ca70");
const REGISTRY: [u8; 20] = hex20("909f6cf47ed12f010a796527f562bfc26c7f4e72");
const REGISTRY_IMPL: [u8; 20] = hex20("4483f964f6711cb55f633820ed174e780369b99d");
const FACTORY: [u8; 20] = hex20("43edb88c4b80fdd2adff2412a7bebf9df42cb40e");
const FACTORY_IMPL: [u8; 20] = hex20("94eab8f73fd83407d26c006d159923760d483029");
const GAME_IMPL: [u8; 20] = hex20("c08b8ffaf04abb1d7013b74a0e57eccbd7fa5a70");
const GAME_TYPE: u64 = 621;
const PASSER: [u8; 20] = hex20("4200000000000000000000000000000000000016");
const ROLLUP: [u8; 20] = hex20("4dceb440657f21083db8add07665f8ddbe1dcfc0");
const ARB_PRIMARY: [u8; 20] = hex20("7fc126ff51183a78c5e0437467f325f661d8df17");
const ARB_SECONDARY: [u8; 20] = hex20("6490ba0a60cc7d3a59c9eee135d9eed24553a60d");
const ARB_SECONDARY_SLOT: &str = "2b1dbce74324248c222f0ec2d5ed7bd323cfc425b336f0253c5ccfda7265546d";

fn slot_hex(s: &str) -> H256 {
    crate::hex::from_hex(s).unwrap().try_into().unwrap()
}

fn kslot(a: &H256, b: u64) -> H256 {
    keccak256(&[&a[..], &word_u64(b)].concat())
}

/// What a binding proof establishes, for the listing.
pub struct Binding {
    pub anchor: Option<(u64, H256)>,
    pub l2: Option<(u64, H256, &'static str)>,
    pub agreed: Option<(u64, Vec<String>)>,
    pub logged: Option<(u64, H256)>,
}

struct Project {
    chain: u64,
    org: [u8; 20],
    token: H256,
    token_text: String,
    key: String,
}

fn binding(ix: &Ix, p: &Project, root: &H256, v: &Value) -> R<Binding> {
    let kind = v.get("kind").and_then(Value::as_str).unwrap_or("");
    let fits = matches!((kind, p.chain), ("ethereum", 1) | ("base", 8453) | ("arbitrum", 42161) | ("agreed" | "logged", 1 | 8453 | 42161));
    if !fits {
        return fail("index", format!("a proof of kind {kind:?} does not fit chain {}", p.chain));
    }
    let _ = ix;
    match kind {
        "ethereum" => {
            let o = obj(v, &["kind", "header", "accounts"], &[], "the proof")?;
            let hd = header_of(&o["header"])?;
            let acc = Accounts::read(&o["accounts"], &hd.state_root, "accounts")?;
            param_rule(&acc, &p.org, &p.token, &p.key, root)?;
            Ok(Binding { anchor: Some((hd.number, hd.hash)), l2: None, agreed: None, logged: None })
        }
        "base" => base(p, root, v),
        "arbitrum" => arbitrum(p, root, v),
        "agreed" => {
            let o = obj(v, &["kind", "block", "endpoints"], &[], "the proof")?;
            let block = uint(&o["block"], "the block")?;
            let eps = o["endpoints"].as_array().ok_or_else(|| Reject { class: "index", message: "endpoints is not a list".into() })?;
            let eps: Vec<String> = eps.iter().map(|e| e.as_str().map(str::to_string).ok_or_else(|| Reject { class: "index", message: "an endpoint is not a string".into() })).collect::<R<_>>()?;
            let distinct: HashSet<&String> = eps.iter().collect();
            if eps.len() < 2 || distinct.len() != eps.len() || eps.iter().any(|e| e.is_empty() || e.contains([',', ' ', '\n'])) {
                return fail("index", "an agreed proof names fewer than two different endpoints, or one that cannot be listed");
            }
            Ok(Binding { anchor: None, l2: None, agreed: Some((block, eps)), logged: None })
        }
        "logged" => {
            let o = obj(v, &["kind", "block", "tx"], &[], "the proof")?;
            Ok(Binding { anchor: None, l2: None, agreed: None, logged: Some((uint(&o["block"], "the block")?, fixed(&o["tx"], "the transaction")?)) })
        }
        _ => unreachable!(),
    }
}

fn base(p: &Project, root: &H256, v: &Value) -> R<Binding> {
    let o = obj(v, &["kind", "final", "l1", "game", "l2"], &[], "the proof")?;
    let is_final = o["final"].as_bool().ok_or_else(|| Reject { class: "index", message: "final is not true or false".into() })?;
    let l1 = obj(&o["l1"], &["header", "accounts", "codes"], &[], "l1")?;
    let l2 = obj(&o["l2"], &["header", "accounts"], &[], "l2")?;
    let game: [u8; 20] = fixed(&o["game"], "the game")?;
    let hd = header_of(&l1["header"])?;
    let acc = Accounts::read(&l1["accounts"], &hd.state_root, "l1 accounts")?;
    let impl_slot = slot_hex(IMPL_SLOT);
    let names = |a: &[u8; 20], slot: &H256, want: &[u8; 20], what: &str| -> R<()> {
        if addr_of(&acc.word(a, slot)?) != *want {
            return fail("binding", format!("{what} is not the one format 1 was written for"));
        }
        Ok(())
    };
    names(&PORTAL, &impl_slot, &PORTAL_IMPL, "the portal's implementation")?;
    names(&PORTAL, &word_u64(62), &REGISTRY, "the registry the portal names")?;
    names(&REGISTRY, &impl_slot, &REGISTRY_IMPL, "the registry's implementation")?;
    names(&REGISTRY, &word_u64(1), &FACTORY, "the factory the registry names")?;
    let r6 = acc.word(&REGISTRY, &word_u64(6))?;
    if bits(&r6, 0, 32) != GAME_TYPE as u128 {
        return fail("binding", "the registry respects another game type");
    }
    let retirement = bits(&r6, 32, 64);
    names(&FACTORY, &impl_slot, &FACTORY_IMPL, "the factory's implementation")?;
    names(&FACTORY, &kslot(&word_u64(GAME_TYPE), 101), &GAME_IMPL, "the game implementation")?;
    // The game.
    let codes = l1["codes"].as_array().ok_or_else(|| Reject { class: "index", message: "codes is not a list".into() })?;
    let codes: Vec<Vec<u8>> = codes.iter().map(|c| hex_bytes(c.as_str().unwrap_or(""), "a code")).collect::<R<_>>()?;
    if !acc.exists(&game)? {
        return fail("binding", "the game does not exist");
    }
    let ch = acc.code_hash(&game)?;
    let code = codes.iter().find(|c| keccak256(c) == ch).ok_or_else(|| Reject { class: "proof", message: "no code given hashes to the game's code hash".into() })?;
    let head = [
        &crate::hex::from_hex("36602c57343d527f9e4ac34f21c619cefc926c8bd93b54bf5a39c7ab2127a895af1cc0691d7e3dff593da1005b363d3d373d3d3d3d61030a806062363936013d73").unwrap()[..],
        &GAME_IMPL,
        &crate::hex::from_hex("5af43d3d93803e606057fd5bf3").unwrap(),
    ]
    .concat();
    if !code.starts_with(&head) || code.len() < head.len() + 136 + 2 {
        return fail("binding", "the game is not a clone of the game implementation");
    }
    let args = &code[head.len()..code.len() - 2];
    let root_claim: H256 = args[20..52].try_into().unwrap();
    let extra = &args[84..];
    let l2_block = &extra[..32];
    if l2_block[..25].iter().any(|&b| b != 0) || bits(&l2_block.try_into().unwrap(), 0, 64) >= (1 << 53) {
        return fail("binding", "the game names an L2 block too large to be one");
    }
    let l2_block = bits(&l2_block.try_into().unwrap(), 0, 64) as u64;
    let mut padded = extra.to_vec();
    padded.resize(extra.len().div_ceil(32) * 32, 0);
    let uuid = keccak256(&[&word_u64(GAME_TYPE)[..], &root_claim, &word_u64(96), &word_u64(extra.len() as u64), &padded].concat());
    let rec = acc.word(&FACTORY, &kslot(&uuid, 103))?;
    if addr_of(&rec) != game || bits(&rec, 224, 32) != GAME_TYPE as u128 {
        return fail("binding", "the factory has no record of the game under what it claims");
    }
    if acc.word(&REGISTRY, &kslot(&word_addr(&game), 5))? != [0u8; 32] {
        return fail("binding", "the game is blacklisted");
    }
    let s0 = acc.word(&game, &word_u64(0))?;
    let s7 = acc.word(&game, &word_u64(7))?;
    let created = bits(&s0, 0, 64);
    let status = bits(&s0, 128, 8);
    if bits(&s0, 144, 8) == 0 {
        return fail("binding", "the game was not of the respected type when it was created");
    }
    if created <= retirement {
        return fail("binding", "the game is retired");
    }
    if is_final {
        if addr_of(&acc.word(&REGISTRY, &word_u64(2))?) != game || status != 2 {
            return fail("binding", "the game is not the registry's anchor resolved for its claim");
        }
    } else if !(status == 0 || status == 2) || bits(&s7, 64, 8) < 1 {
        return fail("binding", "the game has no accepted proof, or its claim lost a challenge");
    }
    // The L2 block.
    let h2 = header_of(&l2["header"])?;
    if h2.number != l2_block {
        return fail("binding", "the L2 header is not the block the game names");
    }
    let acc2 = Accounts::read(&l2["accounts"], &h2.state_root, "l2 accounts")?;
    let passer_root = match acc2.map.get(&PASSER) {
        Some(Some(_)) => {
            // The storage root is not kept in Accounts; read it again from the proof.
            passer_storage_root(&l2["accounts"], &h2.state_root)?
        }
        Some(None) => return fail("binding", "the message passer does not exist in that state"),
        None => return fail("proof", "no evidence for the message passer"),
    };
    let output = keccak256(&[&word_u64(0)[..], &h2.state_root, &passer_root, &h2.hash].concat());
    if output != root_claim {
        return fail("binding", "the L2 block does not make the game's output root");
    }
    param_rule(&acc2, &p.org, &p.token, &p.key, root)?;
    Ok(Binding { anchor: Some((hd.number, hd.hash)), l2: Some((h2.number, h2.hash, if is_final { "final" } else { "claimed" })), agreed: None, logged: None })
}

fn passer_storage_root(list: &Value, state_root: &H256) -> R<H256> {
    for a in list.as_array().into_iter().flatten() {
        if fixed::<20>(&a["address"], "an address")? == PASSER {
            let (sr, _) = mpt::account(state_root, &PASSER, &nodes(&a["proof"])?).class("proof")?.ok_or_else(|| Reject { class: "binding", message: "the message passer does not exist".into() })?;
            return Ok(sr);
        }
    }
    fail("proof", "no evidence for the message passer")
}

fn arbitrum(p: &Project, root: &H256, v: &Value) -> R<Binding> {
    let o = obj(v, &["kind", "l1", "log", "l2"], &[], "the proof")?;
    let l1 = obj(&o["l1"], &["header", "accounts"], &[], "l1")?;
    let lg = obj(&o["log"], &["parent", "data"], &[], "log")?;
    let l2 = obj(&o["l2"], &["header", "accounts"], &[], "l2")?;
    let hd = header_of(&l1["header"])?;
    let acc = Accounts::read(&l1["accounts"], &hd.state_root, "l1 accounts")?;
    if addr_of(&acc.word(&ROLLUP, &slot_hex(IMPL_SLOT))?) != ARB_PRIMARY || addr_of(&acc.word(&ROLLUP, &slot_hex(ARB_SECONDARY_SLOT))?) != ARB_SECONDARY {
        return fail("binding", "the rollup contract's implementations are not the ones format 1 was written for");
    }
    let assertion = acc.word(&ROLLUP, &word_u64(116))?;
    if assertion == [0u8; 32] {
        return fail("binding", "the rollup has no confirmed assertion");
    }
    let node = acc.word(&ROLLUP, &kslot(&assertion, 117))?;
    if bits(&node, 200, 8) != 2 {
        return fail("binding", "the assertion is not marked confirmed");
    }
    let created = bits(&node, 128, 64);
    if created < 1 || created > hd.number as u128 {
        return fail("binding", "the assertion names an Ethereum block that cannot be right");
    }
    let parent: H256 = fixed(&lg["parent"], "the log's parent")?;
    let data = hex_bytes(lg["data"].as_str().unwrap_or(""), "the log's data")?;
    if data.len() % 32 != 0 || !(20..=40).contains(&(data.len() / 32)) {
        return fail("binding", "the log's data is not 20 to 40 words");
    }
    let after = &data[13 * 32..19 * 32];
    let acc_word = &data[19 * 32..20 * 32];
    if keccak256(&[&parent[..], &keccak256(after), acc_word].concat()) != assertion {
        return fail("binding", "the log does not hash to the confirmed assertion");
    }
    let block_hash: H256 = after[..32].try_into().unwrap();
    let h2 = header_of(&l2["header"])?;
    if h2.hash != block_hash {
        return fail("binding", "the L2 header is not the block the assertion names");
    }
    let acc2 = Accounts::read(&l2["accounts"], &h2.state_root, "l2 accounts")?;
    param_rule(&acc2, &p.org, &p.token, &p.key, root)?;
    Ok(Binding { anchor: Some((hd.number, hd.hash)), l2: Some((h2.number, h2.hash, "confirmed")), agreed: None, logged: None })
}

/* ── content (sections 7 to 10) ── */

/// One listed item: path segments (bytes), and the file's bytes or None for a directory.
type Item = (Vec<Vec<u8>>, Option<Vec<u8>>);

struct Content<'a> {
    ix: &'a Ix<'a>,
    store: String,
    dirs: HashMap<H256, &'a Value>,
    files: HashMap<H256, &'a Value>,
    nodes: HashMap<H256, Vec<u8>>,
    chunks: HashMap<H256, &'a Value>,
    used_dirs: HashSet<H256>,
    used_files: HashSet<H256>,
    used_nodes: HashSet<H256>,
    used_chunks: HashSet<H256>,
    on_path: HashSet<H256>,
    total: usize,
    entries: usize,
    reads: usize,
    items: Vec<Item>,
}

fn keyed<'a>(v: &'a Value, what: &str) -> R<HashMap<H256, &'a Value>> {
    let mut m = HashMap::new();
    for d in v.as_array().ok_or_else(|| Reject { class: "index", message: format!("{what} is not a list") })? {
        let cid: H256 = fixed(d.get("cid").unwrap_or(&Value::Null), "a cid")?;
        if m.insert(cid, d).is_some() {
            return fail("content", format!("{} appears twice in {what}", h(&cid)));
        }
    }
    Ok(m)
}

fn id_map<'a>(v: &'a Value, what: &str) -> R<HashMap<H256, &'a Value>> {
    let o = v.as_object().ok_or_else(|| Reject { class: "index", message: format!("{what} is not an object") })?;
    let mut m = HashMap::new();
    for (k, x) in o {
        let id: H256 = fixed(&Value::String(k.clone()), "an id")?;
        m.insert(id, x);
    }
    Ok(m)
}

fn utf8_name(b: &[u8], what: &str) -> R<Vec<u8>> {
    let b = b.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(b);
    if std::str::from_utf8(b).is_err() {
        return fail("content", format!("{what} is not UTF-8"));
    }
    Ok(b.to_vec())
}

impl<'a> Content<'a> {
    fn bytes(&self, v: &Value, what: &str) -> R<Vec<u8>> {
        self.ix.bytes(v, what)
    }

    fn add_total(&mut self, n: usize) -> R<()> {
        self.total += n;
        if self.total > MAX_TOTAL {
            return fail("content", "the content is more than 1 GiB");
        }
        Ok(())
    }

    fn node(&mut self, id: &H256, prefix: u8, level: Option<u8>) -> R<Vec<u8>> {
        self.reads += 1;
        if self.reads > MAX_READS {
            return fail("content", "the content needs more than 1,048,576 node reads");
        }
        let blob = self.nodes.get(id).cloned().ok_or_else(|| Reject { class: "content", message: format!("node {} is not in the bundle", h(id)) })?;
        if keccak256(&[&[prefix][..], &blob].concat()) != *id {
            return fail("content", format!("node {}: its blob does not hash to its id", h(id)));
        }
        let l = *blob.first().ok_or_else(|| Reject { class: "content", message: format!("node {} is empty", h(id)) })?;
        if l > 3 || level.is_some_and(|want| want != l) {
            return fail("content", format!("node {} is at level {l}, which its place does not allow", h(id)));
        }
        self.used_nodes.insert(*id);
        Ok(blob)
    }

    /// The leaves under a node, in order. `stride` is a branch child's length.
    fn leaves(&mut self, id: &H256, prefix: u8, stride: usize, level: Option<u8>, out: &mut Vec<Vec<u8>>) -> R<()> {
        let blob = self.node(id, prefix, level)?;
        if blob[0] == 0 {
            out.push(blob);
            return Ok(());
        }
        if blob.len() < 3 {
            return fail("content", format!("branch {} is too short", h(id)));
        }
        let n = u16::from_be_bytes([blob[1], blob[2]]) as usize;
        if !(2..=128).contains(&n) || blob.len() != 3 + stride * n {
            return fail("content", format!("branch {} does not hold the children it counts", h(id)));
        }
        for i in 0..n {
            let c: H256 = blob[3 + stride * i..35 + stride * i].try_into().unwrap();
            self.leaves(&c, prefix, stride, Some(blob[0] - 1), out)?;
        }
        Ok(())
    }

    /// An entry leaf's records: (name bytes, isDir, cid).
    fn entry_leaf(blob: &[u8]) -> R<Vec<(Vec<u8>, bool, H256)>> {
        if blob.len() < 3 {
            return fail("content", "an entry leaf is too short");
        }
        let n = u16::from_be_bytes([blob[1], blob[2]]) as usize;
        let area = 3 + 2 * n;
        if n < 1 || area > blob.len() {
            return fail("content", "an entry leaf does not hold the entries it counts");
        }
        let mut out = Vec::new();
        let mut at = area;
        for i in 0..n {
            let off = u16::from_be_bytes([blob[3 + 2 * i], blob[4 + 2 * i]]) as usize;
            if area + off != at || at >= blob.len() {
                return fail("content", "an entry leaf's offsets do not match its records");
            }
            let len = blob[at] as usize;
            if len < 1 || at + 1 + len + 33 > blob.len() {
                return fail("content", "an entry leaf ends inside a record");
            }
            let flag = blob[at + 1 + len];
            if flag > 1 {
                return fail("content", "an entry is neither a file nor a directory");
            }
            out.push((blob[at + 1..at + 1 + len].to_vec(), flag == 1, blob[at + 2 + len..at + 34 + len].try_into().unwrap()));
            at += 34 + len;
        }
        if at != blob.len() {
            return fail("content", "an entry leaf has bytes after its records");
        }
        Ok(out)
    }

    fn walk_dir(&mut self, cid: &H256, path: &[Vec<u8>], depth: usize) -> R<()> {
        if depth > MAX_DEPTH {
            return fail("content", "directories nest more than 64 deep");
        }
        if !self.on_path.insert(*cid) {
            return fail("content", format!("directory {} is inside itself", h(cid)));
        }
        let d = *self.dirs.get(cid).ok_or_else(|| Reject { class: "content", message: format!("directory {} is not in the bundle", h(cid)) })?;
        self.used_dirs.insert(*cid);
        let entries: Vec<(Vec<u8>, bool, H256)> = match self.store.as_str() {
            "abxfs" | "bamfs2" => {
                let o = obj(d, &["cid", "root"], &[], "a directory")?;
                let root: H256 = fixed(&o["root"], "a directory's root")?;
                let (dp, np) = if self.store == "abxfs" { (0x32u8, 0x42u8) } else { (0x12, 0x22) };
                if keccak256(&[&[dp][..], &root].concat()) != *cid {
                    return fail("content", format!("directory {}: its root node does not hash to its CID", h(cid)));
                }
                let mut leaves = Vec::new();
                if !(self.store == "abxfs" && root == [0u8; 32]) {
                    self.leaves(&root, np, 36, None, &mut leaves)?;
                }
                let mut out = Vec::new();
                for l in leaves {
                    out.extend(Self::entry_leaf(&l)?);
                }
                out
            }
            _ => {
                let o = obj(d, &["cid", "entries"], &[], "a directory")?;
                let list = o["entries"].as_array().ok_or_else(|| Reject { class: "index", message: "entries is not a list".into() })?;
                let mut out = Vec::new();
                let mut hashes = Vec::new();
                for e in list {
                    let eo = obj(e, &["name", "cid", "isDir"], &[], "an entry")?;
                    let name = self.bytes(&eo["name"], "a name")?;
                    let c: H256 = fixed(&eo["cid"], "an entry's cid")?;
                    let is_dir = eo["isDir"].as_bool().ok_or_else(|| Reject { class: "index", message: "isDir is not true or false".into() })?;
                    hashes.extend_from_slice(&keccak256(&[&keccak256(&name)[..], &c, &[is_dir as u8]].concat()));
                    out.push((name, is_dir, c));
                }
                if keccak256(&[&[0x02u8][..], &keccak256(&hashes)].concat()) != *cid {
                    return fail("content", format!("directory {}: its entries do not hash to its CID", h(cid)));
                }
                out
            }
        };
        let mut names = HashSet::new();
        for (name, is_dir, c) in entries {
            let name = if self.store == "abxfs" { name } else { utf8_name(&name, "a name")? };
            if !names.insert(name.clone()) {
                return fail("content", "two entries in one directory have the same name");
            }
            self.entries += 1;
            if self.entries > MAX_ENTRIES {
                return fail("content", "more than 65,536 entries");
            }
            let mut p = path.to_vec();
            p.push(name);
            if is_dir {
                self.items.push((p.clone(), None));
                self.walk_dir(&c, &p, depth + 1)?;
            } else {
                let body = self.file(&c)?;
                self.items.push((p, Some(body)));
            }
        }
        self.on_path.remove(cid);
        Ok(())
    }

    fn file(&mut self, cid: &H256) -> R<Vec<u8>> {
        let f = *self.files.get(cid).ok_or_else(|| Reject { class: "content", message: format!("file {} is not in the bundle", h(cid)) })?;
        self.used_files.insert(*cid);
        match self.store.as_str() {
            "abxfs" => self.abxfs_file(cid, f),
            "bamfs2" => self.bamfs2_file(cid, f),
            _ => self.bamfs1_file(cid, f),
        }
    }

    fn chunk_body(&mut self, id: &H256) -> R<&'a Value> {
        let c = *self.chunks.get(id).ok_or_else(|| Reject { class: "content", message: format!("chunk {} is not in the bundle", h(id)) })?;
        self.used_chunks.insert(*id);
        Ok(c)
    }

    fn abxfs_file(&mut self, cid: &H256, f: &Value) -> R<Vec<u8>> {
        let o = obj(f, &["cid", "root", "mime", "codec", "outputHash"], &["content"], "a file")?;
        let root: H256 = fixed(&o["root"], "a file's root")?;
        let mime = self.bytes(&o["mime"], "a type")?;
        let codec: H256 = fixed(&o["codec"], "a codec")?;
        let oh: H256 = fixed(&o["outputHash"], "an output hash")?;
        if mime.is_empty() || mime.len() > 127 {
            return fail("content", format!("file {}: its type is not 1 to 127 bytes", h(cid)));
        }
        if keccak256(&[&[0x31u8][..], &root, &keccak256(&mime), &codec, &oh].concat()) != *cid {
            return fail("content", format!("file {}: its record does not hash to its CID", h(cid)));
        }
        if (codec == [0u8; 32]) != (oh == [0u8; 32]) {
            return fail("content", format!("file {}: a codec and an output hash go together", h(cid)));
        }
        if codec != [0u8; 32] {
            let body = self.bytes(o.get("content").ok_or_else(|| Reject { class: "content", message: format!("file {} has a codec but no content", h(cid)) })?, "content")?;
            if keccak256(&body) != oh {
                return fail("content", format!("file {}: its content does not hash to its output hash", h(cid)));
            }
            self.add_total(body.len())?;
            return Ok(body);
        }
        if o.contains_key("content") {
            return fail("content", format!("file {} has no codec but carries content", h(cid)));
        }
        if root == [0u8; 32] {
            return Ok(Vec::new());
        }
        let mut leaves = Vec::new();
        self.leaves(&root, 0x41, 42, None, &mut leaves)?;
        let mut body = Vec::new();
        for l in leaves {
            if l.len() < 39 || (l.len() - 1) % 38 != 0 {
                return fail("content", "a chunk leaf does not hold whole chunks");
            }
            for at in (1..l.len()).step_by(38) {
                let id: H256 = l[at..at + 32].try_into().unwrap();
                let size = l[at + 32..at + 38].iter().fold(0u64, |v, &x| (v << 8) | x as u64);
                let c = self.chunk_body(&id)?;
                let co = obj(c, &["backend", "inputHash", "data"], &[], "a chunk")?;
                let backend: [u8; 20] = fixed(&co["backend"], "a backend")?;
                let ih: H256 = fixed(&co["inputHash"], "an input hash")?;
                let data = self.bytes(&co["data"], "chunk data")?;
                if data.is_empty() || data.len() as u64 != size {
                    return fail("content", format!("chunk {}: its data is not the size its leaf gives", h(&id)));
                }
                let mut sz = [0u8; 6];
                sz.copy_from_slice(&(data.len() as u64).to_be_bytes()[2..]);
                if keccak256(&[&[0x30u8][..], &backend, &ih, &keccak256(&data), &sz].concat()) != id {
                    return fail("content", format!("chunk {}: its data does not give its id", h(&id)));
                }
                self.add_total(data.len())?;
                body.extend_from_slice(&data);
            }
        }
        Ok(body)
    }

    fn bamfs2_file(&mut self, cid: &H256, f: &Value) -> R<Vec<u8>> {
        let o = obj(f, &["cid", "root", "mime", "compression", "outputHash", "size"], &["content"], "a file")?;
        let root: H256 = fixed(&o["root"], "a file's root")?;
        let mime = self.bytes(&o["mime"], "a type")?;
        let comp = uint(&o["compression"], "compression")?;
        let oh: H256 = fixed(&o["outputHash"], "an output hash")?;
        let size = uint(&o["size"], "a size")?;
        if comp > 255 {
            return fail("index", "compression is not a byte");
        }
        utf8_name(&mime, "a type")?;
        if keccak256(&[&[0x11u8][..], &root, &keccak256(&mime), &[comp as u8], &oh].concat()) != *cid {
            return fail("content", format!("file {}: its record does not hash to its CID", h(cid)));
        }
        let body = if comp != 0 {
            let body = self.bytes(o.get("content").ok_or_else(|| Reject { class: "content", message: format!("file {} is compressed but has no content", h(cid)) })?, "content")?;
            if keccak256(&body) != oh {
                return fail("content", format!("file {}: its content does not hash to its output hash", h(cid)));
            }
            body
        } else {
            if oh != [0u8; 32] || o.contains_key("content") {
                return fail("content", format!("file {} is not compressed but records an output hash or content", h(cid)));
            }
            let mut leaves = Vec::new();
            self.leaves(&root, 0x21, 42, None, &mut leaves)?;
            let mut body = Vec::new();
            for l in leaves {
                if l.len() < 35 || (l.len() - 1) % 34 != 0 {
                    return fail("content", "a chunk leaf does not hold whole chunks");
                }
                for at in (1..l.len()).step_by(34) {
                    let id: H256 = l[at..at + 32].try_into().unwrap();
                    let sz = u16::from_be_bytes([l[at + 32], l[at + 33]]) as usize;
                    let c = self.chunk_body(&id)?;
                    let data = self.bytes(c, "a chunk")?;
                    if keccak256(&[&BAMFS_BACKEND[..], &data].concat()) != id || data.len() != sz {
                        return fail("content", format!("chunk {}: its bytes do not hash to its id at the size its leaf gives", h(&id)));
                    }
                    body.extend_from_slice(&data);
                }
            }
            body
        };
        if comp == 0 && body.len() as u64 != size {
            return fail("content", format!("file {} is {} bytes, its record says {size}", h(cid), body.len()));
        }
        self.add_total(body.len())?;
        Ok(body)
    }

    fn bamfs1_file(&mut self, cid: &H256, f: &Value) -> R<Vec<u8>> {
        let o = obj(f, &["cid", "chunks", "mime", "compression", "outputHash"], &["content"], "a file")?;
        let ids = o["chunks"].as_array().ok_or_else(|| Reject { class: "index", message: "chunks is not a list".into() })?;
        let ids: Vec<H256> = ids.iter().map(|x| fixed(x, "a chunk id")).collect::<R<_>>()?;
        let mime = self.bytes(&o["mime"], "a type")?;
        let comp = uint(&o["compression"], "compression")?;
        let oh: H256 = fixed(&o["outputHash"], "an output hash")?;
        if comp > 255 {
            return fail("index", "compression is not a byte");
        }
        utf8_name(&mime, "a type")?;
        if keccak256(&[&[0x01u8][..], &keccak256(&ids.concat()), &keccak256(&mime), &[comp as u8], &oh].concat()) != *cid {
            return fail("content", format!("file {}: its record does not hash to its CID", h(cid)));
        }
        let body = if comp != 0 {
            let body = self.bytes(o.get("content").ok_or_else(|| Reject { class: "content", message: format!("file {} is compressed but has no content", h(cid)) })?, "content")?;
            if keccak256(&body) != oh {
                return fail("content", format!("file {}: its content does not hash to its output hash", h(cid)));
            }
            body
        } else {
            if oh != [0u8; 32] || o.contains_key("content") {
                return fail("content", format!("file {} is not compressed but records an output hash or content", h(cid)));
            }
            let mut body = Vec::new();
            for id in &ids {
                let c = self.chunk_body(id)?;
                let data = self.bytes(c, "a chunk")?;
                if keccak256(&[&BAMFS_BACKEND[..], &data].concat()) != *id {
                    return fail("content", format!("chunk {}: its bytes do not hash to its id", h(id)));
                }
                body.extend_from_slice(&data);
            }
            body
        };
        self.add_total(body.len())?;
        Ok(body)
    }
}

const BAMFS_BACKEND: [u8; 20] = hex20("91520cdaaab44267e99d08fea7730d7a7c60e9c2");

/* ── the listing (section 11) ── */

fn encode_name(n: &[u8]) -> String {
    let mut s = String::new();
    for &b in n {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            s.push(b as char);
        } else {
            s.push_str(&format!("%{b:02X}"));
        }
    }
    s
}

/// Everything a bundle holds, checked: the listing, and each file's path and bytes.
pub struct Verified {
    pub listing: String,
    pub files: Vec<(Vec<Vec<u8>>, Vec<u8>)>,
    pub dirs: Vec<Vec<Vec<u8>>>,
    pub index_cid: Vec<u8>,
}

pub fn verify(bundle: &[u8]) -> R<Verified> {
    let parsed = car::read(bundle).class("container")?;
    let index: Value = parse_index(parsed.index).map_err(|e| Reject { class: "index", message: format!("the index is not JSON this format accepts: {e}") })?;
    if parsed.index.starts_with(&[0xef, 0xbb, 0xbf]) {
        return fail("index", "the index starts with a byte-order mark");
    }
    let mut all = Vec::new();
    links(&index, &mut all)?;
    let mut first = Vec::new();
    let mut named: HashSet<&Vec<u8>> = HashSet::new();
    for c in &all {
        if !parsed.blocks.contains_key(c) {
            return fail("container", "the index links a block the bundle lacks");
        }
        if named.insert(c) {
            first.push(c.clone());
        }
    }
    if parsed.blocks.keys().any(|k| !named.contains(k)) {
        return fail("container", "a block is not linked from the index");
    }
    if first != parsed.order {
        return fail("container", "the blocks are not in the order the index first links them");
    }
    let ix = Ix { blocks: &parsed.blocks };
    let top = obj(&index, &["format", "project", "root", "proof", "content"], &[], "the index")?;
    if top["format"] != "abx-archive/1" {
        return fail("index", "the format is not abx-archive/1");
    }
    let po = obj(&top["project"], &["chain", "org", "token", "key"], &[], "the project")?;
    let chain = uint(&po["chain"], "the chain")?;
    if ![1, 8453, 42161].contains(&chain) {
        return fail("index", "the chain is not Ethereum, Base or Arbitrum One");
    }
    let token_text = po["token"].as_str().ok_or_else(|| Reject { class: "index", message: "the token is not a string".into() })?.to_string();
    let token = decimal_word(&token_text).ok_or_else(|| Reject { class: "index", message: "the token is not a decimal number below 2^256".into() })?;
    let key = po["key"].as_str().unwrap_or("").to_string();
    if key != "abxfs.cid" && key != "bamfs.cid" {
        return fail("index", "the key is neither abxfs.cid nor bamfs.cid");
    }
    let p = Project { chain, org: fixed(&po["org"], "the org")?, token, token_text, key };
    let root: H256 = fixed(&top["root"], "the root")?;
    if root == [0u8; 32] {
        return fail("index", "the root is zero");
    }
    let co = top["content"].as_object().ok_or_else(|| Reject { class: "index", message: "the content is not an object".into() })?;
    let store = co.get("store").and_then(Value::as_str).unwrap_or("").to_string();
    let store_fits = matches!((p.key.as_str(), store.as_str()), ("abxfs.cid", "abxfs") | ("bamfs.cid", "bamfs1" | "bamfs2"));
    if !store_fits {
        return fail("index", "the store does not fit the key");
    }
    let content_keys: &[&str] = match store.as_str() {
        "bamfs1" => &["store", "dirs", "files", "chunks"],
        _ => &["store", "dirs", "files", "nodes", "chunks"],
    };
    obj(&top["content"], content_keys, &[], "the content")?;
    let b = binding(&ix, &p, &root, &top["proof"])?;

    let mut nodes = HashMap::new();
    if store != "bamfs1" {
        for (id, v) in id_map(&co["nodes"], "nodes")? {
            nodes.insert(id, ix.bytes(v, "a node")?);
        }
    }
    let mut c = Content {
        ix: &ix,
        store: store.clone(),
        dirs: keyed(&co["dirs"], "dirs")?,
        files: keyed(&co["files"], "files")?,
        nodes,
        chunks: id_map(&co["chunks"], "chunks")?,
        used_dirs: HashSet::new(),
        used_files: HashSet::new(),
        used_nodes: HashSet::new(),
        used_chunks: HashSet::new(),
        on_path: HashSet::new(),
        total: 0,
        entries: 0,
        reads: 0,
        items: Vec::new(),
    };
    if c.dirs.keys().any(|k| c.files.contains_key(k)) {
        return fail("content", "a CID is both a directory and a file");
    }
    let root_is_dir = c.dirs.contains_key(&root);
    if root_is_dir {
        c.walk_dir(&root, &[], 0)?;
    } else {
        let body = c.file(&root)?;
        c.items.push((Vec::new(), Some(body)));
    }
    if c.used_dirs.len() != c.dirs.len() || c.used_files.len() != c.files.len() || c.used_nodes.len() != c.nodes.len() || c.used_chunks.len() != c.chunks.len() {
        return fail("content", "the bundle holds directories, files, nodes or chunks its root does not reach");
    }

    let mut out = String::new();
    out.push_str("abx-archive/1\n");
    out.push_str(&format!("project {} {} {} {}\n", p.chain, h(&p.org), p.token_text, p.key));
    out.push_str(&format!("root {}\n", h(&root)));
    if let Some((n, hh)) = b.anchor {
        out.push_str(&format!("anchor {n} {}\n", h(&hh)));
    }
    if let Some((n, hh, what)) = b.l2 {
        out.push_str(&format!("l2 {n} {} {what}\n", h(&hh)));
    }
    if let Some((block, eps)) = &b.agreed {
        out.push_str(&format!("not proved agreed {block} {}\n", eps.join(",")));
    }
    if let Some((block, tx)) = &b.logged {
        out.push_str(&format!("not proved logged {block} {}\n", h(tx)));
    }
    out.push_str(&format!("store {store}\n"));
    let mut lines: Vec<(String, String)> = Vec::new();
    let (mut nfiles, mut nbytes) = (0usize, 0usize);
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    for (path, body) in &c.items {
        let p: Vec<String> = path.iter().map(|n| encode_name(n)).collect();
        let joined = p.join("/");
        match body {
            None => {
                lines.push((format!("{joined}/"), format!("d {joined}/")));
                dirs.push(path.clone());
            }
            Some(b) => {
                lines.push((joined.clone(), format!("f {joined} {} {}", b.len(), crate::hex::to_hex(&car::sha256(b)).trim_start_matches("0x"))));
                nfiles += 1;
                nbytes += b.len();
                files.push((path.clone(), b.clone()));
            }
        }
    }
    lines.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    for (_, l) in lines {
        out.push_str(&l);
        out.push('\n');
    }
    out.push_str(&format!("end {nfiles} {nbytes}\n"));
    Ok(Verified { listing: out, files, dirs, index_cid: parsed.index_cid })
}

/// Write a verified bundle's files under `dir` (section 11), refusing names that cannot be a path part.
pub fn write_files(v: &Verified, dir: &Path) -> std::result::Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    let ok = |n: &[u8]| !n.is_empty() && n != b"." && n != b".." && !n.contains(&b'/') && !n.contains(&0);
    for p in v.dirs.iter().chain(v.files.iter().map(|f| &f.0)) {
        if p.iter().any(|n| !ok(n)) {
            return Err("a name cannot be written as a path part (empty, ., .., or holding / or a zero byte)".into());
        }
    }
    if dir.exists() && std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?.next().is_some() {
        return Err(format!("{} exists and is not empty", dir.display()));
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    // Into a directory that was empty, creating every file anew: nothing is followed or written over.
    let create = |p: std::path::PathBuf, b: &[u8]| -> std::result::Result<(), String> {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&p).map_err(|e| format!("{}: {e}", p.display()))?;
        f.write_all(b).map_err(|e| e.to_string())
    };
    let path_of = |p: &[Vec<u8>]| p.iter().fold(dir.to_path_buf(), |acc, n| acc.join(std::ffi::OsStr::from_bytes(n)));
    for d in &v.dirs {
        std::fs::create_dir(path_of(d)).map_err(|e| e.to_string())?;
    }
    for (p, b) in &v.files {
        create(if p.is_empty() { dir.join("file") } else { path_of(p) }, b)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_match_the_viewer() {
        let (v, f) = param_slots(&[0u8; 32], "abxfs.cid");
        assert_eq!(h(&v), "0xcf53182b08e96a80a3594b8136d4fd6393838c5f6f5d0679d5178dcb9e2abb6a");
        assert_eq!(h(&f), "0xcf53182b08e96a80a3594b8136d4fd6393838c5f6f5d0679d5178dcb9e2abb6b");
        assert_eq!(h(&collection_code_hash()), "0x52fca2e6744bf60088e9313fac37cda721b968eb7e77c243975ab36b49b0d34c");
    }

    #[test]
    fn numbers() {
        assert_eq!(decimal_word("0"), Some([0u8; 32]));
        assert_eq!(decimal_word("256").unwrap()[30..], [1, 0]);
        assert_eq!(decimal_word("01"), None);
        assert_eq!(bits(&word_u64(0x1234), 4, 8), 0x23);
        assert_eq!(encode_name(b"a b/\xff"), "a%20b%2F%FF");
    }
}
