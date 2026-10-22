import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import type WaSlider from "@home-assistant/webawesome/dist/components/slider/slider.js";
import "@home-assistant/webawesome/dist/components/slider/slider.js";
import { formatNumber, localize } from "../localization/localize.js";
import { settingStyles } from "../utils/setting-styles.js";

/** What a VM gets, as `resources-change` reports it */
export interface VmResourceValues {
  cpuCores: number;
  memoryMb: number;
  diskSizeGb: number;
}

export function formatCores(cores: number): string {
  return localize("views.proxmox.proxmox_configure_view.value_cores", {
    value0: cores,
  });
}

export function formatMemory(mb: number): string {
  return localize("components.drive_card.value_gb", {
    value0: formatNumber(mb / 1024, { maximumFractionDigits: 20 }),
  });
}

export function formatDiskSize(gb: number): string {
  return gb >= 1024
    ? localize("components.drive_card.value_tb", {
        value0: formatNumber(gb / 1024, { maximumFractionDigits: 20 }),
      })
    : localize("components.drive_card.value_gb", {
        value0: formatNumber(gb, { maximumFractionDigits: 20 }),
      });
}

function cpuDescription(cores: number): string {
  if (cores <= 2) {
    return localize(
      "views.proxmox.proxmox_configure_view.minimum_for_basic_operation"
    );
  } else if (cores <= 4) {
    return localize(
      "views.proxmox.proxmox_configure_view.recommended_for_most_users"
    );
  } else if (cores <= 8) {
    return localize(
      "views.proxmox.proxmox_configure_view.better_performance_with_many_integrations"
    );
  }
  return localize(
    "views.proxmox.proxmox_configure_view.maximum_performance_for_power_users"
  );
}

function memoryDescription(mb: number): string {
  const gb = mb / 1024;
  if (gb <= 2) {
    return localize(
      "views.proxmox.proxmox_configure_view.minimum_for_basic_operation"
    );
  } else if (gb <= 4) {
    return localize(
      "views.proxmox.proxmox_configure_view.recommended_for_most_users"
    );
  } else if (gb <= 8) {
    return localize(
      "views.proxmox.proxmox_configure_view.better_for_add_ons_and_many_integrations"
    );
  }
  return localize(
    "views.proxmox.proxmox_configure_view.maximum_performance_for_power_users"
  );
}

function diskDescription(gb: number): string {
  if (gb <= 32) {
    return localize(
      "views.proxmox.proxmox_configure_view.good_for_getting_started"
    );
  } else if (gb <= 64) {
    return localize(
      "views.proxmox.proxmox_configure_view.room_for_add_ons_and_history"
    );
  } else if (gb <= 128) {
    return localize(
      "views.proxmox.proxmox_configure_view.plenty_of_space_for_long_term_use"
    );
  }
  return localize(
    "views.proxmox.proxmox_configure_view.extended_storage_for_recordings_and_backups"
  );
}

/**
 * Where a value sits among its options. One the options don't have, like a
 * restored value while they are still being looked up, shows at the largest
 * option below it.
 */
function indexOf(options: number[], value: number): number {
  const index = options.indexOf(value);
  if (index >= 0) return index;
  const below = options.filter((option) => option < value).length;
  return Math.max(below - 1, 0);
}

// MDI icons (https://materialdesignicons.com/)
const cpuIcon = html`<svg viewBox="0 0 24 24">
  <path
    d="M6,4H18V5H21V7H18V9H21V11H18V13H21V15H18V17H21V19H18V20H6V19H3V17H6V15H3V13H6V11H3V9H6V7H3V5H6V4M11,15V18H12V15H11M13,15V18H14V15H13M15,15V18H16V15H15Z"
  />
</svg>`;

const memoryIcon = html`<svg viewBox="0 0 24 24">
  <path
    d="M17,17H7V7H17M21,11V9H19V7C19,5.89 18.1,5 17,5H15V3H13V5H11V3H9V5H7C5.89,5 5,5.89 5,7V9H3V11H5V13H3V15H5V17A2,2 0 0,0 7,19H9V21H11V19H13V21H15V19H17A2,2 0 0,0 19,17V15H21V13H19V11M13,13H11V11H13M15,9H9V15H15V9Z"
  />
</svg>`;

