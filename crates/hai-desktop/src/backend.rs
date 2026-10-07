//! Compile-time backend selection.
//!
//! A default/release build uses hai-core's real `Backend`. A `--features mock`
//! build swaps in hai-core's `BackendMock` (compiled only under that feature).
//! This is the single place the choice is made; the rest of the app refers to
//! `Backend`.

#[cfg(not(feature = "mock"))]
pub use hai_core::Backend;

#[cfg(feature = "mock")]
pub use hai_core::BackendMock as Backend;

// The mock reports a successful flash without writing anything. A Cargo
// feature is independent of the build profile, so refuse the combination
// instead of trusting every release workflow to leave the flag off.
#[cfg(all(feature = "mock", not(debug_assertions)))]
compile_error!("the mock backend must not be used in release builds");
