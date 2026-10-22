import { localize, localizeContent } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import { proxmoxVmConfig } from "../../state/vm-defaults.js";
import { openExternalLink } from "../../utils/external-url.js";
import { linkStyles } from "../../utils/link-styles.js";

import "../../components/inline-notice.js";
import "../../components/install-success.js";

const DIRECTORY_STORAGE_DOCS =
  "https://pve.proxmox.com/pve-docs/pve-admin-guide.html#storage_directory";

@customElement("proxmox-success-view")
export class ProxmoxSuccessView extends LitElement {
  static styles = [
    linkStyles,
    css`
      :host {
        display: block;
        min-height: 100%;
      }

      .import-reminder {
        margin: 0 auto 2rem;
      }
    `,
  ];

  @state()
  private _wizardState: WizardState = wizardState.getState();

  private _unsubscribe?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._unsubscribe = wizardState.subscribe((state) => {
      this._wizardState = state;
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
  }

  render() {
    const selections = this._wizardState.selections;
    const { name, vm_id, node } = proxmoxVmConfig(selections);
    const ipAddress = selections.ipAddress;
    const haUrl = ipAddress
      ? `http://${ipAddress}`
      : "http://homeassistant.local";
    const displayUrl = ipAddress || "homeassistant.local";

    return html`
      <install-success
        .subtitle=${localize("views.proxmox.proxmox_success_view.subtitle", {
          name,
          id: vm_id,
          node,
        })}
        .steps=${[
          localize("common.vm.step_wait"),
          html`${localizeContent("common.vm.step_open", {
            url: html`<a
              href=${haUrl}
              target="_blank"
              rel="noopener noreferrer"
              @click=${openExternalLink}
              >${displayUrl}</a
            >`,
          })}`,
          localize("common.vm.step_onboard"),
        ]}
        .tip=${html`${localizeContent(
          "views.proxmox.proxmox_success_view.manage_tip",
          {
            tip_prefix: html`<strong>${localize("common.vm.tip")}</strong>`,
          }
        )}`}
        >${this._renderImportReminder()}</install-success
      >
    `;
  }

  /**
   * Remind the user of Import this installer enabled on the server it is
   * connected to. The installer never rolls it back: other workloads on the
   * cluster may rely on it by now.
   */
  private _renderImportReminder() {
    const selections = this._wizardState.selections;
    if (!selections.proxmoxSession) return "";

    const serverOrigin = new URL(selections.proxmoxSession.server_url).origin;
    const storages = (selections.proxmoxImportChanges ?? [])
      .filter((change) => change.serverOrigin === serverOrigin)
      .map((change) => change.storage);
    if (!storages.length) return "";

    return html`<inline-notice
      class="import-reminder"
      role="region"
      aria-label=${localize(
        "views.proxmox.proxmox_success_view.import_storage_reminder"
      )}
    >
      <p>
        ${localizeContent(
          "views.proxmox.proxmox_success_view.installer_enabled_import_on_storages",
          {
            storages: storages.map(
              (storage, index) =>
                html`${index ? ", " : ""}<strong>"${storage}"</strong>`
            ),
          }
        )}
      </p>
      <p>
        ${localize(
          "views.proxmox.proxmox_success_view.review_import_in_proxmox"
        )}
        <a
          href=${DIRECTORY_STORAGE_DOCS}
          target="_blank"
          rel="noopener noreferrer"
          @click=${openExternalLink}
          >${localize("proxmox.directory_storage_documentation")}</a
        >
      </p>
    </inline-notice>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "proxmox-success-view": ProxmoxSuccessView;
  }
}
