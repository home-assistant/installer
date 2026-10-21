import { localize, localizeContent } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { wizardState, type WizardState } from "../../state/wizard-state.js";
import { proxmoxVmConfig } from "../../state/vm-defaults.js";
import { openExternalLink } from "../../utils/external-url.js";

import "../../components/install-success.js";

const DIRECTORY_STORAGE_DOCS =
  "https://pve.proxmox.com/pve-docs/pve-admin-guide.html#storage_directory";

@customElement("proxmox-success-view")
export class ProxmoxSuccessView extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100%;
    }

    .import-reminder {
      width: 100%;
      box-sizing: border-box;
      max-width: 500px;
      margin: 0 auto 2rem;
      padding: 0.75rem 0 0.75rem 1rem;
      border-left: 3px solid var(--ha-warning-color, #f5a623);
      text-align: left;
      font-size: 0.875rem;
      line-height: 1.5;
      color: var(--ha-text-color, #212121);
      overflow-wrap: anywhere;
    }

    .import-reminder p {
      margin: 0;
    }

    .import-reminder p + p {
      margin-top: 0.5rem;
    }

    .import-reminder a {
      color: var(--ha-primary-color, #03a9f4);
    }
  `;

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
        .subtitle=${localize(
          "views.proxmox.proxmox_success_view.home_assistant_is_now_running_on_proxmox_as_value_vm_value_on_node_value",
          { value0: name, value1: vm_id, value2: node }
        )}
        .steps=${[
          localize(
            "views.proxmox.proxmox_success_view.wait_a_few_minutes_for_home_assistant_to_complete_its_initial_setup"
          ),
          html`${localizeContent(
            "views.proxmox.proxmox_success_view.open_value_in_your_browser",
            {
              value0: html`<a
                href=${haUrl}
                target="_blank"
                rel="noopener noreferrer"
                @click=${openExternalLink}
              >
                ${displayUrl}
              </a>`,
            }
          )}`,
          localize(
            "views.proxmox.proxmox_success_view.create_your_user_account_and_start_automating"
          ),
        ]}
        .tip=${html`${localizeContent(
          "views.proxmox.proxmox_success_view.value_you_can_manage_your_home_assistant_virtual_machine_anytime_from_the_p",
          {
            value0: html`<strong
              >${localize("views.proxmox.proxmox_success_view.tip")}</strong
            >`,
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

    return html`<section
      class="import-reminder"
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
    </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "proxmox-success-view": ProxmoxSuccessView;
  }
}
