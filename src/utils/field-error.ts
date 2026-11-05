import { css, noChange } from "lit";
import {
  Directive,
  PartType,
  directive,
  type ElementPart,
  type PartInfo,
} from "lit/directive.js";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";
import type WaSelect from "@home-assistant/webawesome/dist/components/select/select.js";

class FieldErrorDirective extends Directive {
  constructor(partInfo: PartInfo) {
    super(partInfo);
    if (partInfo.type !== PartType.ELEMENT) {
      throw new Error("fieldError() belongs on a wa-input or wa-select");
    }
  }

  render(_error: string | undefined) {
    return noChange;
  }

  update(part: ElementPart, [error]: [string | undefined]) {
    const field = part.element as WaInput | WaSelect;
    // Set on every render: Web Awesome drops it while the field is disabled
    field.customError = error ?? null;
    // A wa-input marks only itself invalid, and screen readers don't see
    // that: the textbox they read is the <input> inside it. Until Web Awesome
    // sets aria-invalid there itself, do it once that input has caught up.
    // A wa-select has no such input: it marks its combobox itself.
    void field.updateComplete.then(() => {
      field.input?.setAttribute("aria-invalid", String(!!field.customError));
    });
    return noChange;
  }
}

/**
 * Give a wa-input or wa-select an error, or none for undefined. Put the same
 * message in its hint slot, so the field describes itself with it, and
 * include `fieldErrorStyles` so the field looks invalid.
 */
export const fieldError = directive(FieldErrorDirective);

// mdi:alert-circle, from a file: the app's CSP blocks data: images
const errorIcon = css`url("/assets/icons/alert-circle.svg")`;

/**
 * A field with an error from `fieldError()`: an error-coloured border and
 * hint, and an icon, so the error doesn't read as another grey hint even
 * without its colour.
 */
export const fieldErrorStyles = css`
  wa-input[custom-error],
  wa-select[custom-error] {
    --wa-form-control-border-color: var(--ha-error-color);
    --wa-form-control-hint-color: var(--ha-error-color);
  }

  wa-input[custom-error] > [slot="hint"]::before,
  wa-select[custom-error] > [slot="hint"]::before {
    content: "";
    display: inline-block;
    width: 1.25em;
    height: 1.25em;
    margin-inline-end: 0.25em;
    vertical-align: -0.3em;
    background-color: currentColor;
    -webkit-mask: ${errorIcon} center / contain no-repeat;
    mask: ${errorIcon} center / contain no-repeat;
  }

  /* Forced colors would paint the mask's background like the page */
  @media (forced-colors: active) {
    wa-input[custom-error] > [slot="hint"]::before,
    wa-select[custom-error] > [slot="hint"]::before {
      forced-color-adjust: none;
      background-color: CanvasText;
    }
  }
`;
