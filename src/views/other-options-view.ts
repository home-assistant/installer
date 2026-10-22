import { localize, localizeContent } from "../localization/localize.js";
import { LitElement, html, css } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../utils/view-accessibility.js";
import { customElement } from "lit/decorators.js";
import { pageHeaderStyles, renderBackHeader } from "../utils/page-header.js";
import { linkStyles } from "../utils/link-styles.js";
import "../components/option-card.js";
import { openExternalLink, openExternalUrl } from "../utils/external-url.js";

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
    description: localize("views.other_options_view.docker_description"),
    url: "https://www.home-assistant.io/installation/linux#docker-compose",
    icon: "docker",
  },
  {
    title: localize("views.other_options_view.synology_nas"),
    description: localize("views.other_options_view.synology_description"),
    url: "https://www.home-assistant.io/installation/alternative#synology-nas",
    icon: "synology",
  },
  {
    title: localize("views.other_options_view.qnap_nas"),
    description: localize("views.other_options_view.qnap_description"),
    url: "https://www.home-assistant.io/installation/alternative#qnap-nas",
    icon: "qnap",
  },
  {
    title: localize("views.other_options_view.linux_virtual_machine"),
    description: localize("views.other_options_view.linux_description"),
    url: "https://www.home-assistant.io/installation/linux",
    icon: "linux",
  },
  {
    title: localize("views.other_options_view.windows_virtual_machine"),
    description: localize("views.other_options_view.windows_description"),
    url: "https://www.home-assistant.io/installation/windows",
    icon: "windows",
  },
];

@customElement("other-options-view")
export class OtherOptionsView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    reducedMotionStyles,
    pageHeaderStyles,
    linkStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
        height: 100%;
      }

      .content {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        overflow-y: auto;
        padding: 1rem var(--ha-page-gutter, 2rem) 2rem;
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
    `,
  ];

  render() {
    return html`
      ${renderBackHeader(this._onBack)}

      <div class="content">
        <h1>
          ${localize("views.other_options_view.other_installation_methods")}
        </h1>
        <p class="subtitle">
          ${localizeContent("views.other_options_view.subtitle", {
            link: html`<a
              href=${INSTALLATION_TYPES_URL}
              target="_blank"
              rel="noopener noreferrer"
              @click=${openExternalLink}
              >${localize(
                "views.other_options_view.compare_installation_types"
              )}</a
            >`,
          })}
        </p>

        <div class="options-list">
          ${OTHER_OPTIONS.map(
            (option) => html`
              <option-card
                horizontal
                .heading=${option.title}
                .description=${option.description}
                .icon=${option.icon}
                data-url=${option.url}
                @click=${this._onOptionClick}
                ><span slot="end" aria-hidden="true">↗</span></option-card
              >
            `
          )}
        </div>
      </div>
    `;
  }

  private async _onOptionClick(ev: Event) {
    await openExternalUrl((ev.currentTarget as HTMLElement).dataset.url!);
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