const diskIcon = html`<svg viewBox="0 0 24 24">
  <path
    d="M12,3C7.58,3 4,4.79 4,7C4,9.21 7.58,11 12,11C16.42,11 20,9.21 20,7C20,4.79 16.42,3 12,3M4,9V12C4,14.21 7.58,16 12,16C16.42,16 20,14.21 20,12V9C20,11.21 16.42,13 12,13C7.58,13 4,11.21 4,9M4,14V17C4,19.21 7.58,21 12,21C16.42,21 20,19.21 20,17V14C20,16.21 16.42,18 12,18C7.58,18 4,16.21 4,14Z"
  />
</svg>`;

/**
 * The cores, memory and disk sliders of a VM, shared by the UTM and Proxmox
 * settings. Each slider steps through its options. The view owns the values
 * and the options, and hears every change as `resources-change`.
 */
@customElement("vm-resources")
export class VmResources extends LitElement {
  static styles = [
    settingStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: 1.75rem;
      }
    `,
  ];

  @property({ attribute: false }) coreOptions: number[] = [];
  @property({ attribute: false }) memoryOptions: number[] = [];
  @property({ attribute: false }) diskOptions: number[] = [];

  @property({ attribute: false }) cpuCores = 0;
  @property({ attribute: false }) memoryMb = 0;
  @property({ attribute: false }) diskSizeGb = 0;

  private _change(change: Partial<VmResourceValues>) {
    this.dispatchEvent(
      new CustomEvent<VmResourceValues>("resources-change", {
        detail: {
          cpuCores: this.cpuCores,
          memoryMb: this.memoryMb,
          diskSizeGb: this.diskSizeGb,
          ...change,
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  private _onCoresInput(e: Event) {
    const cores = this.coreOptions[(e.target as WaSlider).value];
    if (cores !== undefined) this._change({ cpuCores: cores });
  }

  private _onMemoryInput(e: Event) {
    const mb = this.memoryOptions[(e.target as WaSlider).value];
    if (mb !== undefined) this._change({ memoryMb: mb });
  }

  private _onDiskSizeInput(e: Event) {
    const gb = this.diskOptions[(e.target as WaSlider).value];
    if (gb !== undefined) this._change({ diskSizeGb: gb });
  }

  // The sliders step through option indexes, so they show the option there
  private _formatCoresAt = (index: number) =>
    formatCores(this.coreOptions[index] ?? this.cpuCores);

  private _formatMemoryAt = (index: number) =>
    formatMemory(this.memoryOptions[index] ?? this.memoryMb);

  private _formatDiskSizeAt = (index: number) =>
    formatDiskSize(this.diskOptions[index] ?? this.diskSizeGb);

  private _renderSlider(
    icon: unknown,
    label: string,
    options: number[],
    value: number,
    text: string,
    description: string,
    onInput: (e: Event) => void,
    formatter: (index: number) => string
  ) {
    return html`<div class="setting-row">
      <div class="setting-icon">${icon}</div>
      <div class="setting-content">
        <wa-slider
          with-markers
          with-tooltip
          min="0"
          max=${Math.max(options.length - 1, 0)}
          step="1"
          ?disabled=${options.length < 2}
          .value=${
            // live(): a value restored before its options are known shows at
            // the closest option, and must move once they arrive
            live(indexOf(options, value))
          }
          @input=${onInput}
          .valueFormatter=${formatter}
          ><div slot="label" class="setting-header">
            <span class="setting-label">${label}</span
            ><span class="setting-value" aria-hidden="true">${text}</span>
          </div>
          <!-- The hint describes the slider, so its advice is read out with it -->
          <p slot="hint" class="setting-description">
            ${description}
          </p></wa-slider
        >
      </div>
    </div>`;
  }

  render() {
    return html`
      ${this._renderSlider(
        cpuIcon,
        localize("views.proxmox.proxmox_configure_view.cpu_cores"),
        this.coreOptions,
        this.cpuCores,
        formatCores(this.cpuCores),
        cpuDescription(this.cpuCores),
        this._onCoresInput,
        this._formatCoresAt
      )}
      ${this._renderSlider(
        memoryIcon,
        localize("views.proxmox.proxmox_configure_view.memory"),
        this.memoryOptions,
        this.memoryMb,
        formatMemory(this.memoryMb),
        memoryDescription(this.memoryMb),
        this._onMemoryInput,
        this._formatMemoryAt
      )}
      ${this._renderSlider(
        diskIcon,
        localize("views.proxmox.proxmox_configure_view.disk_size"),
        this.diskOptions,
        this.diskSizeGb,
        formatDiskSize(this.diskSizeGb),
        diskDescription(this.diskSizeGb),
        this._onDiskSizeInput,
        this._formatDiskSizeAt
      )}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "vm-resources": VmResources;
  }
}
