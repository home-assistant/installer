import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";

const artwork = {
  happy: "Happy",
  grinning: "Grinning",
  loving: "Loving",
  winking: "Winking",
  loading: "Loading",
  focusing: "Focusing",
  sad: "Sad",
  problem: "Problem",
} as const;

export type CasitaMood = keyof typeof artwork;

/** Decorative artwork: the surrounding view supplies the state in text. */
@customElement("casita-mascot")
export class CasitaMascot extends LitElement {
  @property() mood: CasitaMood = "happy";

  static styles = css`
    :host {
      display: block;
      width: 120px;
      height: 120px;
      flex-shrink: 0;
    }
    img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
  `;

  render() {
    const name = Object.prototype.hasOwnProperty.call(artwork, this.mood)
      ? artwork[this.mood]
      : artwork.happy;
    return html`<img src=${`/assets/casita/${name}.svg`} alt="" />`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "casita-mascot": CasitaMascot;
  }
}
