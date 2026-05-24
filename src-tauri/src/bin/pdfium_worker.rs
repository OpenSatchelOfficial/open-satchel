//! Out-of-process pdfium render worker.
//!
//! Spawned by [`open_satchel_lib::pdf_engine::render_pool::PdfiumPool`].
//! The pool keeps N of these alive concurrently, each one a separate
//! OS process — that is the entire point. pdfium-render's `thread_safe`
//! wrapper serializes every render through one global mutex inside the
//! library, so N threads in the same process gain ~zero parallelism.
//! N processes do.
//!
//! Wire protocol (each direction, framed):
//!
//!   stdin  : <u32 BE: body_len> <body: serde_json RenderRequest>
//!   stdout : <u8 status: 0=ok, 1=err> <u32 BE: body_len> <body>
//!
//! On status=0 the body is PNG bytes; on status=1 it's a UTF-8 error
//! message. Worker exits cleanly when the parent closes stdin.
//!
//! NOTE: the worker calls the same `render_page_to_png` the in-process
//! path does, so cache-key parity (page index, scale rounding) is
//! automatic — the LRU cache sits ABOVE the pool, not below it.

use std::io::{ErrorKind, Read, Write};

use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct RenderRequest {
    path: String,
    page_index: u16,
    scale: f32,
}

fn main() -> std::io::Result<()> {
    let stdin = std::io::stdin();
    let mut stdin = stdin.lock();
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();

    loop {
        let mut len_buf = [0u8; 4];
        match stdin.read_exact(&mut len_buf) {
            Ok(()) => {}
            // Parent closed the pipe — clean shutdown.
            Err(e) if e.kind() == ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e),
        }
        let len = u32::from_be_bytes(len_buf) as usize;
        // Cap at 1 MB so a corrupted frame doesn't OOM the worker.
        if len > 1_048_576 {
            write_err(&mut stdout, &format!("frame too large: {len}"))?;
            continue;
        }
        let mut req_buf = vec![0u8; len];
        stdin.read_exact(&mut req_buf)?;

        let req: RenderRequest = match serde_json::from_slice(&req_buf) {
            Ok(r) => r,
            Err(e) => {
                write_err(&mut stdout, &format!("invalid request: {e}"))?;
                continue;
            }
        };

        match open_satchel_lib::pdf_engine::render_page_to_png(&req.path, req.page_index, req.scale)
        {
            Ok(png) => write_ok(&mut stdout, &png)?,
            Err(e) => write_err(&mut stdout, &e.to_string())?,
        }
    }
}

fn write_ok<W: Write>(w: &mut W, body: &[u8]) -> std::io::Result<()> {
    w.write_all(&[0u8])?;
    w.write_all(&(body.len() as u32).to_be_bytes())?;
    w.write_all(body)?;
    w.flush()
}

fn write_err<W: Write>(w: &mut W, msg: &str) -> std::io::Result<()> {
    let bytes = msg.as_bytes();
    w.write_all(&[1u8])?;
    w.write_all(&(bytes.len() as u32).to_be_bytes())?;
    w.write_all(bytes)?;
    w.flush()
}
