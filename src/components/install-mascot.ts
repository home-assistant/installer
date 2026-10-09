import { html } from "lit";
import { localize } from "../localization/localize.js";
import "./casita-mascot.js";

// The supplied Casita artwork. Each install state picks a mood; the thinking
// cloud keeps naming the current stage next to the focusing Casita.

export function renderCasitaThinking(text: string) {
  return html`
    <div style="position: relative; width: 100%; height: 100%;">
      <casita-mascot class="casita-mascot" mood="focusing"></casita-mascot>
      <div class="thinking-cloud">
        <div class="cloud-bump bump-center"></div>
        <div class="cloud-bump bump-1"></div>
        <div class="cloud-bump bump-2"></div>
        <div class="cloud-bump bump-3"></div>
        <div class="cloud-bump bump-4"></div>
        <div class="cloud-bump bump-5"></div>
        <div class="cloud-bump bump-6"></div>
        <div class="cloud-bump bump-7"></div>
        <div class="cloud-bump bump-8"></div>
        <div class="cloud-text">
          ${localize("components.install_mascot.stage_in_progress", {
            stage: text,
          })}
        </div>
      </div>
    </div>
  `;
}

export function renderCasitaHappy() {
  return html`<casita-mascot
    class="casita-mascot"
    mood="happy"
  ></casita-mascot>`;
}

export function renderCasitaSad() {
  return html`<casita-mascot
    class="casita-mascot"
    mood="problem"
  ></casita-mascot>`;
}
