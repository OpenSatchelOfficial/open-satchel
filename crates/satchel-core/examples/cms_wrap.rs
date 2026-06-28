//! SPIKE driver for the Rust→forge CMS parity direction
//! (scripts/storm/test-cms-parity.mjs). Reads from stdin, writes to
//! stdout — deliberately NO filesystem access, so the core's
//! std::fs clippy ban holds for examples too.
//!
//! stdin:  line 1 = payload hex, remaining lines = recipient cert PEM
//! stdout: CMS EnvelopedData DER, hex-encoded, one line
//!
//! Run: cargo run -p satchel-core --features crypto-spike --example cms_wrap

use std::io::Read;

fn main() {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .expect("read stdin");
    let (payload_hex, cert_pem) = input.split_once('\n').expect("payload line + cert PEM");
    let payload: Vec<u8> = (0..payload_hex.trim().len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&payload_hex.trim()[i..i + 2], 16).expect("hex"))
        .collect();

    let envelope =
        satchel_core::crypto::cms_envelope::wrap_payload_for_recipient(&payload, cert_pem)
            .expect("wrap");
    let hex: String = envelope.iter().map(|b| format!("{b:02x}")).collect();
    println!("{hex}");
}
