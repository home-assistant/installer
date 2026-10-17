import { localize, localizeContent } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { ViewAccessibility } from "../../utils/view-accessibility.js";
import { formatBytes, getHaosRelease } from "../../api/index.js";
import { wizardState } from "../../state/wizard-state.js";
import { isoTargetPath } from "./live-usb-paths.js";
import { liveUsbStyles } from "./live-usb-styles.js";

/** What is about to happen, before anything is downloaded or written. */
@customElement("live-usb-summary-view")
export class LiveUsbSummaryView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    liveUsbStyles,
    css`
      dl {
        margin: 0;
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 0.5rem 1rem;
      }
      dt {
        color: var(--ha-secondary-text-color, #727272);
      }
      dd {
        margin: 0;
        color: var(--ha-text-color, #212121);
        overflow-wrap: anywhere;
      }
    `,
  ];

  @state()
  private _version: string | null = null;

  @state()
  private _versionUnknown = false;

  connectedCallback() {
    super.connectedCallback();
    void this._loadVersion();
  }

  private async _loadVersion() {
    try {
      const release = await getHaosRelease(undefined, "generic-x86-64");
      if (this.isConnected) this._version = release.version;
    } catch {
      if (this.isConnected) this._versionUnknown = true;
    }
  }

  render() {
    const selections = wizardState.getState().selections;
    const usb = selections.liveMedia !== "iso";
    const version =
      this._version ??
      (this._versionUnknown
        ? localize("common.version_unknown")
        : localize("common.loading"));
    const stick = [
      selections.driveName || localize("common.unknown_drive"),
      selections.driveSize ? `(${formatBytes(selections.driveSize)})` : "",
    ]
      .filter(Boolean)
      .join(" ");

    return html`
      <h2>${localize("views.live_usb.summary_view.ready_to_create")}</h2>
      <p class="subtitle">
        ${usb
          ? localize("views.live_usb.summary_view.what_happens_usb")
          : localize("views.live_usb.summary_view.what_happens_iso")}
      </p>
      <div class="card">
        <dl>
          <dt>${localize("views.live_usb.summary_view.home_assistant_os")}</dt>
          <dd>${version}</dd>
          ${usb
            ? html`<dt>${localize("views.live_usb.summary_view.usb_stick")}</dt>
                <dd>${stick}</dd>`
            : html`<dt>${localize("views.live_usb.summary_view.save_as")}</dt>
                <dd>
                  ${isoTargetPath(
                    selections.liveIsoFolder ?? "",
                    selections.liveIsoName ?? ""
                  )}
                  ${selections.liveIsoOverwrite
                    ? html`<br />${localize(
                          "views.live_usb.summary_view.replaces_existing"
                        )}`
                    : ""}
                </dd>`}
        </dl>
        ${usb
          ? html`<div class="notice">
              ${localizeContent("views.live_usb.summary_view.erase_warning", {
                stick: html`<strong>${stick}</strong>`,
              })}
            </div>`
          : ""}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "live-usb-summary-view": LiveUsbSummaryView;
  }
}
