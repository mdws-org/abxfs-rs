//! Independent implementation of the ABX FS content layer: FastCDC chunking, Solady FastLZ, chunk ids,
//! chunk-node and entry-node trees, file and directory CIDs, and IPFS CIDv1 derivation; and a verifying read path over JSON-RPC.
//!
//! Implements the ABX FS content layer as specified by Art Blocks' MIT-licensed `@artblocks/abxfs-sdk`;
//! not affiliated with Art Blocks.

pub mod abi;
#[cfg(feature = "cli")]
pub mod bamfs;
#[cfg(feature = "cli")]
pub mod chain;
pub mod chunking;
pub mod codec;
pub mod dir;
pub mod fastlz;
pub mod hex;
pub mod ids;
pub mod ipfs;
pub mod json;
pub mod mime;
pub mod nodes;
pub mod plan;
#[cfg(feature = "cli")]
pub mod project;
#[cfg(feature = "cli")]
pub mod read;
#[cfg(feature = "cli")]
pub mod serve;
#[cfg(feature = "cli")]
pub mod rpc;
pub mod scan;
#[cfg(feature = "cli")]
pub mod verify;
#[cfg(feature = "wasm")]
pub mod wasm;

/// Every refusal in this crate is a message; nothing is recoverable mid-plan.
pub type Result<T> = std::result::Result<T, String>;
