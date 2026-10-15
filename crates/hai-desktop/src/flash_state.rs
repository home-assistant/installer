//! Process-wide ownership of the active flash, including its blocking disk writer.

use crate::command_error::CommandError;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const ALREADY_FLASHING: &str =
    "A flash is already in progress. Wait for it to finish before starting another installation.";

#[derive(Default)]
pub(crate) struct FlashState {
    active: Arc<AtomicBool>,
    /// The running flash's cancel flag. Each flash gets a fresh one, so a
    /// late cancel can never stop the next flash.
    cancel: Arc<Mutex<Option<Arc<AtomicBool>>>>,
}

struct FlashGuard {
    active: Arc<AtomicBool>,
    cancel: Arc<Mutex<Option<Arc<AtomicBool>>>>,
}

impl Drop for FlashGuard {
    fn drop(&mut self) {
        *self.cancel.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.active.store(false, Ordering::Release);
    }
}

impl FlashState {
    /// Run `operation` as the one active flash. It receives the flag that
    /// `cancel` sets.
    pub(crate) async fn run<O, F, T>(&self, operation: O) -> Result<T, CommandError>
    where
        O: FnOnce(Arc<AtomicBool>) -> F,
        F: Future<Output = Result<T, CommandError>> + Send + 'static,
        T: Send + 'static,
    {
        self.active
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| CommandError::new("operation_in_progress", ALREADY_FLASHING, false))?;
        let guard = FlashGuard {
            active: Arc::clone(&self.active),
            cancel: Arc::clone(&self.cancel),
        };

        let cancelled = Arc::new(AtomicBool::new(false));
        *self.cancel.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::clone(&cancelled));
        let operation = operation(cancelled);

        // Dropping the IPC waiter only detaches this task. It must finish awaiting
        // write_image (and its spawn_blocking worker) before releasing the guard.
        tauri::async_runtime::spawn(async move {
            let _guard = guard;
            operation.await
        })
        .await
        .map_err(|_| CommandError::new("internal", "The installation task stopped unexpectedly. Check the drive before starting again.", false))?
    }

    /// Ask the running flash to stop. It stops at its next progress update
    /// and then fails with `cancelled`. Without a running flash this does
    /// nothing.
    pub(crate) fn cancel(&self) {
        if let Some(cancelled) = &*self.cancel.lock().unwrap_or_else(|e| e.into_inner()) {
            cancelled.store(true, Ordering::Release);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn releases_after_success_and_error() {
        let state = FlashState::default();
        assert_eq!(state.run(|_| async { Ok(42) }).await.unwrap(), 42);
        assert_eq!(
            state
                .run(|_| async { Err::<(), _>(CommandError::new("io", "write failed", false)) })
                .await,
            Err(CommandError::new("io", "write failed", false))
        );
        state.run(|_| async { Ok(()) }).await.unwrap();
    }

    #[tokio::test]
    async fn cancel_reaches_only_the_running_flash() {
        let state = Arc::new(FlashState::default());

        // Nothing runs: a cancel now must not leak into the next flash.
        state.cancel();
        let flag = state
            .run(|cancelled| async move { Ok(cancelled) })
            .await
            .unwrap();
        assert!(!flag.load(Ordering::Acquire));

        let (started_tx, started_rx) = oneshot::channel();
        let running_state = Arc::clone(&state);
        let running = tokio::spawn(async move {
            running_state
                .run(|cancelled| async move {
                    started_tx.send(()).unwrap();
                    while !cancelled.load(Ordering::Acquire) {
                        tokio::task::yield_now().await;
                    }
                    Err::<(), _>(CommandError::new("cancelled", "stopped", true))
                })
                .await
        });
        started_rx.await.unwrap();
        state.cancel();
        assert_eq!(running.await.unwrap().unwrap_err().code, "cancelled");

        let flag = state
            .run(|cancelled| async move { Ok(cancelled) })
            .await
            .unwrap();
        assert!(!flag.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn rejects_second_operation_before_it_starts() {
        let state = Arc::new(FlashState::default());
        let (started_tx, started_rx) = oneshot::channel();
        let (finish_tx, finish_rx) = oneshot::channel();
        let first_state = Arc::clone(&state);
        let first = tokio::spawn(async move {
            first_state
                .run(|_| async move {
                    started_tx.send(()).unwrap();
                    finish_rx.await.unwrap();
                    Ok(())
                })
                .await
        });
        started_rx.await.unwrap();
        assert_eq!(
            state
                .run(|_| async {
                    Err::<(), _>(CommandError::new(
                        "io",
                        "must not start a second download",
                        false,
                    ))
                })
                .await,
            Err(CommandError::new(
                "operation_in_progress",
                ALREADY_FLASHING,
                false
            ))
        );
        finish_tx.send(()).unwrap();
        first.await.unwrap().unwrap();
        state.run(|_| async { Ok(()) }).await.unwrap();
    }

    #[tokio::test]
    async fn aborted_waiter_keeps_blocking_writer_protected() {
        for writer_fails in [false, true] {
            let state = Arc::new(FlashState::default());
            let (started_tx, started_rx) = oneshot::channel();
            let (finish_tx, finish_rx) = mpsc::channel();
            let (completed_tx, completed_rx) = oneshot::channel();
            let first_state = Arc::clone(&state);
            let first = tokio::spawn(async move {
                first_state
                    .run(|_| async move {
                        // Like the platform writers, this worker continues even
                        // if its JoinHandle is dropped. No real disk is opened.
                        let result = tokio::task::spawn_blocking(move || {
                            started_tx.send(()).unwrap();
                            finish_rx.recv().unwrap();
                            if writer_fails {
                                Err(CommandError::new("io", "write failed", false))
                            } else {
                                Ok(())
                            }
                        })
                        .await
                        .unwrap();
                        completed_tx.send(()).unwrap();
                        result
                    })
                    .await
            });
            started_rx.await.unwrap();
            first.abort();
            assert!(first.await.unwrap_err().is_cancelled());
            assert_eq!(
                state.run(|_| async { Ok(()) }).await,
                Err(CommandError::new(
                    "operation_in_progress",
                    ALREADY_FLASHING,
                    false
                ))
            );

            finish_tx.send(()).unwrap();
            completed_rx.await.unwrap();
            // The completion signal precedes the guard's drop by one return.
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while state.active.load(Ordering::Acquire) {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            state.run(|_| async { Ok(()) }).await.unwrap();
        }
    }
}
