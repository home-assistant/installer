import { html } from "lit";
import "./casita-mascot.js";
import type { CasitaMood } from "./casita-mascot.js";

// One template for every mood, so Lit keeps the element and Casita blends between them
export function renderCasita(mood: CasitaMood, celebrate = false) {
  return html`<casita-mascot
    class="casita-mascot"
    mood=${mood}
    ?celebrate=${celebrate}
  ></casita-mascot>`;
}
