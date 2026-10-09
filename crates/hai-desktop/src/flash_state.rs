//! Process-wide ownership of the active flash, including its blocking disk writer.

use crate::command_error::CommandError;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const ALREADY_FLASHING: &str =
    "A flash is already in progress. Wait for it to finish before starting another installation.";

#[derive(Default)]
pub(crate) struct FlashState {
    active: Arc<AtomicBool>,
}

struct FlashGuard(Arc<AtomicBool>);

impl Drop for FlashGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl FlashState {
    pub(crate) async fn run<F, T>(&self, operation: F) -> Result<T, CommandError>
    where
        F: Future<Output = Result<T, CommandError>> + Send + 'static,
        T: Send + 'static,
    {
        self.active
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| CommandError::new("operation_in_progress", ALREADY_FLASHING, false))?;
        let guard = FlashGuard(Arc::clone(&self.active));

        // Dropping the IPC waiter only detaches this task. It must finish awaiting
        // write_image (and its spawn_blocking worker) before releasing the guard.
        tauri::async_runtime::spawn(async move {
            let _guard = guard;
            operation.await
        })
        .await
        .map_err(|_| CommandError::new("internal", "The installation task stopped unexpectedly. Check the drive before starting again.", false))?
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
        assert_eq!(state.run(async { Ok(42) }).await.unwrap(), 42);
        assert_eq!(
            state
                .run(async { Err::<(), _>(CommandError::new("io", "write failed", false)) })
                .await,
            Err(CommandError::new("io", "write failed", false))
        );
        state.run(async { Ok(()) }).await.unwrap();
    }

    #[tokio::test]
    async fn rejects_second_operation_before_it_starts() {
        let state = Arc::new(FlashState::default());
        let (started_tx, started_rx) = oneshot::channel();
        let (finish_tx, finish_rx) = oneshot::channel();
        let first_state = Arc::clone(&state);
        let first = tokio::spawn(async move {
            first_state
                .run(async move {
                    started_tx.send(()).unwrap();
                    finish_rx.await.unwrap();
                    Ok(())
                })
                .await
        });
        started_rx.await.unwrap();
        assert_eq!(
            state
                .run(async {
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
        state.run(async { Ok(()) }).await.unwrap();
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
                    .run(async move {
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
                state.run(async { Ok(()) }).await,
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
            state.run(async { Ok(()) }).await.unwrap();
        }
    }
}
