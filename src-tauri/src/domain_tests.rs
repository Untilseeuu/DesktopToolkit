#[cfg(test)]
mod tests {
    use crate::automation::{execute_commands_with, CommandExecution};
    use crate::domain::{default_data_directory, runtime_settings_changed};
    use crate::launcher::{launch_queue, validate_startup_item, StartupItem};
    use crate::{
        cleanup_clipboard_images, clipboard_file_path, delete_clipboard_entry, desired_shortcuts,
        folder_shortcut_target, quick_overlay_spec, runtime_search_snapshot,
        runtime_shortcut_snapshot, runtime_shortcut_snapshot_for_registered, search,
        shortcut_target, storage::StorageManager, ClipboardSequenceTracker,
    };
    use serde_json::Value;
    use std::{
        collections::BTreeMap,
        fs,
        path::Path,
        str::FromStr,
        sync::{Arc, Mutex},
        thread,
        time::{SystemTime, UNIX_EPOCH},
    };
    use tauri_plugin_global_shortcut::Shortcut;

    static SEARCH_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn quick_tools_reuse_one_webview_window() {
        let search = quick_overlay_spec("search-overlay").unwrap();
        let prompts = quick_overlay_spec("prompts-overlay").unwrap();
        let clipboard = quick_overlay_spec("clipboard-overlay").unwrap();

        assert_eq!(search.window_label, "quick-overlay");
        assert_eq!(prompts.window_label, search.window_label);
        assert_eq!(clipboard.window_label, search.window_label);
        assert_eq!(search.mode, "search");
        assert_eq!(prompts.mode, "prompts");
        assert_eq!(clipboard.mode, "clipboard");
    }

    #[test]
    fn quick_overlay_blur_is_deferred_during_a_shortcut_mode_switch() {
        let source = include_str!("lib.rs");
        assert!(source.contains("schedule_quick_overlay_blur_hide(window.clone())"));
        assert!(!source.contains(
            "WindowEvent::Focused(false) if window.label() != \"main\" => {\n                let _ = window.hide();"
        ));
    }

