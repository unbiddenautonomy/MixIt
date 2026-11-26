//! `tauri build` refuses to start when a Tauri package for the page (npm) and its Rust
//! crate are on different minor versions. That stops the desktop app's in-app Update and
//! the release build, so check the two lock files agree.

use std::path::Path;

fn minor(v: &str) -> String {
    v.split('.').take(2).collect::<Vec<_>>().join(".")
}

#[test]
fn tauris_page_and_rust_packages_are_on_the_same_minor_version() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let cargo = std::fs::read_to_string(root.join("Cargo.lock")).unwrap();
    let npm: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("apps/desktop/package-lock.json")).unwrap()).unwrap();
    for (pkg, krate) in [("@tauri-apps/api", "tauri"), ("@tauri-apps/plugin-dialog", "tauri-plugin-dialog")] {
        let rust = cargo
            .split("[[package]]")
            .find(|p| p.contains(&format!("name = \"{krate}\"\n")))
            .and_then(|p| p.lines().find_map(|l| l.strip_prefix("version = \"")))
            .map(|v| v.trim_end_matches('"').to_string())
            .unwrap_or_else(|| panic!("{krate} isn't in Cargo.lock"));
        let page = npm["packages"][format!("node_modules/{pkg}")]["version"]
            .as_str()
            .unwrap_or_else(|| panic!("{pkg} isn't in package-lock.json"));
        assert_eq!(
            minor(page),
            minor(&rust),
            "{pkg} {page} and the {krate} crate {rust} differ: pin {pkg} to ~{} in apps/desktop/package.json",
            minor(&rust)
        );
    }
}
