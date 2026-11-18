//! Shared logic for the cc-slaves app shell and the menu-bar process (spec §7.1).
//! Everything that touches the OS goes through a small trait so unit tests never touch launchd, Keychain or the real home.
pub mod client;
pub mod engine_info;
pub mod i18n;
pub mod keychain;
pub mod launchd;
pub mod paths;
pub mod status;
