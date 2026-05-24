// LibreOffice sidecar — detect an installed LO on the host, shell out
// `soffice --headless --convert-to <fmt>` to turn a PDF into docx/xlsx/
// pptx/rtf/html. Much higher fidelity than our built-in pdfjs-based
// converters for complex layouts; gated on the user having LO installed
// (we ship nothing — 300+ MB bundle would be a non-starter).
//
// Fidelity ceiling is about 60-65% — LibreOffice's own PDF import is
// positioned-text-box-grid based, not paragraph-flow. Good enough for
// "I need to edit this in Word" but not for byte-identical round-trip.
// That's still meaningfully better than our built-in converter for any
// document with multi-column layout, tables, or non-trivial formatting.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::AppError;

/// Output formats supported by LO's PDF importer + exporter combo.
/// Matches `soffice --convert-to` format strings 1:1.
fn supported_formats() -> &'static [&'static str] {
    &[
        "docx", "xlsx", "pptx", "rtf", "html", "odt", "ods", "odp", "txt",
    ]
}

/// Locate an installed soffice/libreoffice binary. First check PATH,
/// then Windows / macOS / Linux standard install locations. Returns the
/// first hit; None if LO isn't installed or is in a non-standard path.
fn find_soffice() -> Option<PathBuf> {
    // 1. $PATH
    let candidates_on_path = ["soffice", "libreoffice", "soffice.exe", "libreoffice.exe"];
    for name in candidates_on_path.iter() {
        if let Ok(out) = Command::new(if cfg!(windows) { "where" } else { "which" })
            .arg(name)
            .output()
        {
            if out.status.success() {
                if let Ok(s) = String::from_utf8(out.stdout) {
                    if let Some(line) = s.lines().next() {
                        let p = PathBuf::from(line.trim());
                        if p.exists() {
                            return Some(p);
                        }
                    }
                }
            }
        }
    }

    // 2. OS-specific standard locations
    let hardcoded: Vec<PathBuf> = if cfg!(windows) {
        vec![
            PathBuf::from(r"C:\Program Files\LibreOffice\program\soffice.exe"),
            PathBuf::from(r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"),
        ]
    } else if cfg!(target_os = "macos") {
        vec![PathBuf::from(
            "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        )]
    } else {
        vec![
            PathBuf::from("/usr/bin/soffice"),
            PathBuf::from("/usr/bin/libreoffice"),
            PathBuf::from("/usr/local/bin/soffice"),
            PathBuf::from("/usr/local/bin/libreoffice"),
            PathBuf::from("/opt/libreoffice/program/soffice"),
        ]
    };
    for p in hardcoded {
        if p.exists() {
            return Some(p);
        }
    }
    None
}

#[derive(serde::Serialize)]
pub struct LibreOfficeInfo {
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

#[tauri::command]
pub async fn libreoffice_detect() -> std::result::Result<LibreOfficeInfo, AppError> {
    let Some(path) = find_soffice() else {
        return Ok(LibreOfficeInfo {
            available: false,
            path: None,
            version: None,
        });
    };
    // Best-effort version extraction — `soffice --version` prints to
    // stdout. Failure isn't fatal; if we found the binary, it's
    // "available" even if we can't parse a version string.
    let version = Command::new(&path)
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8(o.stdout)
                    .ok()
                    .map(|s| s.trim().to_string())
            } else {
                None
            }
        });
    Ok(LibreOfficeInfo {
        available: true,
        path: Some(path.to_string_lossy().to_string()),
        version,
    })
}

/// Convert PDF bytes to the given target format via the LibreOffice
/// sidecar. Writes input to a tempfile, invokes soffice, reads the
/// output file, cleans up. Returns the converted bytes.
#[tauri::command]
pub async fn libreoffice_convert(
    bytes: Vec<u8>,
    target_format: String,
) -> std::result::Result<Vec<u8>, AppError> {
    if !supported_formats().contains(&target_format.as_str()) {
        return Err(AppError::InvalidArgument(format!(
            "unsupported target format: {target_format} (supported: {})",
            supported_formats().join(", ")
        )));
    }
    let soffice = find_soffice().ok_or_else(|| {
        AppError::NotFound(
            "LibreOffice not found on this system. Install LibreOffice (https://www.libreoffice.org) to enable high-fidelity PDF export."
                .to_string(),
        )
    })?;

    // Unique temp dir — each convert call gets its own so concurrent
    // conversions don't fight. Cleaned up after read.
    let work_dir = std::env::temp_dir().join(format!("open-satchel-lo-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work_dir)
        .map_err(|e| AppError::Other(anyhow::anyhow!("tmpdir create: {e}")))?;

    let input_path = work_dir.join("input.pdf");
    std::fs::write(&input_path, &bytes)
        .map_err(|e| AppError::Other(anyhow::anyhow!("write input: {e}")))?;

    // LibreOffice user-profile dir. Running headless conversions without
    // an isolated profile risks picking up the user's interactive session
    // (or refusing to start because one's already open). Forcing a per-
    // invocation profile keeps this from fighting an open LO window.
    let profile_dir = work_dir.join("user-profile");
    let profile_url = format!(
        "-env:UserInstallation=file://{}",
        profile_dir.to_string_lossy().replace('\\', "/")
    );

    let output = Command::new(&soffice)
        .arg(&profile_url)
        .arg("--headless")
        .arg("--norestore")
        .arg("--nologo")
        .arg("--nofirststartwizard")
        .arg("--convert-to")
        .arg(&target_format)
        .arg("--outdir")
        .arg(&work_dir)
        .arg(&input_path)
        .output()
        .map_err(|e| AppError::Other(anyhow::anyhow!("spawn soffice: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = std::fs::remove_dir_all(&work_dir);
        return Err(AppError::Other(anyhow::anyhow!(
            "soffice --convert-to failed (exit {}): {stderr}",
            output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "?".to_string())
        )));
    }

    // LibreOffice writes <base>.<ext> into outdir. Base is the input
    // stem — "input.pdf" → "input". Find the produced file with our
    // target extension.
    let produced = find_produced_file(&work_dir, &target_format);
    let Some(produced_path) = produced else {
        let _ = std::fs::remove_dir_all(&work_dir);
        return Err(AppError::Other(anyhow::anyhow!(
            "LibreOffice reported success but no output file was produced in {}",
            work_dir.to_string_lossy()
        )));
    };

    let out_bytes = std::fs::read(&produced_path)
        .map_err(|e| AppError::Other(anyhow::anyhow!("read output: {e}")))?;
    let _ = std::fs::remove_dir_all(&work_dir);
    Ok(out_bytes)
}

fn find_produced_file(dir: &Path, ext: &str) -> Option<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return None;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case(ext))
            .unwrap_or(false)
        {
            return Some(path);
        }
    }
    None
}
