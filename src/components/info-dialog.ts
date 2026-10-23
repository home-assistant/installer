import { localize } from "../localization/localize.js";
import { html } from "lit";
import { customElement, property } from "lit/decorators.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import { DialogBase } from "./dialog-base.js";

/**
 * Informational dialog built on DialogBase.
 *
 * Toggle `open`, set `heading` / `message` / `primaryLabel` / `secondaryLabel` /
 * `primaryVariant` / `emphasis`, and listen for `dialog-primary` /
 * `dialog-secondary`.
 * Escape, backdrop click, and the header close button all map to
 * `dialog-secondary` (dismiss).
 */
@customElement("info-dialog")
export class InfoDialog extends DialogBase {
  @property({ type: String })
  heading = "";

  @property({ type: String })
  message = "";

  @property({ type: String, attribute: "primary-label" })
  primaryLabel = localize("components.info_dialog.ok");

  @property({ type: String, attribute: "secondary-label" })
  secondaryLabel = "";

  /**
   * "danger" when the primary button does something that can't be undone.
   * The title then warns, as the erase dialog's does.
   */
  @property({ type: String, attribute: "primary-variant" })
  primaryVariant: "brand" | "danger" = "brand";

  /**
   * Which button stands out. "secondary" when most people should not take the
   * primary action. Dismissing still means secondary either way.
   */
  @property({ type: String })
  emphasis: "primary" | "secondary" = "primary";

  protected readonly dismissEvent = "dialog-secondary";

  protected renderContent() {
    const secondaryStandsOut = this.emphasis === "secondary";

    return html`
      ${this.renderTitle(
        this.heading,
        this.primaryVariant === "danger" ? "warning" : "info"
      )}

      <p class="dialog-message">${this.message}</p>
      <slot></slot>

      ${this.secondaryLabel
        ? html`
            <wa-button
              slot="footer"
              variant=${secondaryStandsOut ? "brand" : "neutral"}
              appearance=${secondaryStandsOut ? "accent" : "outlined"}
              @click=${this._onSecondary}
            >
              ${this.secondaryLabel}
            </wa-button>
          `
        : ""}
      <wa-button
        slot="footer"
        variant=${secondaryStandsOut ? "neutral" : this.primaryVariant}
        appearance=${secondaryStandsOut ? "outlined" : "accent"}
        @click=${this._onPrimary}
      >
        ${this.primaryLabel}
      </wa-button>
    `;
  }

  private _onSecondary() {
    this.choose("dialog-secondary");
  }

  private _onPrimary() {
    this.choose("dialog-primary");
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "info-dialog": InfoDialog;
  }
}
