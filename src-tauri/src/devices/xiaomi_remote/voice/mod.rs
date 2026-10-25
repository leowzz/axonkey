#[cfg(any(target_os = "windows", target_os = "macos", test))]
mod atvv;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
pub use windows::AudioService;
#[cfg(target_os = "macos")]
pub use macos::AudioService;
