import { localize } from "../../localization/localize.js";
import { LitElement, html, css, nothing } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import {
  ViewAccessibility,
  focusAlert,
  srOnlyStyles,
} from "../../utils/view-accessibility.js";
import {
  checkIsoLocation,
  chooseFolder,
  defaultIsoFolder,
  getHaosRelease,
} from "../../api/index.js";
import {
  installerError,
  type InstallerError,
} from "../../utils/installer-error.js";
import { fieldError, fieldErrorStyles } from "../../utils/field-error.js";
import { wizardState } from "../../state/wizard-state.js";
import { nextOnEnter } from "../../components/wizard-next.js";
import { renderStepHeading } from "../../utils/step-styles.js";
import { liveUsbStyles } from "./live-usb-styles.js";
import "@home-assistant/webawesome/dist/components/input/input.js";
import "@home-assistant/webawesome/dist/components/button/button.js";
import "../../components/info-dialog.js";
import "../../components/inline-notice.js";
import "./live-usb-gate.js";

const FALLBACK_NAME = "hai-live-haos.iso";

type IsoField = "folder" | "name";

/**
 * The field each refusal of the location is about. The others, like a folder
 * that can't be written to, are the location's as a whole.
 */
const PROBLEM_FIELDS: Partial<Record<string, IsoField>> = {
  folder_not_found: "folder",
  folder_in_cache: "folder",
  invalid_file_name: "name",
  file_name_not_portable: "name",
  folder_name_taken: "name",
};

/** Why the location can't be used, and the field that is about, if one */
interface IsoProblem {
  message: string;
  field?: IsoField;
}

/** Where to save the ISO: a folder and a file name, both filled in to start with. */
@customElement("live-iso-location-view")
export class LiveIsoLocationView extends LitElement {
  protected readonly _accessibility = new ViewAccessibility(this);
  static styles = [
    liveUsbStyles,
    fieldErrorStyles,
    srOnlyStyles,
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

  /** Why the location can't be used, on its field or under the fields */
  @state()
  private _problem: IsoProblem | null = null;

  /** A field's problem said again, while that field kept the focus */
  @state()
  private _sayAgain = "";

  @query("wa-input.folder")
  private _folderInput?: WaInput;

  @query("wa-input.name")
  private _nameInput?: WaInput;

  @query(".problem")
  private _problemNotice?: HTMLElement;

  @state()
  private _askReplace = false;

  private _answerReplace?: (replace: boolean) => void;

  /**
   * Called by the shell when Next is pressed. Resolves true once the location
   * is usable, asking first if that means replacing an existing file.
   */
  async check(): Promise<boolean> {
    const folder = this._folder;
    const name = this._name;
    // Back or Cancel while checking: nobody is left to answer a prompt.
    // An edit meanwhile was not checked, so it waits for the next press, and
    // a problem with the old location must not show under the new one.
    const outdated = () =>
      !this.isConnected || this._folder !== folder || this._name !== name;
    // The previous problem stays until this answer arrives: removing it
    // would move the focus on every press of Next
    let exists: boolean;
    try {
      ({ exists } = await checkIsoLocation(folder, name));
    } catch (error) {
      if (!outdated()) await this._showProblem(installerError(error), outdated);
      return false;
    }
    if (outdated()) return false;
    this._problem = null;
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

  /**
   * Show `error`, and read it out: from its field, which takes the focus and
   * describes itself with it, or from the notice under the fields. Either
   * way it is read out again when another press of Next gets the same.
   */
  private async _showProblem(error: InstallerError, outdated: () => boolean) {
    const field = PROBLEM_FIELDS[error.code];
    this._problem = { message: error.message, field };
    await this.updateComplete;
    // Typed meanwhile, the problem is gone again
    if (outdated()) return;
    if (!field) {
      focusAlert(this._problemNotice);
      return;
    }
    const input = field === "folder" ? this._folderInput : this._nameInput;
    await input?.updateComplete;
    if (!input?.matches(":focus-within")) {
      this._sayAgain = "";
      input?.focus();
      return;
    }
    // Enter in the field leaves the focus there, so nothing new is read
    // out, not even the hint when it comes back the same: the status line
    // says it instead, changed every time so that it is said again
    this._sayAgain =
      this._sayAgain === error.message
        ? `${error.message}\u00a0`
        : error.message;
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
      const release = await getHaosRelease("generic-x86-64");
      name = `hai-live-haos-${release.version}.iso`;
    } catch {
      // Offline: the cached files may still work, so keep a generic name.
    }
    if (this.isConnected && !this._name) this._setName(name);
  }

  private _setFolder(folder: string) {
    this._folder = folder;
    this._problem = null;
    wizardState.setSelection("liveIsoFolder", folder);
    wizardState.setSelection("liveIsoOverwrite", false);
  }

  private _setName(name: string) {
    this._name = name;
    this._problem = null;
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

  // In the hint slot, so the field describes itself with it as it takes the
  // focus
  private _renderHint(error: string | undefined) {
    return error ? html`<span slot="hint">${error}</span>` : nothing;
  }

  render() {
    const problem = this._problem;
    const folderError =
      problem?.field === "folder" ? problem.message : undefined;
    const nameError = problem?.field === "name" ? problem.message : undefined;
    return html`
      <live-usb-gate>
        ${renderStepHeading(
          localize("views.live_usb.live_iso_location_view.where_to_save"),
          localize("views.live_usb.live_iso_location_view.subtitle")
        )}
        <p class="sr-only" role="status">
          ${problem?.field ? this._sayAgain : ""}
        </p>
        <div class="card">
          <div class="folder-row">
            <wa-input
              class="folder"
              label=${localize("views.live_usb.live_iso_location_view.folder")}
              .value=${this._folder}
              @input=${this._onFolderInput}
              @keydown=${nextOnEnter}
              ${fieldError(folderError)}
            >
              ${this._renderHint(folderError)}
            </wa-input>
            <wa-button pill appearance="outlined" @click=${this._browse}>
              ${localize("views.live_usb.live_iso_location_view.browse")}
            </wa-button>
          </div>
          ${this._browseFailed
            ? html`<inline-notice variant="error" data-focus-alert>
                <p>
                  ${localize(
                    "views.live_usb.live_iso_location_view.browse_failed"
                  )}
                </p>
              </inline-notice>`
            : ""}
          <wa-input
            class="name"
            label=${localize("views.live_usb.live_iso_location_view.file_name")}
            .value=${this._name}
            @input=${this._onNameInput}
            @keydown=${nextOnEnter}
            ${fieldError(nameError)}
          >
            ${this._renderHint(nameError)}
          </wa-input>
          ${problem && !problem.field
            ? html`<inline-notice
                class="problem"
                variant="error"
                data-focus-alert
              >
                <p>${problem.message}</p>
              </inline-notice>`
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
