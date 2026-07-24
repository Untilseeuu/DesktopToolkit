#[cfg(test)]
mod tests {
    use crate::automation::{execute_commands_with, CommandExecution};
    use crate::domain::{default_data_directory, runtime_settings_changed};
    use crate::launcher::{launch_queue, validate_startup_item, StartupItem};
    use crate::{
        cleanup_clipboard_images, clipboard_file_path, search, shortcut_target,
        storage::StorageManager,
    };
    use std::str::FromStr;
    use std::{
        fs,
        path::Path,
        time::{SystemTime, UNIX_EPOCH},
    };
    use tauri_plugin_global_shortcut::Shortcut;

    #[test]
    fn default_storage_is_next_to_the_executable() {
        assert_eq!(
            default_data_directory(Path::new("D:\\Apps\\Atlas\\atlas.exe")),
            Path::new("D:\\Apps\\Atlas\\data")
        );
    }

    #[test]
    fn installed_storage_ignores_legacy_data_and_retires_its_pointer() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("atlas-appdata-pointer-test-{nonce}"));
        let install_dir = root.join("Atlas");
        let legacy_data = root.join("legacy-external-data");
        let legacy_pointer = root
            .join("AppData")
            .join("atlas")
            .join("desktop-toolkit")
            .join("config")
            .join("data-location.json");
        fs::create_dir_all(legacy_pointer.parent().unwrap()).unwrap();

        let legacy = StorageManager::for_test(legacy_data.clone(), legacy_data.clone()).unwrap();
        legacy
            .update_snapshot(|snapshot| {
                *snapshot = serde_json::json!({ "marker": "legacy-appdata" });
                Ok(())
            })
            .unwrap();
        drop(legacy);
        fs::write(&legacy_pointer, serde_json::to_vec(&legacy_data).unwrap()).unwrap();

        let storage = StorageManager::for_installed_test_with_legacy_pointer(
            &install_dir.join("atlas.exe"),
            &legacy_pointer,
        )
        .unwrap();

        assert_eq!(storage.data_dir(), install_dir.join("data"));
        assert_eq!(storage.load_snapshot().unwrap(), serde_json::Value::Null);
        assert!(legacy_data.join("atlas.db").is_file());
        assert!(!legacy_pointer.exists());
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn installed_storage_retires_a_legacy_pointer_to_a_deleted_directory() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("atlas-stale-pointer-test-{nonce}"));
        let install_dir = root.join("Atlas");
        let missing_legacy_data = root.join("deleted-external-data");
        let legacy_pointer = root
            .join("AppData")
            .join("atlas")
            .join("desktop-toolkit")
            .join("config")
            .join("data-location.json");
        fs::create_dir_all(legacy_pointer.parent().unwrap()).unwrap();
        fs::write(
            &legacy_pointer,
            serde_json::to_vec(&missing_legacy_data).unwrap(),
        )
        .unwrap();

        let storage = StorageManager::for_installed_test_with_legacy_pointer(
            &install_dir.join("atlas.exe"),
            &legacy_pointer,
        )
        .unwrap();

        assert_eq!(storage.data_dir(), install_dir.join("data"));
        assert!(storage.database_path().is_file());
        assert!(!legacy_pointer.exists());
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn content_only_changes_do_not_reapply_system_settings() {
        let previous = serde_json::json!({
            "tools": { "startup": { "enabled": true }, "search": { "enabled": true } },
            "settings": { "shortcuts": { "search": "Alt+Space", "prompts": "Alt+Shift+P", "clipboard": "Alt+Shift+V" } },
            "prompts": []
        });
        let mut next = previous.clone();
        next["prompts"] = serde_json::json!([{ "id": "new" }]);
        assert!(!runtime_settings_changed(&previous, &next));
    }

    #[test]
    fn login_startup_setting_is_independent_from_the_startup_tool() {
        let previous = serde_json::json!({
            "tools": { "startup": { "enabled": true } },
            "settings": { "launchAtLogin": true }
        });
        let mut tool_disabled = previous.clone();
        tool_disabled["tools"]["startup"]["enabled"] = serde_json::json!(false);
        assert!(!runtime_settings_changed(&previous, &tool_disabled));

        let mut login_disabled = previous.clone();
        login_disabled["settings"]["launchAtLogin"] = serde_json::json!(false);
        assert!(runtime_settings_changed(&previous, &login_disabled));
    }

    #[test]
    fn login_startup_uses_only_the_configured_scene() {
        let snapshot = serde_json::json!({
            "startupItems": [
                { "id": "work", "name": "Work", "path": "C:\\Work.exe", "args": [], "delaySeconds": 0, "enabled": true, "order": 0 },
                { "id": "study", "name": "Study", "path": "C:\\Study.exe", "args": [], "delaySeconds": 0, "enabled": true, "order": 1 }
            ],
            "startupScenes": [
                { "id": "work-scene", "itemIds": ["work"] },
                { "id": "study-scene", "itemIds": ["study"] }
            ],
            "settings": { "loginSceneId": "study-scene" }
        });

        let items = crate::launcher::items_for_login_scene(&snapshot);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "study");
    }

    #[test]
    fn boot_startup_can_explicitly_select_no_scene() {
        let snapshot = serde_json::json!({
            "startupItems": [
                { "id": "work", "name": "Work", "path": "C:\\Work.exe", "args": [], "delaySeconds": 0, "enabled": true, "order": 0 }
            ],
            "startupScenes": [
                { "id": "work-scene", "itemIds": ["work"] }
            ],
            "settings": { "loginSceneId": "" }
        });

        assert!(crate::launcher::items_for_login_scene(&snapshot).is_empty());
    }

    #[test]
    fn visible_command_tasks_share_one_terminal_and_wait_in_sequence() {
        assert_eq!(
            crate::automation::terminal_script(&[
                "python -m pip install requests".into(),
                "python app.py".into()
            ]),
            "call python -m pip install requests && call python app.py"
        );
        assert_eq!(crate::automation::terminal_mode(true), "/C");
        assert_eq!(crate::automation::terminal_mode(false), "/K");
    }

    #[test]
    fn command_tasks_wait_for_each_command_and_stop_after_a_failure() {
        let mut calls = Vec::new();
        let results = execute_commands_with(
            &["first".into(), "pip install example".into(), "never".into()],
            |command| {
                calls.push(command.to_string());
                CommandExecution {
                    command: command.into(),
                    success: command != "pip install example",
                    exit_code: Some(if command == "pip install example" {
                        1
                    } else {
                        0
                    }),
                    stdout: format!("{command} output"),
                    stderr: String::new(),
                }
            },
        );

        assert_eq!(calls, vec!["first", "pip install example"]);
        assert_eq!(results.len(), 2);
        assert!(!results[1].success);
    }

    #[test]
    fn configured_shortcut_matches_the_parsed_native_shortcut() {
        let snapshot = serde_json::json!({
            "tools": { "search": { "enabled": true } },
            "settings": { "shortcuts": { "search": "Alt+F" } }
        });
        let native = Shortcut::from_str("Alt+F").unwrap();

        assert_eq!(shortcut_target(&snapshot, &native), Some("search-overlay"));
    }

    #[test]
    fn disabled_tool_never_matches_its_native_shortcut() {
        let snapshot = serde_json::json!({
            "tools": { "search": { "enabled": false } },
            "settings": { "shortcuts": { "search": "Alt+F" } }
        });
        let native = Shortcut::from_str("Alt+F").unwrap();
        assert_eq!(shortcut_target(&snapshot, &native), None);
    }

    #[test]
    fn disabling_clipboard_only_unregisters_its_own_shortcut() {
        let actual = std::collections::BTreeMap::from([
            ("search".to_string(), "Alt+Space".to_string()),
            ("prompts".to_string(), "Alt+Shift+P".to_string()),
            ("clipboard".to_string(), "Alt+Shift+V".to_string()),
        ]);
        let snapshot = serde_json::json!({
            "tools": {
                "search": { "enabled": true },
                "prompts": { "enabled": true },
                "clipboard": { "enabled": false }
            },
            "settings": { "shortcuts": {
                "search": "Alt+Space",
                "prompts": "Alt+Shift+P",
                "clipboard": "Alt+Shift+V"
            } }
        });

        let delta = crate::shortcut_registration_delta(&actual, &snapshot).unwrap();

        assert_eq!(delta.unregister, vec!["Alt+Shift+V"]);
        assert!(delta.register.is_empty());
    }

    #[test]
    fn executable_display_names_hide_extensions_and_prefer_localized_product_folders() {
        assert_eq!(
            search::application_display_name(Path::new(
                r"D:\软件\网易云音乐\CloudMusic\cloudmusic.exe"
            )),
            "网易云音乐"
        );
        assert_eq!(
            search::application_display_name(Path::new(
                r"C:\Users\me\AppData\Local\Programs\Codex\Codex.exe"
            )),
            "Codex"
        );
        assert_eq!(
            search::application_display_name(Path::new(
                r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\ChatGPT.lnk"
            )),
            "ChatGPT"
        );
    }

    #[test]
    fn registered_windows_apps_preserve_product_names_and_launch_ids() {
        let apps = search::registered_apps_from_json(
            r#"[
                {"Name":"Codex","AppID":"OpenAI.Codex_2p2nqsd0c76g0!Codex"},
                {"Name":"网易云音乐","AppID":"D:\\软件\\网易云音乐\\CloudMusic\\cloudmusic.exe"}
            ]"#,
        );

        assert_eq!(apps.len(), 2);
        assert_eq!(apps[0].name, "Codex");
        assert_eq!(
            apps[0].path,
            r"shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!Codex"
        );
        assert_eq!(apps[1].name, "网易云音乐");
        assert_eq!(
            apps[1].path,
            r"D:\软件\网易云音乐\CloudMusic\cloudmusic.exe"
        );
        assert_eq!(
            search::registered_apps_from_json(
                r#"{"Name":"ChatGPT","AppID":"OpenAI.Codex_2p2nqsd0c76g0!App"}"#
            )[0]
            .name,
            "ChatGPT"
        );
    }

    #[test]
    fn registered_apps_are_searchable_before_the_full_disk_index_finishes() {
        let apps = vec![
            search::RegisteredApp {
                name: "Codex".into(),
                path: r"shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!Codex".into(),
            },
            search::RegisteredApp {
                name: "网易云音乐".into(),
                path: r"D:\软件\网易云音乐\CloudMusic\cloudmusic.exe".into(),
            },
        ];

        let codex = search::registered_app_results(&apps, "codex", "", "", "", &["*".into()]);
        assert_eq!(codex.len(), 1);
        assert_eq!(codex[0].name, "Codex");
        assert_eq!(codex[0].kind, "app");

        let cloud_music =
            search::registered_app_results(&apps, "网易云", "app", "", "", &["*".into()]);
        assert_eq!(cloud_music.len(), 1);
        assert_eq!(cloud_music[0].name, "网易云音乐");

        assert!(
            search::registered_app_results(&apps, "codex", "file", "", "", &["*".into()])
                .is_empty()
        );
        assert!(search::registered_app_results(
            &apps,
            "网易云",
            "app",
            "",
            "",
            &[r"C:\OnlyThisFolder".into()]
        )
        .is_empty());
    }

    #[test]
    fn custom_index_roots_are_strict_path_boundaries() {
        let roots = vec![r"D:\Work\Notes".to_string()];
        assert!(search::path_matches_roots(
            Path::new(r"D:\Work\Notes\2026\plan.md"),
            &roots
        ));
        assert!(!search::path_matches_roots(
            Path::new(r"D:\Work\Notes-Archive\plan.md"),
            &roots
        ));
        assert!(!search::path_matches_roots(
            Path::new(r"C:\Windows\notepad.exe"),
            &roots
        ));
        assert!(!search::include_application_roots(&roots));
        assert!(search::include_application_roots(&["*".into()]));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn image_auto_paste_is_limited_to_rich_content_targets() {
        assert!(crate::supports_image_auto_paste("WINWORD.EXE"));
        assert!(crate::supports_image_auto_paste("chrome.exe"));
        assert!(!crate::supports_image_auto_paste("Code.exe"));
        assert!(!crate::supports_image_auto_paste("notepad.exe"));
        assert!(!crate::supports_image_auto_paste("unknown.exe"));
    }

    #[test]
    fn clipboard_image_paths_cannot_escape_the_data_directory() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("atlas-clipboard-path-test-{nonce}"));
        let storage = StorageManager::for_test(root.join("bootstrap"), root.join("data")).unwrap();

        assert!(clipboard_file_path(&storage, "clipboard-images/clip.png").is_ok());
        assert!(clipboard_file_path(&storage, "../outside.png").is_err());
        assert!(clipboard_file_path(&storage, r"C:\outside.png").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clipboard_cleanup_removes_images_that_fall_outside_the_history_limit() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("atlas-clipboard-cleanup-test-{nonce}"));
        let storage = StorageManager::for_test(root.join("bootstrap"), root.join("data")).unwrap();
        let image_directory = storage.data_dir().join("clipboard-images");
        fs::create_dir_all(&image_directory).unwrap();
        fs::write(image_directory.join("keep.png"), b"keep").unwrap();
        fs::write(image_directory.join("orphan.png"), b"orphan").unwrap();

        cleanup_clipboard_images(
            &storage,
            &[serde_json::json!({ "imageFile": "clipboard-images/keep.png" })],
        );

        assert!(image_directory.join("keep.png").exists());
        assert!(!image_directory.join("orphan.png").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn search_excludes_non_user_facing_executable_helpers() {
        for path in [
            r"D:\Apps\CloudMusic\Uninstall.exe",
            r"D:\Apps\CloudMusic\cloudmusic_reporter.exe",
            r"D:\Apps\CloudMusic\minidump_stackwalk.exe",
            r"D:\Apps\Editor\update.exe",
        ] {
            assert!(search::is_noisy_application(Path::new(path)), "{path}");
        }
        assert!(!search::is_noisy_application(Path::new(
            r"D:\Apps\CloudMusic\cloudmusic.exe"
        )));
    }

    #[test]
    fn icon_bytes_are_returned_as_a_browser_data_url() {
        assert_eq!(
            search::png_data_url(&[0x89, 0x50, 0x4e, 0x47]),
            "data:image/png;base64,iVBORw=="
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn background_helpers_use_the_no_console_window_flag() {
        assert_eq!(crate::background_process_creation_flags(), 0x0800_0000);
    }

    #[test]
    fn startup_validation_rejects_unapproved_file_types() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("atlas-startup-test-{nonce}.txt"));
        fs::write(&path, b"not executable").unwrap();
        let item = StartupItem {
            id: "unsafe".into(),
            name: "unsafe".into(),
            path: path.to_string_lossy().to_string(),
            args: Vec::new(),
            working_directory: None,
            delay_seconds: 0,
            enabled: true,
            order: 0,
        };

        assert!(validate_startup_item(&item).is_err());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn startup_queue_reports_an_invalid_item_without_failing_the_queue() {
        let item = StartupItem {
            id: "missing".into(),
            name: "Missing app".into(),
            path: std::env::temp_dir()
                .join("atlas-definitely-missing.exe")
                .to_string_lossy()
                .to_string(),
            args: Vec::new(),
            working_directory: None,
            delay_seconds: 0,
            enabled: true,
            order: 0,
        };

        let results = launch_queue(vec![item]).unwrap();

        assert_eq!(results.len(), 1);
        assert!(!results[0].success);
        assert!(results[0].error.is_some());
    }

    #[test]
    fn search_index_streams_files_through_staging_database() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("atlas-search-test-{nonce}"));
        let bootstrap = directory.join("bootstrap");
        let data = directory.join("data");
        let files = directory.join("files");
        fs::create_dir_all(&bootstrap).unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&files).unwrap();
        let nested = files.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(files.join("quarterly-notes.txt"), b"hello").unwrap();
        fs::write(files.join("项目会议纪要.docx"), b"hello").unwrap();
        fs::write(nested.join("unique-result.md"), b"hello").unwrap();
        let storage = StorageManager::for_test(bootstrap, data).unwrap();

        assert_eq!(
            search::rebuild(
                &storage,
                vec![
                    files.to_string_lossy().to_string(),
                    nested.to_string_lossy().to_string(),
                ],
            )
            .unwrap(),
            5
        );
        let results = search::query(&storage, "arter", "", "", "", &["*".into()]).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "quarterly-notes.txt");
        let chinese_results = search::query(&storage, "纪要", "", "", "", &["*".into()]).unwrap();
        assert_eq!(chinese_results.len(), 1);
        assert_eq!(chinese_results[0].name, "项目会议纪要.docx");
        let unique_results =
            search::query(&storage, "unique-result", "", "", "", &["*".into()]).unwrap();
        assert_eq!(unique_results.len(), 1);
        let outside = directory.join("outside").join("quarterly-secret.txt");
        storage
            .with_connection(|connection| {
                connection
                    .execute(
                        "INSERT INTO search_fts(name, path, kind) VALUES (?1, ?2, ?3)",
                        [
                            "quarterly-secret.txt",
                            outside.to_string_lossy().as_ref(),
                            "file",
                        ],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();
        let scoped_results = search::query(
            &storage,
            "quarterly",
            "",
            "",
            "",
            &[files.to_string_lossy().to_string()],
        )
        .unwrap();
        assert_eq!(scoped_results.len(), 1);
        assert_eq!(scoped_results[0].name, "quarterly-notes.txt");
        assert!(search::has_index(
            &storage,
            &[files.to_string_lossy().to_string()]
        ));
        assert!(!search::has_index(&storage, &["*".to_string()]));
        #[cfg(target_os = "windows")]
        {
            let drive = files.to_string_lossy()[..2].to_string();
            let drive_results =
                search::query(&storage, "quarterly", "", "", &drive, &["*".into()]).unwrap();
            assert_eq!(drive_results.len(), 2);
        }
        storage
            .with_connection(|connection| {
                connection
                    .execute(
                        "INSERT INTO search_fts(name, path, kind) VALUES (?1, ?2, ?3)",
                        ["legacy.txt", r"\\?\C:\legacy.txt", "file"],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();
        assert!(!search::has_index(
            &storage,
            &[files.to_string_lossy().to_string()]
        ));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn bootstrap_search_roots_keep_fast_user_and_start_menu_locations() {
        let base = std::env::temp_dir().join("atlas-bootstrap-roots");
        let home = base.join("home");
        let roaming = base.join("roaming");
        let program_data = base.join("program-data");

        let roots = search::bootstrap_roots_from(&home, &roaming, &program_data);

        assert!(roots.contains(&home.join("Desktop")));
        assert!(roots.contains(&home.join("Documents")));
        assert!(roots.contains(&roaming.join("Microsoft").join("Windows").join("Start Menu")));
        assert!(roots.contains(
            &program_data
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
        ));
    }
}
