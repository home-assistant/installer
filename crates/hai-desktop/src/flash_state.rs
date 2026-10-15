//! Process-wide ownership of the active flash, including its blocking disk writer.

use crate::command_error::CommandError;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const ALREADY_FLASHING: &str =
    "A flash is already in progress. Wait for it to finish before starting another installation.";

/// The running flash's attempt, as the frontend named it, and its cancel flag.
type RunningAttempt = Arc<Mutex<Option<(String, Arc<AtomicBool>)>>>;

#[derive(Default)]
pub(crate) struct FlashState {
    active: Arc<AtomicBool>,
    /// A cancel names its attempt, so one that arrives late can never stop
    /// a retry.
    running: RunningAttempt,
}

struct FlashGuard {
    active: Arc<AtomicBool>,
    running: RunningAttempt,
}

impl Drop for FlashGuard {
    fn drop(&mut self) {
        *self.running.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.active.store(false, Ordering::Release);
    }
}

impl FlashState {
    /// Run `operation` as the one active flash. It receives the flag that
    /// `cancel` sets for this `attempt`.
    pub(crate) async fn run<O, F, T>(
        &self,
        attempt: String,
        operation: O,
    ) -> Result<T, CommandError>
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
            running: Arc::clone(&self.running),
        };

        let cancelled = Arc::new(AtomicBool::new(false));
        *self.running.lock().unwrap_or_else(|e| e.into_inner()) =
            Some((attempt, Arc::clone(&cancelled)));
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

    /// Ask `attempt` to stop. It stops at its next progress update and then
    /// fails with `cancelled`. When that attempt is not running (anymore),
    /// this does nothing.
    pub(crate) fn cancel(&self, attempt: &str) {
        let running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((running_attempt, cancelled)) = &*running {
            if running_attempt == attempt {
                cancelled.store(true, Ordering::Release);
            }
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
        assert_eq!(
            state.run("a".into(), |_| async { Ok(42) }).await.unwrap(),
            42
        );
        assert_eq!(
            state
                .run("a".into(), |_| async {
                    Err::<(), _>(CommandError::new("io", "write failed", false))
                })
                .await,
            Err(CommandError::new("io", "write failed", false))
        );
        state.run("a".into(), |_| async { Ok(()) }).await.unwrap();
    }

    #[tokio::test]
    async fn cancel_reaches_only_its_own_attempt() {
        let state = Arc::new(FlashState::default());

        // Nothing runs: a cancel now must not leak into the next flash.
        state.cancel("first");
        let flag = state
            .run("first".into(), |cancelled| async move { Ok(cancelled) })
            .await
            .unwrap();
        assert!(!flag.load(Ordering::Acquire));

        let (started_tx, started_rx) = oneshot::channel();
        let (checked_tx, checked_rx) = oneshot::channel::<()>();
        let running_state = Arc::clone(&state);
        let retry = tokio::spawn(async move {
            running_state
                .run("retry".into(), |cancelled| async move {
                    started_tx.send(Arc::clone(&cancelled)).unwrap();
                    checked_rx.await.unwrap();
                    while !cancelled.load(Ordering::Acquire) {
                        tokio::task::yield_now().await;
                    }
                    Err::<(), _>(CommandError::new("cancelled", "stopped", true))
                })
                .await
        });
        let cancelled = started_rx.await.unwrap();

        // The first attempt's cancel arrives late, while the retry runs
        state.cancel("first");
        assert!(!cancelled.load(Ordering::Acquire));
        checked_tx.send(()).unwrap();

        state.cancel("retry");
        assert_eq!(retry.await.unwrap().unwrap_err().code, "cancelled");
    }

    #[tokio::test]
    async fn rejects_second_operation_before_it_starts() {
        let state = Arc::new(FlashState::default());
        let (started_tx, started_rx) = oneshot::channel();
        let (finish_tx, finish_rx) = oneshot::channel();
        let first_state = Arc::clone(&state);
        let first = tokio::spawn(async move {
            first_state
                .run("a".into(), |_| async move {
                    started_tx.send(()).unwrap();
                    finish_rx.await.unwrap();
                    Ok(())
                })
                .await
        });
        started_rx.await.unwrap();
        assert_eq!(
            state
                .run("a".into(), |_| async {
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
        state.run("a".into(), |_| async { Ok(()) }).await.unwrap();
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
                    .run("a".into(), |_| async move {
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
                state.run("a".into(), |_| async { Ok(()) }).await,
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
            state.run("a".into(), |_| async { Ok(()) }).await.unwrap();
        }
    }
}
