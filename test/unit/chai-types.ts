import "@open-wc/testing";
import type { DiffOptions } from "@open-wc/semantic-dom-diff/get-diffable-html.js";

// Use a .ts file so this correction is checked even with skipLibCheck.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Chai uses a global namespace.
  namespace Chai {
    // semantic-dom-diff declares these overloads as promises, but equal is
    // synchronous. Keep real async assertions, such as accessible, checked.
    interface Equal {
      (value: unknown, message?: string, options?: DiffOptions): Chai.Assertion;
      (value: unknown, options?: DiffOptions): Chai.Assertion;
    }
  }
}
