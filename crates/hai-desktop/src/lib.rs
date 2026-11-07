//! Home Assistant Installer - Desktop Application
//!
//! This crate provides the Tauri desktop application for HAI.
//! It uses hai-core for business logic and provides Tauri command wrappers.

mod backend;
mod close_guard;
mod command_error;
mod commands;
mod diagnostics;
mod elevation;
mod flash_state;
mod install_jobs;
mod live_usb;
mod updates;

#[cfg(desktop)]
use tauri::Manager;

use commands::{
    cancel_flash, cancel_vm_install, check_connection, check_ha_ready, check_ha_updated,
    check_utm_automation, check_utm_status, create_utm_vm, discard_utm_image, download_utm_image,
    find_home_assistants, flash_image, get_ha_setup_status, get_haos_release, get_manifest,
    get_system_info, get_utm_haos_release, get_utm_vm_status, language_override,
    list_block_devices, proxmox_certificate_fingerprint, proxmox_check_vm_config, proxmox_connect,
    proxmox_create_vm, proxmox_enable_storage_import, proxmox_get_next_vm_id,
    proxmox_get_vm_status, proxmox_list_bridges, proxmox_list_nodes, proxmox_list_storage,
    relaunch_as_admin, start_utm_vm, utm_supported, utm_vm_name_taken,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    elevation::wait_for_previous_instance();
    #[cfg(target_os = "linux")]
    ignore_host_gio_modules();

    let builder = tauri::Builder::default();

    // Register first so a second launch exits before initializing other plugins.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));

    builder
        .manage(flash_state::FlashState::default())
        .manage(commands::PendingUtmImages::default())
        .manage(install_jobs::InstallJobs::default())
        .manage(updates::PendingUpdate::default())
        .plugin(diagnostics::plugin())
        .setup(|app| {
            diagnostics::init();
            #[cfg(target_os = "macos")]
            close_guard::guard_app_termination(app.handle());
            if let Ok(dir) = app.path().resource_dir() {
                live_usb::set_resource_dir(dir);
            }
            clear_cache();
            // The real app cache folder, which the mock must leave alone
            #[cfg(not(feature = "mock"))]
            if hai_core::download::remove_legacy_downloads().is_err() {
                diagnostics::warning("legacy_cache_cleanup_failed");
            }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(close_guard::on_window_event)
        .invoke_handler(tauri::generate_handler![
            check_connection,
            list_block_devices,
            relaunch_as_admin,
            flash_image,
            cancel_flash,
            get_manifest,
            get_haos_release,
            get_system_info,
            language_override,
            close_guard::quit_anyway,
            diagnostics::get_diagnostics,
            diagnostics::log_frontend_event,
            diagnostics::open_logs_folder,
            updates::check_for_update,
            updates::download_update,
            updates::install_update,
            updates::restart_after_update,
            // UTM commands (hai-core reports UTM as unsupported off macOS)
            check_utm_status,
            check_utm_automation,
            utm_vm_name_taken,
            utm_supported,
            get_utm_haos_release,
            download_utm_image,
            cancel_vm_install,
            discard_utm_image,
            create_utm_vm,
            start_utm_vm,
            get_utm_vm_status,
            check_ha_ready,
            check_ha_updated,
            get_ha_setup_status,
            find_home_assistants,
            // Proxmox commands
            proxmox_certificate_fingerprint,
            proxmox_connect,
            proxmox_list_nodes,
            proxmox_list_storage,
            proxmox_list_bridges,
            proxmox_enable_storage_import,
            proxmox_get_next_vm_id,
            proxmox_get_vm_status,
            proxmox_check_vm_config,
            proxmox_create_vm,
            // Live USB commands (bootable stick or ISO for a mini PC)
            live_usb::live_usb_status,
            live_usb::create_live_usb,
            live_usb::save_live_iso,
            live_usb::check_iso_location,
            live_usb::reveal_in_folder
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_, event| {
            if let tauri::RunEvent::Exit = event {
                clear_cache();
            }
        });
}

/// Downloads live for one session. Single instance: nothing else uses them.
fn clear_cache() {
    let cleared = hai_core::ReleaseSource::cache_dir(&backend::Backend)
        .and_then(|cache| hai_core::download::clear_cache(&cache));
    if cleared.is_err() {
        diagnostics::warning("cache_clear_failed");
    }
}

/// Modules in the host's GIO_EXTRA_MODULES (gvfs and dconf on NixOS) are built against
/// the host's GLib and fail to load into the bundled one, in the app and its WebKit processes.
#[cfg(target_os = "linux")]
fn ignore_host_gio_modules() {
    // Runs before any thread starts, so the environment is safe to change.
    // APPDIR is set whenever the bundled GLib runs, also from an extracted AppImage.
    if std::env::var_os("APPDIR").is_some() {
        std::env::remove_var("GIO_EXTRA_MODULES");
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use tauri::utils::config::{
        parse::parse_json, BundleTarget, BundleType, Updater, WebviewInstallMode,
    };

    #[test]
    fn beta_packaging_has_explicit_formats_and_runtime_requirements() {
        let config = parse_json(
            include_str!("../tauri.conf.json"),
            Path::new("tauri.conf.json"),
        )
        .unwrap();
        // The download cache is filed under this identifier as well
        assert_eq!(config.identifier, hai_core::APP_IDENTIFIER);
        assert_eq!(
            config.bundle.targets,
            BundleTarget::List(vec![
                // The updater installs the .app itself, packed next to the DMG
                BundleType::App,
                BundleType::Dmg,
                BundleType::Nsis,
                BundleType::Deb,
                BundleType::Rpm,
                BundleType::AppImage,
            ])
        );
        assert_eq!(
            config.bundle.macos.minimum_system_version.as_deref(),
            Some("14.5")
        );
        assert_eq!(
            config.bundle.windows.webview_install_mode,
            WebviewInstallMode::EmbedBootstrapper { silent: true }
        );
        for dependencies in [
            config.bundle.linux.deb.depends,
            config.bundle.linux.rpm.depends,
        ] {
            assert!(dependencies.unwrap().iter().any(|name| name == "udisks2"));
        }
        // Without its own GStreamer plugins, the AppImage's WebKit aborts on any audio
        assert!(config.bundle.linux.appimage.bundle_media_framework);
    }

    #[test]
    fn updates_are_signed_and_only_release_runs_sign_them() {
        let config = parse_json(
            include_str!("../tauri.conf.json"),
            Path::new("tauri.conf.json"),
        )
        .unwrap();
        // Release runs turn this on, as only they have the signing key
        assert_eq!(config.bundle.create_updater_artifacts, Updater::Bool(false));

        let updater: tauri_plugin_updater::Config =
            serde_json::from_value(config.plugins.0["updater"].clone()).unwrap();
        assert!(!updater.pubkey.is_empty());
        // A manifest can't pair a new version with an older signed release
        assert!(updater.require_signed_version);
        assert!(!updater.allow_downgrades);
        // The update check picks the release, and so the endpoint, itself
        assert!(updater.endpoints.is_empty());
    }
}
