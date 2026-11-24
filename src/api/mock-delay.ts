/**
 * Waits `ms` in a browser mock, which takes about as long as the real
 * operation so the dev server shows each stage. The E2E tests multiply every
 * wait by `hai:mock-delay-scale` to go through the flows faster.
 */
export function mockDelay(ms: number): Promise<void> {
  const scale = Number(sessionStorage.getItem("hai:mock-delay-scale") ?? 1);
  return new Promise((resolve) => setTimeout(resolve, ms * scale));
}
