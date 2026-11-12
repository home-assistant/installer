import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { isExpression, type Expression } from "../casita/expressions.js";
import { CasitaFace } from "../casita/face.js";

export type CasitaMood = Expression;

const LOOK_AWAY_AFTER = 2500;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/** Decorative artwork: the surrounding view supplies the state in text. */
@customElement("casita-mascot")
export class CasitaMascot extends LitElement {
  @property() mood: CasitaMood = "happy";

  /** Casita cheers once, as soon as this is set */
  @property({ type: Boolean }) celebrate = false;

  @query("svg", true) private _svg?: SVGSVGElement;

  private _face?: CasitaFace;
  private _visibility?: IntersectionObserver;
  private _cheered = false;
  private _cheerWhenShown = false;
  private _pointer: readonly [number, number] | null = null;
  private _pointerFrame = 0;

  static styles = css`
    :host {
      display: block;
      width: 120px;
      height: 120px;
      flex-shrink: 0;
    }
    svg {
      display: block;
      width: 100%;
      height: 100%;
      overflow: visible;
    }
  `;

  hop() {
    this._face?.hop();
  }

  connectedCallback() {
    super.connectedCallback();
    reducedMotion.addEventListener("change", this._recreate);
    if (this.hasUpdated) this._create();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    reducedMotion.removeEventListener("change", this._recreate);
    this._destroy();
  }

  protected firstUpdated() {
    this._create();
  }

  protected updated(changed: PropertyValues<this>) {
    if (changed.has("mood") && this._face?.setExpression(this._expression)) {
      this._face.hop(0.6);
    }
    if (this.celebrate && !this._cheered) {
      this._cheered = true;
      this._cheerWhenShown = true;
      this._cheerIfShown();
    }
  }

  render() {
    return html`<svg viewBox="0 0 120 116.88" aria-hidden="true"></svg>`;
  }

  private get _expression(): Expression {
    return isExpression(this.mood) ? this.mood : "happy";
  }

  private _create() {
    if (!this._svg || this._face) return;
    const animated = !reducedMotion.matches;
    this._face = new CasitaFace(this._svg, {
      expression: this._expression,
      animated,
    });
    if (!animated) return;
    this._visibility = new IntersectionObserver((entries) => {
      const latest = entries[entries.length - 1];
      if (latest?.isIntersecting) this._resume();
      else this._pause();
    });
    this._visibility.observe(this);
  }

  private _destroy() {
    this._visibility?.disconnect();
    this._visibility = undefined;
    this._pause();
    this._face?.destroy();
    this._face = undefined;
  }

  private readonly _recreate = () => {
    this._destroy();
    this._create();
  };

  private _resume() {
    this._face?.start();
    window.addEventListener("pointermove", this._onPointerMove);
    this._cheerIfShown();
  }

  private _pause() {
    this._face?.stop();
    window.removeEventListener("pointermove", this._onPointerMove);
    cancelAnimationFrame(this._pointerFrame);
    this._pointerFrame = 0;
  }

  private _cheerIfShown() {
    const face = this._face;
    if (!this._cheerWhenShown || !face?.running) return;
    this._cheerWhenShown = false;
    face.hop(1.3);
    for (const vx of [-75, -45, -15, 15, 45, 75]) {
      face.burst("star", {
        y: 4,
        vx,
        vy: -130 + Math.abs(vx) * 0.4,
        gravity: 220,
        life: 1.5,
        startSize: 0.8,
        endSize: 0.5,
      });
    }
    face.burst("heart", { count: 3, y: 0 });
  }

  private readonly _onPointerMove = (event: PointerEvent) => {
    this._pointer = [event.clientX, event.clientY];
    if (!this._pointerFrame) {
      this._pointerFrame = requestAnimationFrame(this._lookAtPointer);
    }
  };

  private readonly _lookAtPointer = () => {
    this._pointerFrame = 0;
    const face = this._face;
    if (!face || !this._pointer) return;
    const [x, y] = this._pointer;
    face.lookAt(face.toSvgPoint(x, y), LOOK_AWAY_AFTER);
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "casita-mascot": CasitaMascot;
  }
}
