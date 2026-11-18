fn main() {
    // App commands are permission-gated: only the capability in capabilities/main.json (window "main", remote origin
    // http://127.0.0.1:47800) may call them.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "engine_token",
        "engine_status",
        "engine_stop",
        "engine_uninstall",
        "engine_restart",
        "open_path",
        "open_terminal",
        "open_url",
        "open_doc",
        "confirm_remote_enable",
        "pairing_code_entry",
        "pick_folder",
        "notify",
        "update_state",
        "update_check",
        "update_start",
        "update_cancel",
        "update_dismiss",
    ])))
    .expect("tauri build script");
}
