fn main() {
    // `tauri::generate_context!` needs the built UI. Keep Rust-only builds (cargo check,
    // clippy, CI without Node) working with a placeholder until `npm run build` runs.
    let dist = std::path::Path::new("../dist");
    if !dist.join("index.html").exists() {
        std::fs::create_dir_all(dist).expect("create ../dist");
        std::fs::write(
            dist.join("index.html"),
            "<!doctype html><title>MixIt</title><p>Build the UI with <code>npm run build</code> in apps/desktop.</p>",
        )
        .expect("write placeholder UI");
    }
    tauri_build::build()
}
