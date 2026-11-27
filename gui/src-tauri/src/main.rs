// Desktop entry point; mobile enters through `run()` directly.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    health_app_lib::run()
}
