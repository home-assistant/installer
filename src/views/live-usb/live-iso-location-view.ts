import { localize } from "../../localization/localize.js";
import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { ViewAccessibility } from "../../utils/view-accessibility.js";
import {
  checkIsoLocation,
  chooseFolder,
  defaultIsoFolder,
  getHaosRelease,
} from "../../api/index.js";
import { installerError } from "../../utils/installer-error.js";
import { wizardState } from "../../state/wizard-state.js";
import { liveUsbStyles } from "./live-usb-styles.js";
import "@home-assistant/webawesome/dist/components/input/input.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "../../components/info-dialog.js";
import "./live-usb-gate.js";

const FALLBACK_NAME = "hai-live-haos.iso";

/** Where to save the ISO: a folder and a file name, both filled in to start with. */
@customElement("live-iso-location-view")
export class LiveIsoLocationView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    liveUsbStyles,
    css`
      .folder-row {
        display: flex;
        gap: 0.5rem;
        align-items: flex-end;
      }
      .folder-row wa-input {
        flex: 1;
      }
      /* Paths and file names read left to right in any language; labels don't */
      wa-input::part(input) {
        direction: ltr;
      }
    `,
  ];

  @state()
  private _folder = "";

  @state()
  private _name = "";

  @state()
  private _browseFailed = false;

  /** Why the location can't be used, shown under the fields. */
  @state()
  private _problem = "";

  @state()
  private _askReplace = false;

  private _answerReplace?: (replace: boolean) => void;

  /**
   * Called by the shell when Next is pressed. Resolves true once the location
   * is usable, asking first if that means replacing an existing file.
   */
  async check(): Promise<boolean> {
    this._problem = "";
    const folder = this._folder;
    const name = this._name;
    let exists: boolean;
    try {
      ({ exists } = await checkIsoLocation(folder, name));
    } catch (error) {
      this._problem = installerError(error).message;
      return false;
    }
    // Back or Cancel while checking: nobody is left to answer a prompt.
    // An edit meanwhile was not checked, so it waits for the next press.
    if (!this.isConnected || this._folder !== folder || this._name !== name) {
      return false;
    }
    if (!exists) {
      wizardState.setSelection("liveIsoOverwrite", false);
      return true;
    }
    this._askReplace = true;
    const replace = await new Promise<boolean>((resolve) => {
      this._answerReplace = resolve;
    });
    wizardState.setSelection("liveIsoOverwrite", replace);
    return replace;
  }

  private _answer(replace: boolean) {
    this._askReplace = false;
    this._answerReplace?.(replace);
    this._answerReplace = undefined;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._answer(false);
  }

  connectedCallback() {
    super.connectedCallback();
    const selections = wizardState.getState().selections;
    this._folder = selections.liveIsoFolder ?? "";
    this._name = selections.liveIsoName ?? "";
    if (!this._folder) void this._fillFolder();
    if (!this._name) void this._fillName();
  }

  private async _fillFolder() {
    try {
      const folder = await defaultIsoFolder();
      if (this.isConnected && !this._folder) this._setFolder(folder);
    } catch {
      // No default folder; the user types or browses for one.
    }
  }

  private async _fillName() {
    let name = FALLBACK_NAME;
    try {
      const release = await getHaosRelease(undefined, "generic-x86-64");
      name = `hai-live-haos-${release.version}.iso`;
    } catch {
      // Offline: the cached files may still work, so keep a generic name.
    }
    if (this.isConnected && !this._name) this._setName(name);
  }

  private _setFolder(folder: string) {
    this._folder = folder;
    this._problem = "";
    wizardState.setSelection("liveIsoFolder", folder);
    wizardState.setSelection("liveIsoOverwrite", false);
  }

  private _setName(name: string) {
    this._name = name;
    this._problem = "";
    wizardState.setSelection("liveIsoName", name.trim());
    wizardState.setSelection("liveIsoOverwrite", false);
  }

  private async _browse() {
    this._browseFailed = false;
    try {
      const folder = await chooseFolder(this._folder);
      if (folder) this._setFolder(folder);
    } catch {
      this._browseFailed = true;
    }
  }

  private _onFolderInput(event: Event) {
    this._setFolder((event.target as HTMLInputElement).value);
  }

  private _onNameInput(event: Event) {
    this._setName((event.target as HTMLInputElement).value);
  }

  private _onReplace() {
    this._answer(true);
  }

  private _onKeep() {
    this._answer(false);
  }

  render() {
    return html`
      <live-usb-gate>
        <h2>
          ${localize("views.live_usb.live_iso_location_view.where_to_save")}
        </h2>
        <p class="subtitle">
          ${localize("views.live_usb.live_iso_location_view.subtitle")}
        </p>
        <div class="card">
          <div class="folder-row">
            <wa-input
              label=${localize("views.live_usb.live_iso_location_view.folder")}
              .value=${this._folder}
              @input=${this._onFolderInput}
            ></wa-input>
            <wa-button appearance="outlined" @click=${this._browse}>
              ${localize("views.live_usb.live_iso_location_view.browse")}
            </wa-button>
          </div>
          ${this._browseFailed
            ? html`<p class="notice error" role="alert">
                ${localize(
                  "views.live_usb.live_iso_location_view.browse_failed"
                )}
              </p>`
            : ""}
          <wa-input
            label=${localize("views.live_usb.live_iso_location_view.file_name")}
            .value=${this._name}
            @input=${this._onNameInput}
          ></wa-input>
          ${this._problem
            ? html`<p class="notice error" role="alert">${this._problem}</p>`
            : ""}
        </div>
        <info-dialog
          ?open=${this._askReplace}
          heading=${localize(
            "views.live_usb.live_iso_location_view.replace_title"
          )}
          message=${localize(
            "views.live_usb.live_iso_location_view.replace_message",
            {
              name: this._name.trim(),
            }
          )}
          primary-label=${localize(
            "views.live_usb.live_iso_location_view.replace"
          )}
          secondary-label=${localize("common.cancel")}
          @dialog-primary=${this._onReplace}
          @dialog-secondary=${this._onKeep}
        ></info-dialog>
      </live-usb-gate>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "live-iso-location-view": LiveIsoLocationView;
  }
}
