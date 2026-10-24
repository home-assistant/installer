import { localize, localizeContent } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { ViewAccessibility } from "../../utils/view-accessibility.js";
import { getHaosRelease } from "../../api/index.js";
import { formatBytes } from "../../utils/format.js";
import type { WizardState } from "../../state/wizard-state.js";
import { WizardStateController } from "../../state/wizard-state-controller.js";
import { renderStepHeading } from "../../utils/step-styles.js";
import { isoTargetPath } from "./live-usb-paths.js";
import { liveUsbStyles } from "./live-usb-styles.js";
import "../../components/inline-notice.js";

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
        color: var(--ha-secondary-text-color);
      }
      dd {
        margin: 0;
        color: var(--ha-text-color);
        overflow-wrap: anywhere;
      }

      inline-notice {
        margin-top: 1.5rem;
      }
    `,
  ];

  private readonly _wizard = new WizardStateController(this);

  private get _wizardState(): WizardState {
    return this._wizard.state;
  }

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
    const { selections } = this._wizardState;
    const usb = selections.liveMedia !== "iso";
    const version =
      this._version ??
      (this._versionUnknown
        ? localize("common.version_unknown")
        : localize("common.loading"));
    const driveName = selections.driveName || localize("common.unknown_drive");
    const stick = selections.driveSize
      ? localize("views.live_usb.live_usb_summary_view.drive_name_and_size", {
          name: driveName,
          size: formatBytes(selections.driveSize),
        })
      : driveName;

    return html`
      ${renderStepHeading(
        localize("views.live_usb.live_usb_summary_view.ready_to_create"),
        usb
          ? localize("views.live_usb.live_usb_summary_view.what_happens_usb")
          : localize("views.live_usb.live_usb_summary_view.what_happens_iso")
      )}
      <div class="card">
        <dl>
          <dt>
            ${localize(
              "views.live_usb.live_usb_summary_view.home_assistant_os"
            )}
          </dt>
          <dd>${version}</dd>
          ${usb
            ? html`<dt>
                  ${localize("views.live_usb.live_usb_summary_view.usb_stick")}
                </dt>
                <dd>${stick}</dd>`
            : html`<dt>
                  ${localize("views.live_usb.live_usb_summary_view.save_as")}
                </dt>
                <dd>
                  <bdi dir="ltr"
                    >${isoTargetPath(
                      selections.liveIsoFolder ?? "",
                      selections.liveIsoName ?? ""
                    )}</bdi
                  >
                  ${selections.liveIsoOverwrite
                    ? html`<br />${localize(
                          "views.live_usb.live_usb_summary_view.replaces_existing"
                        )}`
                    : ""}
                </dd>`}
        </dl>
      </div>
      ${usb
        ? html`<inline-notice>
            <p>
              ${localizeContent(
                "views.live_usb.live_usb_summary_view.erase_warning",
                {
                  stick: html`<strong>${stick}</strong>`,
                }
              )}
            </p>
          </inline-notice>`
        : ""}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "live-usb-summary-view": LiveUsbSummaryView;
  }
}
