import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import type WaRadioGroup from "@home-assistant/webawesome/dist/components/radio-group/radio-group.js";
import "@home-assistant/webawesome/dist/components/input/input.js";
import "@home-assistant/webawesome/dist/components/radio-group/radio-group.js";
import "@home-assistant/webawesome/dist/components/radio/radio.js";
import { getLanguage, localize } from "../localization/localize.js";
import {
  chooseLanguage,
  shippedLanguages,
  shownLanguage,
} from "../localization/initialize.js";
import { mdiMagnify, mdiTranslate } from "../utils/icons.js";
import "./ha-svg-icon.js";
import "./header-menu.js";

/** Longer lists than this get a search field */
const LANGUAGES_WITHOUT_SEARCH = 10;

// The name of `tag` in `language`, capitalized as in a menu
function languageName(tag: string, language = tag): string {
  const name =
    new Intl.DisplayNames([language], { type: "language" }).of(tag) ?? tag;
  return name.charAt(0).toLocaleUpperCase(language) + name.slice(1);
}

// Without case or accents, so "francais" finds Français
const searchable = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();

/** The languages the installer ships, each in its own words, like Deutsch */
@customElement("language-menu")
export class LanguageMenu extends LitElement {
  @state()
  private _search = "";

  static styles = css`
    /* Wide enough for the longest names, so the panel keeps its width while
       the search narrows the list */
    wa-input {
      width: 15rem;
    }

    .none {
      margin: 0;
      color: var(--ha-secondary-text-color);
    }
  `;

  // Hidden while English is the only language
  render() {
    const languages = shippedLanguages();
    if (languages.length < 2) return nothing;
    const search = searchable(this._search);
    // Found by its own name, or by its name in the language shown
    const found = languages
      .map((tag) => ({ tag, name: languageName(tag) }))
      .filter(
        ({ tag, name }) =>
          searchable(name).includes(search) ||
          searchable(languageName(tag, getLanguage())).includes(search)
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    return html`<header-menu
      label=${localize("components.language_menu.language")}
      .icon=${mdiTranslate}
    >
      ${languages.length > LANGUAGES_WITHOUT_SEARCH
        ? html`<wa-input
            type="search"
            size="s"
            accessible-label=${localize("components.language_menu.search")}
            placeholder=${localize("components.language_menu.search")}
            with-clear
            .value=${this._search}
            @input=${this._onSearch}
          >
            <ha-svg-icon slot="start" .path=${mdiMagnify}></ha-svg-icon>
          </wa-input>`
        : nothing}
      <wa-radio-group
        label=${localize("components.language_menu.language")}
        size="s"
        .value=${shownLanguage()}
        @change=${this._onChange}
      >
        ${found.map(
          ({ tag, name }) =>
            html`<wa-radio value=${tag} lang=${tag}>${name}</wa-radio>`
        )}
      </wa-radio-group>
      ${found.length
        ? nothing
        : html`<p class="none">
            ${localize("components.language_menu.no_match")}
          </p>`}
    </header-menu>`;
  }

  private _onSearch(event: Event) {
    this._search = (event.target as WaInput).value ?? "";
  }

  private _onChange(event: Event) {
    void chooseLanguage((event.target as WaRadioGroup).value as string);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "language-menu": LanguageMenu;
  }
}
