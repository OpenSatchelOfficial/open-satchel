//! CMS envelope construction on RustCrypto — the native half of
//! certificate-based PDF encryption (/Adobe.PubSec, A10).
//!
//! PROMOTED from spike status 2026-06-11 (Night-2 decision #3,
//! originally the Storm Night 1 Phase-6 spike): the Tauri shell
//! builds recipient envelopes through [`cms_envelope`] instead of
//! node-forge (`pdfCryptoPubKey.ts` keeps its forge implementation
//! only as a test-side compatibility oracle).
//!
//! Interop contract pinned by tests:
//! - forge → Rust: `unwrap_payload_for_recipient` decrypts the
//!   committed node-forge envelope fixtures (canonical + the
//!   multi-segment BER edge case), with the `cms.ber_normalized`
//!   fallback firing exactly once per envelope.
//! - Rust → Rust: wrap → unwrap round-trips with ZERO fallbacks
//!   (our output is strict canonical DER).
//! - Rust → forge: `scripts/storm/test-cms-parity.mjs` — forge
//!   finds the recipient in a Rust-built envelope (via the
//!   `cms_wrap` example) and decrypts the identical payload.

pub mod cms_envelope;
