import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

/**
 * Tinted box for something the user should read before going on, such as
 * the drive erase warning. The single style every view uses for these, so
 * a warning looks the same wherever it appears.
 *
 * Slot block content (paragraphs, lists): the children are stacked with a
 * small gap, so loose text and inline elements would each get a row.
 */
@customElement("inline-notice")
export class InlineNotice extends LitElement {
  static styles = css`
    :host {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      width: 100%;
      max-width: var(--ha-content-width);
      box-sizing: border-box;
      padding: 1rem;
      background-color: var(--ha-warning-background);
      border: 1px solid var(--ha-warning-border);
      border-radius: var(--ha-small-border-radius);
      font-size: 0.875rem;
      line-height: 1.5;
      color: var(--ha-text-color);
      text-align: start;
      overflow-wrap: anywhere;
    }

    :host([variant="error"]) {
      background-color: var(--ha-error-background);
      border-color: var(--ha-error-border);
    }

    .icon {
      flex-shrink: 0;
      font-size: 1.25rem;
      /* One line of text tall, so it lines up with the first line */
      line-height: 1.3125rem;
    }

    .content {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      min-width: 0;
    }

    ::slotted(*) {
      margin: 0;
    }
  `;

  @property({ reflect: true })
  variant: "warning" | "error" = "warning";

  /** Decorative only: the text has to say what kind of notice it is. */
  @property()
  icon = "⚠️";

  render() {
    return html`
      <span class="icon" aria-hidden="true">${this.icon}</span>
      <div class="content"><slot></slot></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "inline-notice": InlineNotice;
  }
}
