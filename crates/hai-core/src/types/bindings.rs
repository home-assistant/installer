use super::*;
use ts_rs::{Config, TS};

fn typescript() -> String {
    // Tauri's JSON wire format uses numbers, not JavaScript bigint values.
    let config = Config::new().with_large_int("number");
    let declarations = [
        BlockDevice::decl(&config),
        DeviceType::decl(&config),
        FlashProgress::decl(&config),
        FlashStage::decl(&config),
        DeviceManifest::decl(&config),
        Device::decl(&config),
        DeviceCategory::decl(&config),
        HaosConfig::decl(&config),
        FlashRequest::decl(&config),
        ExpectedDevice::decl(&config),
        HaosRelease::decl(&config),
        ImageFormat::decl(&config),
        HaosImage::decl(&config),
        FlashResult::decl(&config),
        ProxmoxCredentials::decl(&config),
        ProxmoxSession::decl(&config),
        ProxmoxNode::decl(&config),
        ProxmoxBridge::decl(&config),
        ProxmoxStorage::decl(&config),
        ProxmoxVmConfig::decl(&config),
        ProxmoxVmResult::decl(&config),
        UtmVmConfig::decl(&config),
        UtmVmResult::decl(&config),
        UtmStatus::decl(&config),
        SystemInfo::decl(&config),
        VmStatusInfo::decl(&config),
    ];
    let mut output = String::from(
        "// Generated from hai-core Rust wire types by ts-rs. Do not edit.\n\
         // Regenerate with npm run generate:types.\n\n",
    );
    for declaration in declarations {
        output.push_str("export ");
        output.push_str(&declaration);
        output.push_str("\n\n");
    }
    output
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_owned()
        + "\n"
}

fn output_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/api/types.ts")
}

#[test]
fn generated_types_are_current() {
    let committed =
        std::fs::read_to_string(output_path()).expect("committed TypeScript wire types");
    assert_eq!(
        committed.replace("\r\n", "\n"),
        typescript(),
        "Rust wire types changed; run npm run generate:types and commit src/api/types.ts"
    );
}

#[test]
#[ignore = "explicit regeneration only; normal tests never modify source files"]
fn export_typescript() {
    std::fs::write(output_path(), typescript()).unwrap();
}

#[test]
fn optional_values_serialize_as_required_nullable_fields() {
    let values = [
        serde_json::to_value(BlockDevice {
            id: "fixture".into(),
            name: "Fixture drive".into(),
            size: 1024,
            device_type: DeviceType::UsbDrive,
            removable: true,
            model: None,
            vendor: None,
            serial: None,
        })
        .unwrap(),
        serde_json::to_value(ProxmoxNode {
            name: "node".into(),
            status: "online".into(),
            cpu_usage: None,
            memory_used: None,
            memory_total: None,
        })
        .unwrap(),
        serde_json::to_value(ExpectedDevice::default()).unwrap(),
        serde_json::to_value(FlashResult { duration_secs: 1 }).unwrap(),
        serde_json::to_value(UtmStatus {
            installed: false,
            path: None,
            version: None,
        })
        .unwrap(),
        serde_json::to_value(VmStatusInfo {
            status: "unknown".into(),
            ip_address: None,
        })
        .unwrap(),
    ];
    let config = Config::new().with_large_int("number");
    for (value, declaration, fields) in [
        (
            &values[0],
            BlockDevice::decl(&config),
            &["model", "vendor"][..],
        ),
        (
            &values[1],
            ProxmoxNode::decl(&config),
            &["cpu_usage", "memory_used", "memory_total"][..],
        ),
        (
            &values[4],
            UtmStatus::decl(&config),
            &["path", "version"][..],
        ),
        (&values[5], VmStatusInfo::decl(&config), &["ip_address"][..]),
    ] {
        for field in fields {
            assert_eq!(value.get(*field), Some(&serde_json::Value::Null));
            assert!(declaration.contains(&format!("{field}: ")));
            assert!(!declaration.contains(&format!("{field}?:")));
        }
        assert!(declaration.contains(" | null"));
        assert!(!declaration.contains("bigint"));
    }
    // Unlike response fields, request Options also accept an omitted key.
    assert_eq!(
        serde_json::from_str::<ExpectedDevice>("{}").unwrap(),
        ExpectedDevice::default()
    );
    assert_eq!(
        serde_json::from_value::<ExpectedDevice>(values[2].clone()).unwrap(),
        ExpectedDevice::default()
    );
    let request = ExpectedDevice::decl(&config);
    for field in ["size", "model", "vendor"] {
        assert!(request.contains(&format!("{field}?: ")));
    }
    assert!(request.contains("number | null"));
}

#[test]
fn wide_integers_keep_the_existing_json_number_protocol() {
    let value = serde_json::to_value(ProxmoxNode {
        name: "node".into(),
        status: "online".into(),
        cpu_usage: Some(0.5),
        memory_used: Some(1_u64 << 40),
        memory_total: Some(u64::MAX),
    })
    .unwrap();
    assert_eq!(value["memory_used"].as_u64(), Some(1_u64 << 40));
    assert_eq!(value["memory_total"].as_u64(), Some(u64::MAX));
    let declaration = ProxmoxNode::decl(&Config::new().with_large_int("number"));
    assert!(declaration.contains("memory_used: number | null"));
    assert!(declaration.contains("memory_total: number | null"));
    // JSON numbers beyond JavaScript's safe range retain the existing precision limit.
    assert!(!typescript().contains("bigint"));
}

#[test]
fn renamed_stages_and_tagged_options_match_serde() {
    let config = Config::new().with_large_int("number");
    for stage in [
        FlashStage::Uploading,
        FlashStage::CreatingVm,
        FlashStage::StartingVm,
    ] {
        let serialized = serde_json::to_string(&stage).unwrap();
        assert!(FlashStage::decl(&config).contains(&serialized));
    }

    #[derive(Serialize, TS)]
    #[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
    enum TaggedFixture {
        MissingValue { count: Option<u64> },
    }

    assert_eq!(
        serde_json::to_value(TaggedFixture::MissingValue { count: None }).unwrap(),
        serde_json::json!({ "kind": "missing_value", "payload": { "count": null } })
    );
    let declaration = TaggedFixture::decl(&config);
    assert!(declaration.contains("\"kind\": \"missing_value\""));
    assert!(declaration.contains("\"payload\": { count: number | null"));
}
