import { localize, localizeContent } from "../../localization/localize.js";
import { LitElement, html, css, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { openExternalLink } from "../../utils/external-url.js";
import type { HaHardwareId } from "./hardware.js";

const RPIBOOT_URL = "https://github.com/raspberrypi/usbboot";

/**
 * How to make the storage of a Nabu Casa device show up as a drive on this
 * computer, shown above the drive list.
 */
@customElement("ha-hardware-connect-instructions")
export class HaHardwareConnectInstructions extends LitElement {
  static styles = css`
    :host {
      display: block;
      width: 100%;
      max-width: 500px;
      margin-bottom: 1.5rem;
    }

    .instructions {
      padding: 1rem 1.25rem;
      background-color: var(--ha-card-background, #ffffff);
      border: 1px solid var(--ha-border-color, #e0e0e0);
      border-radius: 8px;
      font-size: 0.875rem;
      line-height: 1.5;
      color: var(--ha-text-color, #212121);
    }

    @media (prefers-color-scheme: dark) {
      .instructions {
        background-color: var(--ha-card-background, #1e1e1e);
        border-color: var(--ha-border-color, #333333);
      }
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
      padding-left: 1.25rem;
    }

    li + li {
      margin-top: 0.25rem;
    }

    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.8125rem;
      overflow-wrap: anywhere;
    }

    a {
      color: var(--ha-primary-color, #03a9f4);
      font-weight: 500;
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }
  `;

  @property({ attribute: false })
  hardware?: HaHardwareId;

  render() {
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
      default:
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
        <li>
          ${localizeContent(
            "views.ha_hardware.connect_instructions.yellow_cm5_rpiboot",
            {
              rpiboot: html`<a
                href=${RPIBOOT_URL}
                target="_blank"
                rel="noopener noreferrer"
                @click=${(event: Event) => openExternalLink(event, RPIBOOT_URL)}
                >${"rpiboot"}</a
              >`,
              command: html`<code
                >${"sudo ./rpiboot -d mass-storage-gadget64"}</code
              >`,
              windowsCommand: html`<code
                >${"rpiboot-CM4-CM5 - Mass Storage Gadget"}</code
              >`,
            }
          )}
        </li>
        <li>
          ${localizeContent(
            "views.ha_hardware.connect_instructions.yellow_cm5_drive",
            { driveName: html`<code>${"RPi-MSD"}</code>` }
          )}
        </li>
      </ol>
    `;
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
            command: html`<code>${"ums /dev/mmcblk0"}</code>`,
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
