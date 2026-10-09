use std::path::Path;

#[test]
fn utm_automation_permission_is_included_in_the_macos_bundle() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let config: tauri::Config = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let macos = config.bundle.macos;
    assert!(macos.hardened_runtime);

    let info: plist::Value = plist::from_file(root.join(macos.info_plist.unwrap())).unwrap();
    let info = info.as_dictionary().unwrap();
    let purpose = info["NSAppleEventsUsageDescription"].as_string().unwrap();
    assert!(purpose.contains("UTM"));
    assert!(purpose.contains("create and start"));
    assert!(purpose.contains("Home Assistant virtual machine"));

    let entitlements: plist::Value =
        plist::from_file(root.join(macos.entitlements.unwrap())).unwrap();
    assert_eq!(
        entitlements.as_dictionary().unwrap()["com.apple.security.automation.apple-events"]
            .as_boolean(),
        Some(true)
    );
}
