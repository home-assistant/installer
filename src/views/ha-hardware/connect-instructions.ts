import { localize, localizeContent } from "../../localization/localize.js";
import { LitElement, html, css, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { renderExternalLink } from "../../utils/external-link.js";
import { linkStyles } from "../../utils/link-styles.js";
import { getPlatform } from "../../utils/platform.js";
import { RPIBOOT_URL } from "../../utils/urls.js";
import type { HaHardwareId } from "../../state/ha-hardware.js";

/**
 * How to make the storage of a Nabu Casa device show up as a drive on this
 * computer, shown above the drive list.
 */
@customElement("ha-hardware-connect-instructions")
export class HaHardwareConnectInstructions extends LitElement {
  static styles = [
    linkStyles,
    css`
      :host {
        display: block;
        width: 100%;
        max-width: 500px;
        margin-bottom: 1.5rem;
      }

      .instructions {
        padding: 1rem 1.25rem;
        background-color: var(--ha-card-background);
        border: 1px solid var(--ha-border-color);
        border-radius: var(--ha-card-border-radius);
        font-size: 0.875rem;
        line-height: 1.5;
        color: var(--ha-text-color);
      }

      h3 {
        font-size: 1rem;
        font-weight: 500;
        margin: 0 0 0.5rem 0;
      }

      h4 {
        font-size: 0.875rem;
        font-weight: 500;
        margin: 0.75rem 0 0.25rem 0;
      }

      p {
        margin: 0;
      }

      ol {
        margin: 0;
        padding-inline-start: 1.25rem;
      }

      li + li {
        margin-top: 0.25rem;
      }

      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.8125rem;
        overflow-wrap: anywhere;
      }
    `,
  ];

  @property({ attribute: false })
  hardware?: HaHardwareId;

  render(): TemplateResult | typeof nothing {
    switch (this.hardware) {
      case "green":
        return this._renderBox(
          localize("views.ha_hardware.connect_instructions.green_title"),
          html`<p>
            ${localize("views.ha_hardware.connect_instructions.green_insert")}
          </p>`
        );
      case "yellow-cm4":
        return this._renderBox(
          localize("views.ha_hardware.connect_instructions.yellow_cm4_title"),
          html`<p>
            ${localize(
              "views.ha_hardware.connect_instructions.yellow_cm4_insert"
            )}
          </p>`
        );
      case "yellow-cm5":
        return this._renderBox(
          localize("views.ha_hardware.connect_instructions.yellow_cm5_title"),
          this._renderYellowCm5()
        );
      case "blue":
        return this._renderBox(
          localize("views.ha_hardware.connect_instructions.blue_title"),
          this._renderBlue()
        );
      // Listing every device makes a new one fail the build until it has steps
      case undefined:
        return nothing;
    }
  }

  private _renderBox(title: string, content: TemplateResult) {
    return html`
      <section class="instructions" aria-label=${title}>
        <h3>${title}</h3>
        ${content}
      </section>
    `;
  }

  private _renderYellowCm5() {
    const [rpiboot, drivePrompt] = this._yellowCm5PlatformSteps();
    return html`
      <ol>
        <li>
          ${localize(
            "views.ha_hardware.connect_instructions.yellow_cm5_open_case"
          )}
        </li>
        <li>
          ${localize("views.ha_hardware.connect_instructions.yellow_cm5_jp1")}
        </li>
        <li>
          ${localize("views.ha_hardware.connect_instructions.yellow_cm5_usb")}
        </li>
        <li>
          ${localize(
            "views.ha_hardware.connect_instructions.yellow_cm5_recovery"
          )}
        </li>
        <li>${rpiboot}</li>
        <li>
          ${localizeContent(
            "views.ha_hardware.connect_instructions.yellow_cm5_drive",
            { driveName: html`<code>RPi-MSD</code>` }
          )}
          ${drivePrompt}
        </li>
      </ol>
    `;
  }

  // How to run rpiboot, and what the OS asks when the drive shows up.
  private _yellowCm5PlatformSteps() {
    const rpiboot = renderExternalLink(RPIBOOT_URL, "rpiboot");
    const command = html`<code>sudo ./rpiboot -d mass-storage-gadget64</code>`;
    const shortcut = html`<code>rpiboot-CM4-CM5 - Mass Storage Gadget</code>`;
    switch (getPlatform()) {
      case "macos":
        return [
          localizeContent(
            "views.ha_hardware.connect_instructions.yellow_cm5_rpiboot_macos",
            { rpiboot, command }
          ),
          localize(
            "views.ha_hardware.connect_instructions.yellow_cm5_drive_prompt_macos"
          ),
        ];
      case "windows":
        return [
          localizeContent(
            "views.ha_hardware.connect_instructions.yellow_cm5_rpiboot_windows",
            { rpiboot, shortcut }
          ),
          localize(
            "views.ha_hardware.connect_instructions.yellow_cm5_drive_prompt_windows"
          ),
        ];
      default:
        return [
          localizeContent(
            "views.ha_hardware.connect_instructions.yellow_cm5_rpiboot_linux",
            { rpiboot, command }
          ),
          nothing,
        ];
    }
  }

  private _renderBlue() {
    return html`
      <h4>
        ${localize("views.ha_hardware.connect_instructions.blue_adapter_title")}
      </h4>
      <p>${localize("views.ha_hardware.connect_instructions.blue_adapter")}</p>
      <h4>
        ${localize(
          "views.ha_hardware.connect_instructions.blue_petitboot_title"
        )}
      </h4>
      <ol>
        <li>
          ${localize("views.ha_hardware.connect_instructions.blue_open_case")}
        </li>
        <li>
          ${localize("views.ha_hardware.connect_instructions.blue_boot_mode")}
        </li>
        <li>
          ${localize("views.ha_hardware.connect_instructions.blue_connect")}
        </li>
        <li>
          ${localizeContent("views.ha_hardware.connect_instructions.blue_ums", {
            command: html`<code>ums /dev/mmcblk0</code>`,
          })}
        </li>
      </ol>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-hardware-connect-instructions": HaHardwareConnectInstructions;
  }
}
