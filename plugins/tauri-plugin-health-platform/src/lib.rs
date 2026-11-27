//! Native platform services for the mobile shell, one plugin for all of them (key store and share sheet now; backup exclusion,
//! biometrics and HEIC later). Rust-only on purpose: there are no JS commands, so web code (including a
//! hot-updated UI bundle) can never read a key.
//!
//! Mobile: `app.health_platform().key_load(id)` etc. These block on the native side: never call them on the UI
//! thread. Desktop: the plugin registers nothing; it compiles there only so `cargo build --workspace` works.

use tauri::Runtime;
use tauri::plugin::{Builder, TauriPlugin};

#[cfg(mobile)]
mod mobile;
#[cfg(mobile)]
pub use mobile::NativePlatform;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("health-platform")
        .setup(|app, api| {
            #[cfg(mobile)]
            tauri::Manager::manage(app, mobile::register(api)?);
            #[cfg(desktop)]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg(mobile)]
pub trait HealthPlatformExt<R: Runtime> {
    fn health_platform(&self) -> &NativePlatform<R>;
}

#[cfg(mobile)]
impl<R: Runtime, T: tauri::Manager<R>> HealthPlatformExt<R> for T {
    fn health_platform(&self) -> &NativePlatform<R> {
        self.state::<NativePlatform<R>>().inner()
    }
}
