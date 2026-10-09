import { localize, localizeContent } from "../localization/localize.js";
import { LitElement, html, css } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../utils/view-accessibility.js";
import { customElement } from "lit/decorators.js";
import "../components/option-card.js";
import { openExternalLink, openExternalUrl } from "../utils/external-url.js";
import "@home-assistant/webawesome/dist/components/button/button.js";

interface OtherOption {
  title: string;
  description: string;
  url: string;
  icon: string;
}

const INSTALLATION_TYPES_URL =
  "https://www.home-assistant.io/installation/#about-installation-types";

const OTHER_OPTIONS: OtherOption[] = [
  {
    title: localize("views.other_options_view.home_assistant_container"),
    description: localize(
      "views.other_options_view.run_it_with_docker_without_apps_add_ons_or_the_supervisor"
    ),
    url: "https://www.home-assistant.io/installation/linux#docker-compose",
    icon: "docker",
  },
  {
    title: localize("views.other_options_view.synology_nas"),
    description: localize(
      "views.other_options_view.run_home_assistant_on_your_synology_nas_using_virtual_machine_manager"
    ),
    url: "https://www.home-assistant.io/installation/synology",
    icon: "synology",
  },
  {
    title: localize("views.other_options_view.qnap_nas"),
    description: localize(
      "views.other_options_view.run_home_assistant_on_your_qnap_nas_using_virtualization_station"
    ),
    url: "https://www.home-assistant.io/installation/qnap",
    icon: "qnap",
  },
  {
    title: localize("views.other_options_view.linux_virtual_machine"),
    description: localize(
      "views.other_options_view.run_home_assistant_os_in_kvm_virtualbox_or_vmware_on_linux"
    ),
    url: "https://www.home-assistant.io/installation/linux",
    icon: "linux",
  },
  {
    title: localize("views.other_options_view.windows_virtual_machine"),
    description: localize(
      "views.other_options_view.run_home_assistant_os_in_hyper_v_virtualbox_or_vmware_on_windows"
    ),
    url: "https://www.home-assistant.io/installation/windows",
    icon: "windows",
  },
];

@customElement("other-options-view")
export class OtherOptionsView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = css`
    ${reducedMotionStyles}
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      padding: 2rem;
    }

    .header {
      display: flex;
      align-items: center;
      margin-bottom: 2rem;
    }

    .content {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      overflow-y: auto;
    }

    h1 {
      font-size: 1.75rem;
      font-weight: 400;
      color: var(--ha-text-color, #212121);
      margin: 0 0 0.5rem 0;
      text-align: center;
    }

    .subtitle {
      font-size: 1rem;
      color: var(--ha-secondary-text-color, #727272);
      margin: 0 0 2rem 0;
      text-align: center;
      max-width: 500px;
    }

    .options-list {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      max-width: 600px;
      width: 100%;
    }

    .subtitle a {
      color: var(--ha-primary-color, #03a9f4);
    }
  `;

  render() {
    return html`
      <div class="header">
        <wa-button appearance="plain" @click=${this._onBack}>
          <span slot="start">←</span> ${localize("common.back")}
        </wa-button>
      </div>

      <div class="content">
        <h1>
          ${localize("views.other_options_view.other_installation_methods")}
        </h1>
        <p class="subtitle">
          ${localizeContent(
            "views.other_options_view.these_options_are_not_directly_supported_by_this_installer_but_you_can_foll",
            {
              value0: html`<a
                href=${INSTALLATION_TYPES_URL}
                target="_blank"
                rel="noopener noreferrer"
                @click=${(event: Event) =>
                  openExternalLink(event, INSTALLATION_TYPES_URL)}
                >${localize(
                  "views.other_options_view.compare_installation_types"
                )}</a
              >`,
            }
          )}
        </p>

        <div class="options-list">
          ${OTHER_OPTIONS.map(
            (option) => html`
              <option-card
                horizontal
                .title=${option.title}
                .description=${option.description}
                .image=${"/assets/icons/" + option.icon + ".svg"}
                @click=${() => openExternalUrl(option.url)}
                ><span slot="end" aria-hidden="true">↗</span></option-card
              >
            `
          )}
        </div>
      </div>
    `;
  }

  private _onBack() {
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: { view: "path-selection" },
        bubbles: true,
        composed: true,
      })
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "other-options-view": OtherOptionsView;
  }
}
