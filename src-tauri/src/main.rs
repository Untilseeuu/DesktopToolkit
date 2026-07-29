#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let helper_mode = std::env::args().any(|argument| argument == "--atlas-mft-helper");
    if helper_mode {
        if let Err(error) = atlas_desktop_toolkit_lib::run() {
            eprintln!("{error}");
        }
        return;
    }
    if let Err(error) = atlas_desktop_toolkit_lib::run() {
        atlas_desktop_toolkit_lib::report_startup_failure(&error);
    }
}
