import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import type WaSlider from "@home-assistant/webawesome/dist/components/slider/slider.js";
import "@home-assistant/webawesome/dist/components/slider/slider.js";
import { localize } from "../localization/localize.js";
import { formatDiskSize, formatMemory } from "../utils/format.js";
import { mdiChip, mdiDatabase, mdiMemory } from "../utils/icons.js";
import { renderIcon } from "../utils/render-icon.js";
import { settingStyles } from "../utils/setting-styles.js";

/** What a VM gets, as `resources-change` reports it */
export interface VmResourceValues {
  cpuCores: number;
  memoryMb: number;
  diskSizeGb: number;
}

function formatCores(cores: number): string {
  return localize("components.vm_resources.cores", {
    count: cores,
  });
}

function cpuDescription(cores: number): string {
  if (cores <= 2) {
    return localize("components.vm_resources.cpu_minimum");
  } else if (cores <= 4) {
    return localize("components.vm_resources.cpu_recommended");
  } else if (cores <= 8) {
    return localize("components.vm_resources.cpu_more");
  }
  return localize("components.vm_resources.cpu_maximum");
}

function memoryDescription(mb: number): string {
  const gb = mb / 1024;
  if (gb <= 2) {
    return localize("components.vm_resources.memory_minimum");
  } else if (gb <= 4) {
    return localize("components.vm_resources.memory_recommended");
  } else if (gb <= 8) {
    return localize("components.vm_resources.memory_more");
  }
  return localize("components.vm_resources.memory_maximum");
}

function diskDescription(gb: number): string {
  if (gb <= 32) {
    return localize("components.vm_resources.disk_starter");
  } else if (gb <= 64) {
    return localize("components.vm_resources.disk_room");
  } else if (gb <= 128) {
    return localize("components.vm_resources.disk_long_term");
  }
  return localize("components.vm_resources.disk_extended");
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
    // The slider's label says what the icon shows
    return html`<div class="setting-row">
      <div class="setting-icon" aria-hidden="true">${icon}</div>
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
        renderIcon(mdiChip),
        localize("components.vm_resources.cpu_cores"),
        this.coreOptions,
        this.cpuCores,
        formatCores(this.cpuCores),
        cpuDescription(this.cpuCores),
        this._onCoresInput,
        this._formatCoresAt
      )}
      ${this._renderSlider(
        renderIcon(mdiMemory),
        localize("components.vm_resources.memory"),
        this.memoryOptions,
        this.memoryMb,
        formatMemory(this.memoryMb),
        memoryDescription(this.memoryMb),
        this._onMemoryInput,
        this._formatMemoryAt
      )}
      ${this._renderSlider(
        renderIcon(mdiDatabase),
        localize("components.vm_resources.disk_size"),
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
