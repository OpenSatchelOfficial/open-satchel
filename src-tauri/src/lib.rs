// Library entry point. Keeping the bulk of the app here (rather than in
// main.rs) lets us share code with future mobile targets and unit-test the
// Tauri setup if we want to.

mod commands;
mod error;
pub mod license;
pub mod live;
pub mod pdf_engine;

use std::sync::Mutex;
use tauri::Manager;

pub type Result<T> = std::result::Result<T, error::AppError>;

/// Parsed CLI args held in Tauri state so the frontend can pull them
/// on mount. Race-free replacement for the event-based dispatch —
/// the frontend calls cli_get_pending_args() when it's ready rather
/// than Rust emitting an event the listener may not be attached for.
#[derive(Clone, serde::Serialize)]
pub struct CliArgs {
    pub action_path: String,
    pub input_path: String,
}

pub struct CliArgsState(pub Mutex<Option<CliArgs>>);

#[tauri::command]
fn cli_get_pending_args(state: tauri::State<'_, CliArgsState>) -> Option<CliArgs> {
    // Take the args out — one-shot. Second call returns None so CLI
    // dispatch only runs once even if frontend HMR remounts.
    state.0.lock().ok().and_then(|mut g| g.take())
}

/// Pure args parser — lifted out of setup() so it's unit-testable.
/// Returns Some(CliArgs) only when BOTH --action and --input (or their
/// short forms / = form) are present. Otherwise None (normal GUI launch).
fn parse_env_args(args: Vec<String>) -> Option<CliArgs> {
    let mut action: Option<String> = None;
    let mut input: Option<String> = None;
    let mut i = 1; // skip argv[0] (program name)
    while i < args.len() {
        let a = &args[i];
        let take_next = |target: &mut Option<String>, i: &mut usize| {
            if *i + 1 < args.len() {
                *target = Some(args[*i + 1].clone());
                *i += 2;
            } else {
                *i += 1;
            }
        };
        let take_eq = |prefix: &str, target: &mut Option<String>, i: &mut usize| -> bool {
            if let Some(rest) = a.strip_prefix(prefix) {
                *target = Some(rest.to_string());
                *i += 1;
                true
            } else {
                false
            }
        };
        if a == "--action" || a == "-a" {
            take_next(&mut action, &mut i);
        } else if a == "--input" || a == "-i" {
            take_next(&mut input, &mut i);
        } else if take_eq("--action=", &mut action, &mut i) { /* handled */
        } else if take_eq("--input=", &mut input, &mut i) { /* handled */
        } else {
            i += 1;
        }
    }
    match (action, input) {
        (Some(action_path), Some(input_path)) => Some(CliArgs {
            action_path,
            input_path,
        }),
        _ => None,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_cli::init())
        .invoke_handler(tauri::generate_handler![
            // --- file ops ---
            commands::file::open_file_dialog,
            commands::file::open_file_path,
            commands::file::pick_open_path,
            commands::file::save_file,
            commands::file::save_file_dialog,
            commands::file::pick_save_path,
            commands::file::pick_folder,
            commands::file::pick_folder_path,
            commands::file::hash_file,
            // --- recent ---
            commands::recent::recent_get,
            commands::recent::recent_add,
            commands::recent::recent_remove,
            commands::recent::recent_clear,
            // --- pdf (stubs in M1; native impl in M2+) ---
            commands::pdf::pdf_page_count,
            commands::pdf::pdf_render_page,
            commands::pdf::pdf_extract_text,
            commands::pdf::pdfa_get_srgb_icc,
            commands::pdf::pdfa_get_standard14_substitute,
            // --- font subsystem (M2) ---
            commands::font::font_list_system,
            commands::font::font_get_bytes,
            commands::font::font_imported_list,
            commands::font::font_import_file,
            commands::font::font_imported_remove,
            commands::font::font_scan_pdf,
            commands::font::font_subset,
            // --- tsa / ocsp http proxy ---
            // Routes zgapdfsigner's TSA + OCSP requests through native
            // reqwest so WebView2 CORS doesn't block them. See
            // src-tauri/src/commands/tsa.rs for the host allow-list.
            commands::tsa::tsa_fetch,
            // --- hot-folder (batch triggers) ---
            commands::hotfolder::watch_folder,
            commands::hotfolder::unwatch_folder,
            commands::hotfolder::list_watched_folders,
            // --- CLI dispatch ---
            cli_get_pending_args,
            // --- LibreOffice sidecar (export fallback for docx/xlsx/pptx) ---
            commands::libreoffice::libreoffice_detect,
            commands::libreoffice::libreoffice_convert,
            // --- PKCS#11 (HSM / smart card / YubiKey signing) ---
            // See src-tauri/src/commands/pkcs11.rs. Pure runtime loader —
            // module .dll path comes from user-configured settings.
            commands::pkcs11::pkcs11_list_slots,
            commands::pkcs11::pkcs11_list_certificates,
            commands::pkcs11::pkcs11_sign_hash,
            // --- app ---
            commands::app::app_version,
            // --- live-edit (Phase 0/1/2 of docs/LIVE-EDIT-PLAN.md) ---
            commands::live_edit::live_session_open,
            commands::live_edit::live_apply_op,
            commands::live_edit::live_checkpoint,
            commands::live_edit::live_session_close,
            commands::live_edit::live_get_model,
            // --- pdf engine ---
            // Writer, renderer, and bake are all live. The frontend
            // save path invokes `engine_bake_from_bytes` for
            // paragraph edits; the hybrid editor invokes
            // `engine_render_page_with_skips_from_bytes` for its
            // truth-layer overlay. Path-based variants are kept for
            // tests + future CLI / scripts.
            commands::engine::engine_save_incremental,
            commands::engine::engine_render_page,
            commands::engine::engine_render_page_from_bytes,
            commands::engine::engine_render_page_lru,
            commands::engine::engine_invalidate_render_cache,
            commands::engine::engine_render_cache_stats,
            commands::engine::engine_reap_pool_workers,
            commands::engine::engine_prefetch_pages,
            commands::engine::engine_render_pages_concurrent,
            commands::cert_encrypt::pdf_encrypt_to_certs,
            commands::engine::engine_page_count,
            commands::engine::engine_probe_linearization,
            commands::engine::engine_bake,
            commands::engine::engine_bake_to_path,
            commands::engine::engine_rewrite_to_path,
            commands::engine::engine_bake_from_bytes,
            commands::engine::engine_rewrite_from_bytes,
            commands::engine::engine_render_page_with_skips,
            commands::engine::engine_list_page_text_objects,
            commands::engine::engine_render_page_with_skips_from_bytes,
            commands::engine::engine_extract_page_fonts,
            commands::engine::engine_extract_page_fonts_from_bytes,
            // --- PDF structural inspection helpers ---
            commands::verify::pdf_verify_annotation,
            commands::verify::pdf_verify_acroform,
            commands::verify::pdf_verify_encryption,
            commands::verify::pdf_verify_names_tree,
            commands::verify::pdf_verify_page_size,
            commands::verify::pdf_verify_metadata,
            commands::verify::pdf_verify_xobject_count,
            commands::verify::pdf_verify_ocgs,
            commands::verify::pdf_verify_watermark_text,
            // New (this session) — page manipulation + structural verifiers.
            commands::verify::pdf_verify_page_count,
            commands::verify::pdf_verify_page_order,
            commands::verify::pdf_verify_page_labels,
            commands::verify::pdf_resolve_page_labels,
            commands::verify::pdf_verify_initial_view,
            commands::verify::pdf_verify_pages_have_text,
            commands::verify::pdf_render_page_png,
            commands::verify::pdf_verify_xobject_replaced,
            commands::verify::pdf_decrypt_bytes,
            commands::verify::pdf_remove_watermark_text,
            commands::verify::pdf_strip_text_in_bboxes,
            commands::verify::pdf_strip_text_in_bboxes_to_path,
            commands::verify::pdf_grep_full_file,
            // --- commercial license verification ---
            // Offline Ed25519 JWT check. Edition label only — no
            // feature gating anywhere in the codebase.
            license::license_activate,
            license::license_status,
            license::license_deactivate,
        ])
        .manage(CliArgsState(Mutex::new(None)))
        .manage(live::LiveSessionsState::new())
        .manage(license::LicenseState::default())
        .setup(|app| {
            // On startup, log where we are. Useful for debugging first-run.
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(debug_assertions)]
                {
                    window.open_devtools();
                }
                let _ = window.set_title("Open Satchel");
            }

            // CLI dispatch — parse std::env::args directly. Simpler +
            // 100% reliable vs tauri-plugin-cli which was returning
            // empty matches even with takesValue=true in config.
            //
            // Supports:  --action <path> --input <path>
            //            -a <path>        -i <path>
            //            --action=<path>  --input=<path>
            let cli_args = parse_env_args(std::env::args().collect::<Vec<_>>());
            if let Some(args) = cli_args {
                let state = app.state::<CliArgsState>();
                let mut guard = state.0.lock().expect("cli args mutex poisoned");
                *guard = Some(args);
                drop(guard);
            }

            // Load any persisted commercial license and re-verify it
            // (so expired licenses don't leak through across restarts).
            license::load_on_startup(app.handle());

            // Point pdfium at the bundled resource dir so end users
            // get a working binary out of the box. Developers can
            // override PDFIUM_DYNAMIC_LIB_PATH before launch to point
            // at a custom pdfium build. See
            // src-tauri/src/pdf_engine/render.rs for the lookup order.
            //
            // Both the in-process renderer and the spawned
            // pdfium_worker children inherit this env var, so the
            // multi-process render pool also picks it up.
            if std::env::var_os("PDFIUM_DYNAMIC_LIB_PATH").is_none() {
                if let Ok(resource_dir) = app.path().resource_dir() {
                    let candidate = resource_dir.join("resources").join("pdfium");
                    if candidate.exists() {
                        std::env::set_var("PDFIUM_DYNAMIC_LIB_PATH", &candidate);
                    }
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
