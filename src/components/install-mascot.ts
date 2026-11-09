import { html } from "lit";
import "./casita-mascot.js";

// The supplied Casita artwork. Each install state picks a mood.

export function renderCasitaFocusing() {
  return html`<casita-mascot
    class="casita-mascot"
    mood="focusing"
  ></casita-mascot>`;
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
