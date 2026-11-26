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
    stamp_source();
    tauri_build::build()
}

/// Records the checkout and commit this copy is built from, so Update (src/update.rs)
/// can tell what's new. Both are empty when building outside a git checkout.
fn stamp_source() {
    let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let root = manifest.join("../../..").canonicalize().unwrap_or_default();
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    };
    let commit = git(&["rev-parse", "HEAD"]);
    println!("cargo:rustc-env=MIXIT_COMMIT={commit}");
    println!(
        "cargo:rustc-env=MIXIT_SOURCE={}",
        if commit.is_empty() { String::new() } else { root.display().to_string() }
    );
    // Rebuild the stamp when the checked-out commit moves.
    let dotgit = root.join(".git");
    for f in ["HEAD", "packed-refs"] {
        println!("cargo:rerun-if-changed={}", dotgit.join(f).display());
    }
    let head = std::fs::read_to_string(dotgit.join("HEAD")).unwrap_or_default();
    if let Some(r) = head.strip_prefix("ref: ") {
        println!("cargo:rerun-if-changed={}", dotgit.join(r.trim()).display());
    }
}
