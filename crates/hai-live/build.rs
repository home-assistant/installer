//! Compiles the catalogs in `locales/` into hai-live, so adding `<tag>.json` adds a language.

use std::collections::BTreeMap;
use std::fmt::Write;
use std::{env, fs};

fn main() {
    println!("cargo:rerun-if-changed=locales");
    let mut catalogs = Vec::new();
    for item in fs::read_dir("locales").expect("locales/ is readable") {
        let path = item.expect("locales/ is readable").path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let tag = path.file_stem().unwrap().to_string_lossy().into_owned();
        let text = fs::read_to_string(&path).unwrap();
        // Sorted by key, so a message is found by binary search
        let messages: BTreeMap<String, String> = serde_json::from_str(&text)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        catalogs.push((tag, messages));
    }
    // English first: it's the source, and what every other language falls back to
    catalogs.sort_by(|(a, _), (b, _)| (a != "en", a).cmp(&(b != "en", b)));
    assert_eq!(
        catalogs.first().map(|(tag, _)| tag.as_str()),
        Some("en"),
        "locales/en.json is missing"
    );

    let mut code = String::from("&[\n");
    for (tag, messages) in catalogs {
        writeln!(
            code,
            "    Catalog {{\n        tag: {tag:?},\n        messages: &["
        )
        .unwrap();
        for (key, message) in messages {
            writeln!(code, "            ({key:?}, {message:?}),").unwrap();
        }
        code.push_str("        ],\n    },\n");
    }
    code.push(']');
    let out = env::var("OUT_DIR").unwrap();
    fs::write(format!("{out}/catalogs.rs"), code).unwrap();
}
