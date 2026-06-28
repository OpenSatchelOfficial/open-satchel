// Tauri command modules. Each submodule exposes #[tauri::command]-annotated
// functions that get registered in lib.rs via tauri::generate_handler![].

pub mod aes256_decrypt;
pub mod app;
pub mod cert_encrypt;
pub mod engine;
pub mod file;
pub mod font;
pub mod hotfolder;
pub mod libreoffice;
pub mod live_edit;
pub mod pdf;
pub mod pkcs11;
pub mod recent;
pub mod tsa;
pub mod verify;
