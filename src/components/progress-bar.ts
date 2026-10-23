import { LitElement, html, css, type PropertyValues } from "lit";
import { localize } from "../localization/localize.js";
import { customElement, property, query } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import type WaProgressBar from "@home-assistant/webawesome/dist/components/progress-bar/progress-bar.js";
import "@home-assistant/webawesome/dist/components/progress-bar/progress-bar.js";

/**
 * `<wa-progress-bar>` in the app's colors, as `install-progress` shows it for
 * every install. It adds what Web Awesome leaves out: a rule for reduced
 * motion, no slide back when a stage counts from 0 again, and no 0% read out
 * while a wait has no value.
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

  @property({ type: String })
  label = "";

  @query("wa-progress-bar")
  private _bar!: WaProgressBar;

  /** Counts the bars drawn, as a new one has no width to slide from */
  private _run = 0;

  protected willUpdate(changed: PropertyValues<this>) {
    // Web Awesome slides the indicator to each new value. A stage that counts
    // from 0 again would slide back across the whole track while its label
    // counts up, and a wait that starts or ends would slide between the value
    // and the stripe it shows. A new bar shows its value at once
    const previous = changed.get("progress");
    if (
      changed.get("indeterminate") !== undefined ||
      (!this.indeterminate &&
        previous !== undefined &&
        this.progress < previous)
    ) {
      this._run++;
    }
  }

  render() {
    const value = Math.min(100, Math.max(0, this.progress));

    return keyed(
      this._run,
      html`
        <wa-progress-bar
          ?indeterminate=${this.indeterminate}
          value=${value}
          label=${this.label || localize("common.progress")}
        ></wa-progress-bar>
      `
    );
  }

  protected updated() {
    // Web Awesome sets aria-valuenow="0" on an indeterminate bar, so screen
    // readers announce 0% through a stage that has no value. ARIA leaves it
    // off instead. Its template binds the string "0" while indeterminate and
    // the number after, so Lit writes it again as soon as the bar is
    // determinate, even at 0.
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
