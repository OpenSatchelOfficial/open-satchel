//! extract_pdf_text — tiny diagnostic: prints extracted text from a PDF
//! via pdfium. Used to verify the invoice_loop's edited.pdf outputs
//! actually carry the edited text.

use pdfium_render::prelude::Pdfium;
use std::env;

fn main() {
    let path = env::args().nth(1).expect("usage: extract_pdf_text <pdf>");
    let bytes = std::fs::read(&path).expect("read pdf");
    let bindings = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(
        "../tools/pdfium/bin",
    ))
    .expect("bind pdfium");
    let pdfium = Pdfium::new(bindings);
    let doc = pdfium.load_pdf_from_byte_slice(&bytes, None).expect("load");
    for (idx, page) in doc.pages().iter().enumerate() {
        println!("=== page {idx} ===");
        let t = page.text().expect("text");
        println!("{}", t.all());
    }
}
