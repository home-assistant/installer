import { css, noChange, unsafeCSS } from "lit";
import {
  Directive,
  PartType,
  directive,
  type ElementPart,
  type PartInfo,
} from "lit/directive.js";
import type WaInput from "@home-assistant/webawesome/dist/components/input/input.js";

class FieldErrorDirective extends Directive {
  constructor(partInfo: PartInfo) {
    super(partInfo);
    if (partInfo.type !== PartType.ELEMENT) {
      throw new Error("fieldError() belongs on a wa-input element");
    }
  }

  render(_error: string | undefined) {
    return noChange;
  }

  update(part: ElementPart, [error]: [string | undefined]) {
    const field = part.element as WaInput;
    // Set on every render: Web Awesome drops it while the field is disabled
    field.customError = error ?? null;
    // Web Awesome marks only itself invalid, and screen readers don't see
    // that: the textbox they read is the <input> inside it. Until Web Awesome
    // sets aria-invalid there itself, do it once that input has caught up.
    void field.updateComplete.then(() => {
      field.input?.setAttribute("aria-invalid", String(!!field.customError));
    });
    return noChange;
  }
}

/**
 * Give a wa-input an error, or none for undefined. Put the same message in
 * its hint slot, so the field describes itself with it, and include
 * `fieldErrorStyles` so the field looks invalid.
 */
export const fieldError = directive(FieldErrorDirective);

// mdi:alert-circle
const errorIcon = unsafeCSS(
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M13,13H11V7H13M13,17H11V15H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z'/%3E%3C/svg%3E")`
);

/**
 * A wa-input with an error from `fieldError()`: an error-coloured border and
 * hint, and an icon, so the error doesn't read as another grey hint even
 * without its colour.
 */
export const fieldErrorStyles = css`
  wa-input[custom-error] {
    --wa-form-control-border-color: var(--ha-error-color, #b30532);
    --wa-form-control-hint-color: var(--ha-error-color, #b30532);
  }

  wa-input[custom-error] > [slot="hint"]::before {
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
    wa-input[custom-error] > [slot="hint"]::before {
      forced-color-adjust: none;
      background-color: CanvasText;
    }
  }
`;