    #[test]
    fn available_drive_labels_include_only_existing_root_drives() {
        assert_eq!(
            search::drive_labels_from_roots([
                Path::new(r"C:\"),
                Path::new(r"D:\"),
                Path::new(r"C:\Users"),
                Path::new(r"\\server\share"),
            ]),
            vec!["C:", "D:"]
        );
    }

    #[test]
    fn completed_index_progress_reports_scanned_items_and_roots() {
        let _search_test = SEARCH_TEST_LOCK.lock().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("atlas-progress-{nonce}"));
        let root = directory.join("files");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("paper.pdf"), b"pdf").unwrap();
        let storage =
            StorageManager::for_test(directory.join("bootstrap"), directory.join("data")).unwrap();

        search::rebuild(&storage, vec![root.to_string_lossy().to_string()]).unwrap();
        let progress = search::progress();

        assert_eq!(progress.status, "ready");
        assert_eq!(progress.phase, "complete");
        assert_eq!(progress.total_roots, 1);
        assert_eq!(progress.completed_roots, 1);
        assert!(progress.indexed_items >= 2);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn search_candidate_sql_uses_fts_optimized_bounded_ranking() {
        let sql = search::indexed_candidate_sql();
        let normalized = sql.to_ascii_lowercase();

        assert!(!normalized.contains("bm25("));
        assert!(normalized.contains("order by rank"));
        assert!(normalized.contains("limit"));
    }

    #[test]
    fn broad_search_reserves_bounded_candidates_for_each_result_kind() {
        assert_eq!(
            search::candidate_kind_plan(""),
            vec![("app", 64), ("folder", 128), ("file", 256)]
        );
        assert_eq!(search::candidate_kind_plan("folder"), vec![("folder", 320)]);
    }

    #[test]
    fn exact_name_is_not_lost_beyond_the_bounded_candidate_window() {
        let _search_test = SEARCH_TEST_LOCK.lock().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("atlas-search-rank-{nonce}"));
        let storage =
            StorageManager::for_test(directory.join("bootstrap"), directory.join("data")).unwrap();
        storage
            .with_search_connection(|connection| {
                let transaction = connection
                    .transaction()
                    .map_err(|error| error.to_string())?;
                for index in 0..400 {
                    transaction
                        .execute(
                            "INSERT INTO search_fts(name, path, kind) VALUES (?1, ?2, 'file')",
                            [
                                format!("atlas-noise-{index:03}.txt"),
                                format!(r"D:\noise\atlas-noise-{index:03}.txt"),
                            ],
                        )
                        .map_err(|error| error.to_string())?;
                }
                transaction
                    .execute(
                        "INSERT INTO search_fts(name, path, kind) VALUES ('atlas', 'D:\\atlas', 'file')",
                        [],
                    )
                    .map_err(|error| error.to_string())?;
                transaction.commit().map_err(|error| error.to_string())
            })
            .unwrap();

        let results = search::query(&storage, "atlas", "file", "", "", &["*".into()]).unwrap();

        assert_eq!(
            results.first().map(|result| result.name.as_str()),
            Some("atlas")
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_new_file_in_an_indexed_user_directory_is_searchable_before_the_next_rebuild() {
        let _search_test = SEARCH_TEST_LOCK.lock().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("atlas-live-file-{nonce}"));
        let root = directory.join("desktop");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("existing.txt"), b"old").unwrap();
        let storage =
            StorageManager::for_test(directory.join("bootstrap"), directory.join("data")).unwrap();
        search::rebuild(&storage, vec![root.to_string_lossy().to_string()]).unwrap();

        let expected = root.join("毕业设计课题拟定7.26.docx");
        fs::write(&expected, b"new").unwrap();
        let results = search::query(
            &storage,
            "毕业设计课题",
            "file",
            "docx",
            "",
            &[root.to_string_lossy().to_string()],
        )
        .unwrap();

        assert!(results
            .iter()
            .any(|result| result.path == expected.to_string_lossy()));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn an_incremental_file_notification_updates_a_nested_index_entry() {
        let _search_test = SEARCH_TEST_LOCK.lock().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("atlas-incremental-{nonce}"));
        let root = directory.join("root");
        let nested = root.join("deep").join("documents");
        fs::create_dir_all(&nested).unwrap();
        let storage =
            StorageManager::for_test(directory.join("bootstrap"), directory.join("data")).unwrap();
        search::rebuild(&storage, vec![root.to_string_lossy().to_string()]).unwrap();
        let added = nested.join("新增论文.pdf");
        fs::write(&added, b"pdf").unwrap();

        search::refresh_path(&storage, &added).unwrap();
        let results = search::query(
            &storage,
            "新增论文",
            "file",
            "pdf",
            "",
            &[root.to_string_lossy().to_string()],
        )
        .unwrap();

        assert!(results
            .iter()
            .any(|result| result.path == added.to_string_lossy()));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn interrupted_index_resumes_after_the_last_completed_root() {
        let _search_test = SEARCH_TEST_LOCK.lock().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("atlas-resume-{nonce}"));
        let first = directory.join("a-root");
        let second = directory.join("b-root");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        let preserved = first.join("preserved.txt");
        fs::write(&preserved, b"first").unwrap();
        let preserved_app = first.join("PreservedApp.exe");
        fs::write(&preserved_app, b"app").unwrap();
        let resumed = second.join("resumed.pdf");
        fs::write(&resumed, b"second").unwrap();
        let storage =
            StorageManager::for_test(directory.join("bootstrap"), directory.join("data")).unwrap();
        let roots = vec![
            first.to_string_lossy().to_string(),
            second.to_string_lossy().to_string(),
        ];
        let scope = search::scope_key(&roots);
        storage
            .with_search_connection(|connection| {
                connection
                    .execute_batch(
                        "
                        DROP TABLE IF EXISTS search_fts_next;
                        CREATE VIRTUAL TABLE search_fts_next USING fts5(
                            name, path UNINDEXED, kind UNINDEXED,
                            modified_at UNINDEXED, tokenize = 'trigram'
                        );
                        ",
                    )
                    .map_err(|error| error.to_string())?;
                connection
                    .execute(
                        "INSERT INTO search_fts_next(name, path, kind) VALUES (?1, ?2, 'file')",
                        ["preserved.txt", &preserved.to_string_lossy()],
                    )
                    .map_err(|error| error.to_string())?;
                connection
                    .execute(
                        "INSERT INTO search_fts_next(name, path, kind) VALUES (?1, ?2, 'app')",
                        ["PreservedApp.exe", &preserved_app.to_string_lossy()],
                    )
                    .map_err(|error| error.to_string())?;
                connection
                    .execute(
                        "
                        INSERT INTO search_build_meta(
                            id, scope, completed_roots, indexed_items
                        ) VALUES (1, ?1, 1, 2)
                        ",
                        [&scope],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();

        assert!(search::has_partial_index(&storage, &roots));
        search::rebuild(&storage, roots.clone()).unwrap();
        let preserved_results =
            search::query(&storage, "preserved", "file", "", "", &roots).unwrap();
        let resumed_results = search::query(&storage, "resumed", "file", "", "", &roots).unwrap();
        let app_results = search::query(&storage, "PreservedApp", "app", "", "", &roots).unwrap();

        assert!(preserved_results
            .iter()
            .any(|result| result.path == preserved.to_string_lossy()));
        assert!(resumed_results
            .iter()
            .any(|result| result.path == resumed.to_string_lossy()));
        assert!(app_results
            .iter()
            .any(|result| result.path == preserved_app.to_string_lossy()));
        assert!(!search::has_partial_index(&storage, &roots));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn interrupted_index_preserves_the_partially_scanned_current_root() {
        let _search_test = SEARCH_TEST_LOCK.lock().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("atlas-current-root-resume-{nonce}"));
        let root = directory.join("root");
        fs::create_dir_all(&root).unwrap();
        let preserved = root.join("preserved.txt");
        fs::write(&preserved, b"partial").unwrap();
        let storage =
            StorageManager::for_test(directory.join("bootstrap"), directory.join("data")).unwrap();
        let roots = vec![root.to_string_lossy().to_string()];
        let scope = search::scope_key(&roots);
        storage
            .with_search_connection(|connection| {
                connection
                    .execute_batch(
                        "
                        DROP TABLE IF EXISTS search_fts_next;
                        CREATE VIRTUAL TABLE search_fts_next USING fts5(
                            name, path UNINDEXED, kind UNINDEXED,
                            modified_at UNINDEXED, tokenize = 'trigram'
                        );
                        ",
                    )
                    .map_err(|error| error.to_string())?;
                connection
                    .execute(
                        "INSERT INTO search_fts_next(name, path, kind)
                         VALUES ('checkpointalias', ?1, 'file')",
                        [&preserved.to_string_lossy()],
                    )
                    .map_err(|error| error.to_string())?;
                connection
                    .execute(
                        "
                        INSERT INTO search_build_meta(
                            id, scope, completed_roots, indexed_items
                        ) VALUES (1, ?1, 0, 1)
                        ",
                        [&scope],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();

        search::rebuild(&storage, roots.clone()).unwrap();
        let results = search::query(&storage, "checkpointalias", "file", "", "", &roots).unwrap();

        assert!(
            results
                .iter()
                .any(|result| result.path == preserved.to_string_lossy()),
            "results: {results:?}"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn default_storage_is_next_to_the_executable() {
        assert_eq!(
            default_data_directory(Path::new("D:\\Apps\\Atlas\\atlas.exe")),
            Path::new("D:\\Apps\\Atlas\\data")
        );
    }

    #[test]
    fn startup_failures_are_written_beside_the_installed_application_data() {
        assert_eq!(
            crate::startup_log_path_for_executable(Path::new(
                "D:\\Apps\\Atlas\\atlas-desktop-toolkit.exe"
            )),
            Path::new("D:\\Apps\\Atlas\\data\\atlas-startup.log")
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
    fn installed_storage_reopens_an_existing_data_directory_and_preserves_state() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("atlas-existing-data-test-{nonce}"));
        let install_dir = root.join("Atlas");
        let executable = install_dir.join("atlas.exe");
        let legacy_pointer = root.join("missing-legacy-pointer.json");

        let first =
            StorageManager::for_installed_test_with_legacy_pointer(&executable, &legacy_pointer)
                .unwrap();
        first
            .update_snapshot(|snapshot| {
                *snapshot = serde_json::json!({ "marker": "existing-data" });
                Ok(())
            })
            .unwrap();
        drop(first);

        let reopened =
            StorageManager::for_installed_test_with_legacy_pointer(&executable, &legacy_pointer)
                .unwrap();

        assert_eq!(reopened.data_dir(), install_dir.join("data"));
        assert_eq!(
            reopened
                .load_snapshot()
                .unwrap()
                .get("marker")
                .and_then(Value::as_str),
            Some("existing-data")
        );
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn foreground_snapshot_writes_do_not_wait_for_the_search_index_writer() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("atlas-writer-gate-{nonce}"));
        let storage = Arc::new(
            StorageManager::for_test(directory.join("bootstrap"), directory.join("data")).unwrap(),
        );
        let gate = storage.index_write_guard();
        let writer_storage = storage.clone();
        let (completed_tx, completed_rx) = std::sync::mpsc::channel();
        let writer = thread::spawn(move || {
            writer_storage.update_snapshot(|snapshot| {
                *snapshot = serde_json::json!({ "saved": true });
                Ok(())
            })?;
            completed_tx.send(()).map_err(|error| error.to_string())
        });

        assert!(completed_rx
            .recv_timeout(std::time::Duration::from_millis(250))
            .is_ok());
        drop(gate);
        writer.join().unwrap().unwrap();
        assert_eq!(
            storage
                .load_snapshot()
                .unwrap()
                .get("saved")
                .and_then(Value::as_bool),
            Some(true)
        );
        drop(storage);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn background_index_throttle_never_creates_visible_quarter_second_stalls() {
        assert!(search::index_pause_millis(100, true) <= 40);
        assert!(search::index_pause_millis(100, false) <= 40);
    }

    #[test]
    fn deleting_one_clipboard_entry_removes_its_image_file() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("atlas-delete-clipboard-{nonce}"));
        let storage =
            StorageManager::for_test(directory.join("bootstrap"), directory.join("data")).unwrap();
        let image = storage
            .data_dir()
            .join("clipboard-images")
            .join("entry.png");
        fs::create_dir_all(image.parent().unwrap()).unwrap();
        fs::write(&image, b"png").unwrap();
        storage
            .update_snapshot(|snapshot| {
                *snapshot = serde_json::json!({
                    "clipboardHistory": [
                        { "id": "image", "kind": "image", "imageFile": "clipboard-images/entry.png", "copiedAt": 2 },
                        { "id": "text", "kind": "text", "text": "keep", "copiedAt": 1 }
                    ]
                });
                Ok(())
            })
            .unwrap();

        let remaining = delete_clipboard_entry(&storage, "image").unwrap();

        assert!(!image.exists());
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].get("id").and_then(Value::as_str), Some("text"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn loading_snapshot_never_runs_schema_migrations_or_mutates_tables() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("atlas-read-only-load-{nonce}"));
        let storage =
            StorageManager::for_test(directory.join("bootstrap"), directory.join("data")).unwrap();
        storage
            .with_state_connection(|connection| {
                connection
                    .execute_batch(
                        "
                        CREATE TABLE search_entries(marker TEXT NOT NULL);
                        INSERT INTO search_entries(marker) VALUES ('must-survive');
                        ",
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();

        assert_eq!(storage.load_snapshot().unwrap(), serde_json::Value::Null);
        let marker = storage
            .with_read_connection(|connection| {
                connection
                    .query_row("SELECT marker FROM search_entries", [], |row| {
                        row.get::<_, String>(0)
                    })
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_eq!(marker, "must-survive");

        drop(storage);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn clipboard_monitor_skips_unchanged_windows_clipboard_sequences() {
        let mut tracker = ClipboardSequenceTracker::default();

        assert!(tracker.should_attempt(Some(41)));
        assert!(tracker.should_attempt(Some(41)));
        tracker.commit(Some(41));
        assert!(!tracker.should_attempt(Some(41)));
        assert!(tracker.should_attempt(Some(42)));
        tracker.commit(Some(42));
        assert!(!tracker.should_attempt(Some(42)));
        assert!(tracker.should_attempt(None));
    }

    #[test]
    fn clipboard_monitor_abandons_a_permanently_unreadable_sequence() {
        let mut tracker = ClipboardSequenceTracker::default();

        for _ in 0..4 {
            assert!(!tracker.record_failure(Some(77)));
            assert!(tracker.should_attempt(Some(77)));
        }
        assert!(tracker.record_failure(Some(77)));
        assert!(!tracker.should_attempt(Some(77)));
        assert!(tracker.should_attempt(Some(78)));
    }

    #[test]
    fn runtime_shortcut_cache_keeps_only_routing_fields() {
        let source = serde_json::json!({
            "tools": {
                "search": { "enabled": true },
                "prompts": { "enabled": false },
                "clipboard": { "enabled": true },
                "folders": { "enabled": true },
                "automation": { "enabled": true }
            },
            "settings": {
                "shortcuts": {
                    "search": "Alt+Space",
                    "prompts": "Alt+Shift+P",
                    "clipboard": "Alt+Shift+V"
                },
                "clipboardLimit": 500
            },
            "folderFavorites": [{
                "id": "docs",
                "path": "D:\\Documents",
                "shortcut": "Ctrl+Alt+D",
                "description": "kept out of the cache"
            }],
            "clipboardHistory": [{ "text": "private and potentially large" }],
            "prompts": [{ "content": "also potentially large" }]
        });

        let cached = runtime_shortcut_snapshot(&source);

        assert_eq!(
            cached
                .pointer("/settings/shortcuts/search")
                .and_then(Value::as_str),
            Some("Alt+Space")
        );
        assert_eq!(
            cached
                .pointer("/folderFavorites/0/path")
                .and_then(Value::as_str),
            Some("D:\\Documents")
        );
        assert!(cached.get("clipboardHistory").is_none());
        assert!(cached.get("prompts").is_none());
        assert!(cached.pointer("/settings/clipboardLimit").is_none());
        assert!(cached.pointer("/tools/automation").is_none());
        assert!(cached.pointer("/folderFavorites/0/description").is_none());
    }

    #[test]
    fn runtime_shortcut_cache_uses_actual_registration_but_latest_tool_switches() {
        let proposed = serde_json::json!({
            "tools": {
                "search": { "enabled": false },
                "prompts": { "enabled": true },
                "clipboard": { "enabled": true },
                "folders": { "enabled": true }
            },
            "settings": {
                "shortcuts": {
                    "search": "Ctrl+Alt+S",
                    "prompts": "Ctrl+Alt+P",
                    "clipboard": "Ctrl+Alt+V"
                }
            },
            "folderFavorites": []
        });
        let actual = BTreeMap::from([
            ("search".to_string(), "Alt+Space".to_string()),
            ("prompts".to_string(), "Alt+Shift+P".to_string()),
            ("clipboard".to_string(), "Alt+Shift+V".to_string()),
        ]);

        let cached = runtime_shortcut_snapshot_for_registered(&proposed, &actual);

        assert_eq!(
            cached
                .pointer("/settings/shortcuts/search")
                .and_then(Value::as_str),
            Some("Alt+Space")
        );
        let old_search = "Alt+Space".parse::<Shortcut>().unwrap();
        assert_eq!(shortcut_target(&cached, &old_search), None);
        let old_prompts = "Alt+Shift+P".parse::<Shortcut>().unwrap();
        assert_eq!(
            shortcut_target(&cached, &old_prompts),
            Some("prompts-overlay")
        );
    }

    #[test]
    fn runtime_search_cache_excludes_large_user_collections() {
        let source = serde_json::json!({
            "tools": { "search": { "enabled": false } },
            "settings": {
                "indexRoots": ["D:\\学习资料"],
                "clipboardLimit": 500
            },
            "clipboardHistory": [{ "text": "large history" }],
            "prompts": [{ "content": "large prompt collection" }]
        });

        let cached = runtime_search_snapshot(&source);

        assert_eq!(
            cached
                .pointer("/tools/search/enabled")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            cached
                .pointer("/settings/indexRoots/0")
                .and_then(Value::as_str),
            Some("D:\\学习资料")
        );
        assert!(cached.get("clipboardHistory").is_none());
        assert!(cached.get("prompts").is_none());
        assert!(cached.pointer("/settings/clipboardLimit").is_none());
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
    fn login_startup_restores_the_selected_scene_layout_when_enabled() {
        let snapshot = serde_json::json!({
            "settings": { "loginSceneId": "work-scene" },
            "startupScenes": [{
                "id": "work-scene",
                "restoreLayout": true,
                "windowLayouts": [{
                    "itemId": "work",
                    "executablePath": "C:\\Work.exe",
                    "rect": { "x": 10, "y": 20, "width": 900, "height": 700 },
                    "maximized": false,
                    "monitorDeviceName": "\\\\.\\DISPLAY1"
                }]
            }]
        });

        let layouts = crate::launcher::layouts_for_login_scene(&snapshot);

        assert_eq!(layouts.len(), 1);
        assert_eq!(layouts[0].item_id, "work");
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
    fn enabled_folder_favorites_register_and_resolve_their_shortcuts() {
        let snapshot = serde_json::json!({
            "tools": {
                "search": { "enabled": false },
                "prompts": { "enabled": false },
                "clipboard": { "enabled": false },
                "folders": { "enabled": true }
            },
            "folderFavorites": [{
                "id": "docs",
                "name": "资料",
                "path": "D:\\资料",
                "shortcut": "Ctrl+Alt+D"
            }]
        });
        let shortcut = Shortcut::from_str("Ctrl+Alt+D").unwrap();

        assert_eq!(
            desired_shortcuts(&snapshot).unwrap().get("folder:docs"),
            Some(&"Ctrl+Alt+D".to_string())
        );
        assert_eq!(
            folder_shortcut_target(&snapshot, &shortcut),
            Some("D:\\资料".to_string())
        );
    }

    #[test]
    fn disabled_folder_tool_does_not_register_or_resolve_favorite_shortcuts() {
        let snapshot = serde_json::json!({
            "tools": {
                "search": { "enabled": false },
                "prompts": { "enabled": false },
                "clipboard": { "enabled": false },
                "folders": { "enabled": false }
            },
            "folderFavorites": [{
                "id": "docs",
                "path": "D:\\资料",
                "shortcut": "Ctrl+Alt+D"
            }]
        });
        let shortcut = Shortcut::from_str("Ctrl+Alt+D").unwrap();

        assert!(desired_shortcuts(&snapshot).unwrap().is_empty());
        assert_eq!(folder_shortcut_target(&snapshot, &shortcut), None);
    }

    #[test]
    fn folder_shortcuts_must_include_a_modifier_key() {
        let snapshot = serde_json::json!({
            "tools": {
                "search": { "enabled": false },
                "prompts": { "enabled": false },
                "clipboard": { "enabled": false },
                "folders": { "enabled": true }
            },
            "folderFavorites": [{
                "id": "docs",
                "path": "D:\\资料",
                "shortcut": "D"
            }]
        });

        assert!(desired_shortcuts(&snapshot)
            .unwrap_err()
            .contains("至少包含一个修饰键"));
    }

    #[test]
    fn changing_folder_favorites_requests_runtime_shortcut_reconciliation() {
        let previous = serde_json::json!({
            "tools": { "folders": { "enabled": true } },
            "folderFavorites": []
        });
        let mut next = previous.clone();
        next["folderFavorites"] = serde_json::json!([{
            "id": "docs",
            "path": "D:\\资料",
            "shortcut": "Ctrl+Alt+D"
        }]);

        assert!(runtime_settings_changed(&previous, &next));
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
    fn common_product_aliases_find_the_installed_application_name() {
        let apps = vec![search::RegisteredApp {
            name: "ChatGPT".into(),
            path: r"shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App".into(),
        }];

        let results = search::registered_app_results(&apps, "codex", "app", "", "", &["*".into()]);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "ChatGPT");
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
    fn clipboard_capture_respects_pause_and_excluded_applications() {
        let enabled = serde_json::json!({
            "tools": { "clipboard": { "enabled": true } },
            "settings": {
                "clipboardCapturePaused": false,
                "clipboardExcludedApps": ["1Password.exe", "SecretEditor"]
            }
        });
        assert!(crate::clipboard_capture_allowed(
            &enabled,
            Some("notepad.exe")
        ));
        assert!(!crate::clipboard_capture_allowed(
            &enabled,
            Some("1PASSWORD.EXE")
        ));
        assert!(!crate::clipboard_capture_allowed(
            &enabled,
            Some("SecretEditor.exe")
        ));
        assert!(!crate::clipboard_capture_allowed(&enabled, None));

        let mut paused = enabled.clone();
        paused["settings"]["clipboardCapturePaused"] = serde_json::json!(true);
        assert!(!crate::clipboard_capture_allowed(
            &paused,
            Some("notepad.exe")
        ));

        let mut disabled = enabled;
        disabled["tools"]["clipboard"]["enabled"] = serde_json::json!(false);
        assert!(!crate::clipboard_capture_allowed(
            &disabled,
            Some("notepad.exe")
        ));
    }

    #[test]
    fn clipboard_retention_removes_expired_records_before_applying_the_count_limit() {
        let day = 24 * 60 * 60 * 1000u64;
        let now = 40 * day;
        let entries = vec![
            serde_json::json!({ "id": "new", "copiedAt": now - day }),
            serde_json::json!({ "id": "old", "copiedAt": now - 31 * day }),
            serde_json::json!({ "id": "undated" }),
        ];

        let retained = crate::retain_recent_clipboard_entries(entries, now, 30, 1);
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0]["id"], "new");
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
    fn search_index_streams_files_directly_into_the_next_fts_table() {
        let _search_test = SEARCH_TEST_LOCK.lock().unwrap();
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
        let storage = StorageManager::for_test(bootstrap, data.clone()).unwrap();

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
        assert!(!data.join("search-index-staging.db").exists());
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
            .with_search_connection(|connection| {
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
            .with_search_connection(|connection| {
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
    fn search_index_keeps_paths_unindexed_and_bounds_name_alias_payloads() {
        let _search_test = SEARCH_TEST_LOCK.lock().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("atlas-compact-index-{nonce}"));
        let files = directory.join("files");
        fs::create_dir_all(&files).unwrap();
        fs::write(files.join("网易云音乐.exe"), b"app").unwrap();
        let storage =
            StorageManager::for_test(directory.join("bootstrap"), directory.join("data")).unwrap();

        search::rebuild(&storage, vec![files.to_string_lossy().to_string()]).unwrap();

        let (schema, indexed_name) = storage
            .with_search_read_connection(|connection| {
                let schema = connection
                    .query_row(
                        "SELECT sql FROM sqlite_master WHERE name = 'search_fts'",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(|error| error.to_string())?;
                let indexed_name = connection
                    .query_row(
                        "SELECT name FROM search_fts WHERE kind = 'app' LIMIT 1",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(|error| error.to_string())?;
                Ok((schema, indexed_name))
            })
            .unwrap();
        assert!(schema.to_ascii_lowercase().contains("path unindexed"));
        assert!(
            indexed_name.contains("wangyiyunyinyue"),
            "indexed name was {indexed_name:?}"
        );
        assert!(indexed_name.len() < 256);

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn chinese_document_aliases_do_not_bloat_the_full_disk_index() {
        let _search_test = SEARCH_TEST_LOCK.lock().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("atlas-file-aliases-{nonce}"));
        let files = directory.join("files");
        fs::create_dir_all(&files).unwrap();
        let name = format!("{}.docx", "毕业设计课题拟定与评审记录".repeat(6));
        fs::write(files.join(&name), b"document").unwrap();
        let storage =
            StorageManager::for_test(directory.join("bootstrap"), directory.join("data")).unwrap();

        search::rebuild(&storage, vec![files.to_string_lossy().to_string()]).unwrap();

        let indexed_name = storage
            .with_search_read_connection(|connection| {
                connection
                    .query_row(
                        "SELECT name FROM search_fts WHERE kind = 'file' LIMIT 1",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert!(
            indexed_name.len() < 768,
            "document aliases used {} bytes",
            indexed_name.len()
        );

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn exact_folder_search_does_not_fill_results_with_unrelated_children() {
        let _search_test = SEARCH_TEST_LOCK.lock().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("atlas-folder-quality-{nonce}"));
        let root = directory.join("drive");
        let entertainment = root.join("娱乐");
        fs::create_dir_all(&entertainment).unwrap();
        fs::write(entertainment.join("unrelated-helper.exe"), b"app").unwrap();
        let storage =
            StorageManager::for_test(directory.join("bootstrap"), directory.join("data")).unwrap();
        search::rebuild(&storage, vec![root.to_string_lossy().to_string()]).unwrap();

        let results = search::query(
            &storage,
            "娱乐",
            "",
            "",
            "",
            &[root.to_string_lossy().to_string()],
        )
        .unwrap();

        assert!(results.iter().any(
            |result| result.kind == "folder" && result.path == entertainment.to_string_lossy()
        ));
        assert!(!results
            .iter()
            .any(|result| result.name == "unrelated-helper"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn search_finds_a_root_folder_before_the_full_index_is_complete() {
        let _search_test = SEARCH_TEST_LOCK.lock().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("atlas-root-search-{nonce}"));
        let bootstrap = directory.join("bootstrap");
        let data = directory.join("data");
        let root = directory.join("drive");
        let target = root.join("娱乐");
        fs::create_dir_all(&bootstrap).unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&target).unwrap();
        let storage = StorageManager::for_test(bootstrap, data).unwrap();

        let results = search::query(
            &storage,
            "娱乐",
            "",
            "",
            "",
            &[root.to_string_lossy().to_string()],
        )
        .unwrap();

        assert!(results
            .iter()
            .any(|result| result.kind == "folder" && result.path == target.to_string_lossy()));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn search_matches_chinese_names_by_full_pinyin_and_initials() {
        let _search_test = SEARCH_TEST_LOCK.lock().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("atlas-search-pinyin-test-{nonce}"));
        let bootstrap = directory.join("bootstrap");
        let data = directory.join("data");
        let files = directory.join("files");
        fs::create_dir_all(&files).unwrap();
        fs::write(files.join("网易云音乐.exe"), b"app").unwrap();
        let storage = StorageManager::for_test(bootstrap, data).unwrap();
        search::rebuild(&storage, vec![files.to_string_lossy().to_string()]).unwrap();

        let full = search::query(&storage, "wangyiyunyinyue", "", "", "", &["*".into()]).unwrap();
        let initials = search::query(&storage, "wyyy", "", "", "", &["*".into()]).unwrap();

        assert_eq!(
            full.first().map(|result| result.name.as_str()),
            Some("网易云音乐")
        );
        assert_eq!(
            initials.first().map(|result| result.name.as_str()),
            Some("网易云音乐")
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn search_tolerates_one_transposed_character() {
        let _search_test = SEARCH_TEST_LOCK.lock().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("atlas-search-typo-test-{nonce}"));
        let bootstrap = directory.join("bootstrap");
        let data = directory.join("data");
        let files = directory.join("files");
        fs::create_dir_all(&files).unwrap();
        fs::write(files.join("cloudmusic.exe"), b"app").unwrap();
        let storage = StorageManager::for_test(bootstrap, data).unwrap();
        search::rebuild(&storage, vec![files.to_string_lossy().to_string()]).unwrap();

        let results = search::query(&storage, "cloudmuisc", "", "", "", &["*".into()]).unwrap();

        assert_eq!(
            results.first().map(|result| result.name.as_str()),
            Some("cloudmusic")
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn search_recalls_a_four_character_name_after_one_substitution() {
        let _search_test = SEARCH_TEST_LOCK.lock().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("atlas-search-short-typo-{nonce}"));
        let files = directory.join("files");
        fs::create_dir_all(&files).unwrap();
        fs::write(files.join("note.txt"), b"note").unwrap();
        let storage =
            StorageManager::for_test(directory.join("bootstrap"), directory.join("data")).unwrap();
        search::rebuild(&storage, vec![files.to_string_lossy().to_string()]).unwrap();

        let results = search::query(&storage, "nate", "", "", "", &["*".into()]).unwrap();

        assert_eq!(
            results.first().map(|result| result.name.as_str()),
            Some("note.txt")
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn short_synonyms_use_the_expanded_fts_candidate() {
        let _search_test = SEARCH_TEST_LOCK.lock().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("atlas-search-short-synonym-{nonce}"));
        let files = directory.join("files");
        fs::create_dir_all(&files).unwrap();
        fs::write(files.join("cloud-drive.txt"), b"cloud").unwrap();
        let storage =
            StorageManager::for_test(directory.join("bootstrap"), directory.join("data")).unwrap();
        search::rebuild(&storage, vec![files.to_string_lossy().to_string()]).unwrap();

        let results = search::query(&storage, "云盘", "", "", "", &["*".into()]).unwrap();

        assert_eq!(
            results.first().map(|result| result.name.as_str()),
            Some("cloud-drive.txt")
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn old_index_format_scope_is_never_reused() {
        let _search_test = SEARCH_TEST_LOCK.lock().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("atlas-search-old-scope-{nonce}"));
        let storage =
            StorageManager::for_test(directory.join("bootstrap"), directory.join("data")).unwrap();
        storage
            .with_search_connection(|connection| {
                connection
                    .execute(
                        "INSERT INTO search_fts(name, path, kind) VALUES ('legacy', 'D:\\legacy.txt', 'file')",
                        [],
                    )
                    .map_err(|error| error.to_string())?;
                connection
                    .execute(
                        "INSERT INTO search_meta(id, scope, complete) VALUES (1, '[\"v5\",\"*\"]', 1)",
                        [],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();

        assert!(!search::has_index(&storage, &["*".into()]));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn search_expands_common_chinese_and_english_synonyms() {
        let _search_test = SEARCH_TEST_LOCK.lock().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("atlas-search-synonym-test-{nonce}"));
        let bootstrap = directory.join("bootstrap");
        let data = directory.join("data");
        let files = directory.join("files");
        fs::create_dir_all(&files).unwrap();
        fs::write(files.join("浏览器收藏夹.txt"), b"links").unwrap();
        let storage = StorageManager::for_test(bootstrap, data).unwrap();
        search::rebuild(&storage, vec![files.to_string_lossy().to_string()]).unwrap();

        let results = search::query(&storage, "browser", "", "", "", &["*".into()]).unwrap();

        assert_eq!(
            results.first().map(|result| result.name.as_str()),
            Some("浏览器收藏夹.txt")
        );
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
