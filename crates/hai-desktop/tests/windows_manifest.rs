#[test]
fn windows_manifest_preserves_tauri_default_without_elevation() {
    // Snapshot of tauri-build 2.7.0/src/windows-app-manifest.xml.
    let default_manifest = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#;
    for manifest in [
        include_str!("../windows-app-manifest.xml").to_string(),
        default_manifest.replace('\n', "\r\n"),
    ] {
        assert_eq!(manifest.replace("\r\n", "\n"), default_manifest);
    }
}
