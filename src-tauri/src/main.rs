#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(error) = atlas_desktop_toolkit_lib::run() {
        atlas_desktop_toolkit_lib::report_startup_failure(&error);
    }
}
