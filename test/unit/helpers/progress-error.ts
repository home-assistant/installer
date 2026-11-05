/** Whether a progress view shows that its install failed. */
export function showsError(view: Element): boolean {
  return !!view.shadowRoot!.querySelector("install-progress")!.error;
}
