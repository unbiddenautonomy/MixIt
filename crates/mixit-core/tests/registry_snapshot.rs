//! The desktop UI's tests check Ask MixIt against the real action registry, kept as a
//! file beside them. This fails when the registry changes and the file wasn't brought
//! up to date; `MIXIT_UPDATE_REGISTRY=1 cargo test -p mixit-core --test registry_snapshot`
//! rewrites it.

use mixit_core::actions::{ActionKind, registry};
use serde_json::{Value, json};

#[test]
fn the_ui_tests_see_the_real_registry() {
    // Four decks and eight pads, as the desktop app and the browser engine build it.
    let list: Vec<Value> = registry(4, 8)
        .into_iter()
        .map(|a| {
            let kind = match &a.kind {
                ActionKind::Trigger => json!({ "type": "trigger" }),
                ActionKind::Momentary => json!({ "type": "momentary" }),
                ActionKind::Toggle => json!({ "type": "toggle" }),
                ActionKind::Continuous { spec } => json!({
                    "type": "continuous",
                    "spec": { "min": spec.min, "max": spec.max, "default": spec.default, "unit": format!("{:?}", spec.unit) }
                }),
                ActionKind::Choice { options, default } => json!({ "type": "choice", "options": options, "default": default }),
            };
            json!({ "id": a.id, "label": a.label, "group": a.group, "kind": kind })
        })
        .collect();
    let text = serde_json::to_string_pretty(&list).unwrap() + "\n";
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src/test/fixtures/registry.json");
    if std::env::var_os("MIXIT_UPDATE_REGISTRY").is_some() {
        std::fs::write(&path, &text).unwrap();
        return;
    }
    let have = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        have == text,
        "{} is out of date: run MIXIT_UPDATE_REGISTRY=1 cargo test -p mixit-core --test registry_snapshot",
        path.display()
    );
}
