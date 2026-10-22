import { LitElement, html, css } from "lit";
import { localize } from "../localization/localize.js";
import { customElement, property, query } from "lit/decorators.js";
import type WaProgressBar from "@home-assistant/webawesome/dist/components/progress-bar/progress-bar.js";
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

    wa-progress-bar.error {
      --indicator-color: var(--ha-error-color, #db4437);
    }

    /* Web Awesome has no reduced-motion rule of its own */
    @media (prefers-reduced-motion: reduce) {
      wa-progress-bar::part(indicator) {
        transition: none;
      }

      /* Waits can run for an hour, so nothing slides. A striped full track
         still reads as busy; the half-width indicator left standing would
         read as 50% */
      wa-progress-bar[indeterminate]::part(indicator) {
        animation: none;
        inset-inline-start: 0;
        inline-size: 100%;
        background-image: repeating-linear-gradient(
          -45deg,
          transparent 0 4px,
          var(--track-color) 4px 8px
        );
      }
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

  @query("wa-progress-bar")
  private _bar!: WaProgressBar;

  render() {
    const value = Math.min(100, Math.max(0, this.progress));

    return html`
      <wa-progress-bar
        class=${this.error ? "error" : ""}
        ?indeterminate=${this.indeterminate}
        value=${value}
        label=${this.label || localize("common.progress")}
      ></wa-progress-bar>
    `;
  }

  protected updated() {
    // Web Awesome sets aria-valuenow="0" on an indeterminate bar, so screen
    // readers announce 0% through a stage that has no value. ARIA leaves it
    // off instead. Its template only writes it again for a new value, which
    // is once the bar is determinate again.
    void this._bar.updateComplete.then(() => {
      if (this.indeterminate) {
        this._bar
          .shadowRoot!.querySelector('[role="progressbar"]')
          ?.removeAttribute("aria-valuenow");
      }
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "progress-bar": ProgressBar;
  }
}
