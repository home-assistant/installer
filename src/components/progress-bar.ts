import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import "@home-assistant/webawesome/dist/components/progress-bar/progress-bar.js";

/**
 * Thin wrapper over `<wa-progress-bar>`.
 *
 * Kept as its own element so the three progress views (and the e2e selectors
 * that target them) stay unchanged, while the bar itself gets Web Awesome's
 * `role="progressbar"` and aria-value handling instead of two bare divs.
 */
@customElement("progress-bar")
export class ProgressBar extends LitElement {
  static styles = css`
    :host {
      display: block;
      width: 100%;
    }

    wa-progress-bar {
      --track-height: 8px;
      --indicator-color: var(--ha-primary-color, #03a9f4);
      --track-color: var(--ha-border-color, #e0e0e0);
    }

    @media (prefers-color-scheme: dark) {
      wa-progress-bar {
        --track-color: var(--ha-border-color, #333333);
      }
    }

    wa-progress-bar.error {
      --indicator-color: var(--ha-error-color, #db4437);
    }
  `;

  @property({ type: Number })
  progress = 0;

  @property({ type: Boolean })
  indeterminate = false;

  @property({ type: Boolean })
  error = false;

  @property({ type: String })
  label = "";

  render() {
    const value = Math.min(100, Math.max(0, this.progress));

    return html`
      <wa-progress-bar
        class=${this.error ? "error" : ""}
        ?indeterminate=${this.indeterminate}
        value=${value}
        label=${this.label || "Progress"}
      ></wa-progress-bar>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "progress-bar": ProgressBar;
  }
}
