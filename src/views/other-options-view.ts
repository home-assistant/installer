import { localize, localizeContent } from "../localization/localize.js";
import { LitElement, html, css } from "lit";
import {
  ViewAccessibility,
  reducedMotionStyles,
} from "../utils/view-accessibility.js";
import { customElement } from "lit/decorators.js";
import { pageStyles, renderBackHeader } from "../utils/page-header.js";
import { linkStyles } from "../utils/link-styles.js";
import { fireEvent } from "../utils/fire-event.js";
import "../components/option-card.js";
import type { OptionCardIcon } from "../components/option-card.js";
import { openExternalLink, openExternalUrl } from "../utils/external-url.js";

interface OtherOption {
  title: string;
  description: string;
  url: string;
  icon: OptionCardIcon;
}

const INSTALLATION_TYPES_URL =
  "https://www.home-assistant.io/installation/#about-installation-types";

// A function, so the text is localized when the view renders, not when the
// module loads, and follows the language
const otherOptions = (): OtherOption[] => [
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
    pageStyles,
    linkStyles,
    css`
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
          ${otherOptions().map(
            (option) => html`
              <option-card
                horizontal
                external
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
    fireEvent(this, "navigate", { view: "path-selection" });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "other-options-view": OtherOptionsView;
  }
}
