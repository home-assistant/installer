import { css, html } from "lit";
import { localize } from "../localization/localize.js";
import "./casita-mascot.js";

// The supplied Casita artwork. Each install state picks a mood; the thinking
// cloud keeps naming the current stage next to the focusing Casita.

/**
 * The cloud's look, which every shadow root that renders
 * renderCasitaThinking() needs. It rises above Casita and past its right
 * edge, outside the artwork's box, so the layout leaves room there.
 */
export const thinkingCloudStyles = css`
  /* Right of Casita in either direction: the artwork's bubbles rise that
     way */
  .thinking-cloud {
    position: absolute;
    top: -110px;
    right: -175px;
    width: 200px;
    height: 120px;
    z-index: 1;
  }

  .thinking-cloud .cloud-text {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    color: white;
    font-size: 1.25rem;
    font-weight: 500;
    white-space: nowrap;
    z-index: 2;
  }

  .thinking-cloud .cloud-bump {
    position: absolute;
    background-color: #18bcf2;
    border-radius: 50%;
  }

  /* Build cloud shape from overlapping circles - like a real thought bubble */
  /* Left bump */
  .thinking-cloud .bump-1 {
    width: 70px;
    height: 70px;
    top: 30px;
    left: 0;
  }

  /* Top left bump */
  .thinking-cloud .bump-2 {
    width: 80px;
    height: 80px;
    top: 0;
    left: 25px;
  }

  /* Top center bump */
  .thinking-cloud .bump-3 {
    width: 90px;
    height: 85px;
    top: -5px;
    left: 70px;
  }

  /* Top right bump */
  .thinking-cloud .bump-4 {
    width: 75px;
    height: 75px;
    top: 5px;
    right: 10px;
  }

  /* Right bump */
  .thinking-cloud .bump-5 {
    width: 65px;
    height: 65px;
    top: 40px;
    right: 0;
  }

  /* Bottom right bump */
  .thinking-cloud .bump-6 {
    width: 70px;
    height: 70px;
    bottom: 0;
    right: 20px;
  }

  /* Bottom center bump */
  .thinking-cloud .bump-7 {
    width: 80px;
    height: 75px;
    bottom: -5px;
    left: 60px;
  }

  /* Bottom left bump */
  .thinking-cloud .bump-8 {
    width: 65px;
    height: 65px;
    bottom: 5px;
    left: 10px;
  }

  /* Center fill */
  .thinking-cloud .bump-center {
    width: 140px;
    height: 80px;
    border-radius: 50%;
    top: 20px;
    left: 30px;
  }
`;

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
