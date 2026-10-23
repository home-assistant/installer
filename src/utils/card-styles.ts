import { css } from "lit";

/**
 * The frame the option, device and drive cards share: a `.card` in the card
 * colors that lights up under the pointer, gives a little when pressed, and
 * shows the focus ring when it or its host has the focus. A card that is
 * checked, as a drive radio is, keeps the lit border with a ring around it.
 * Each card adds its own layout.
 */
export const selectableCardStyles = css`
  :host {
    display: block;
    outline: none;
    cursor: pointer;
  }

  .card {
    box-sizing: border-box;
    background-color: var(--ha-card-background, #ffffff);
    border: 2px solid var(--ha-border-color, #e0e0e0);
    border-radius: var(--ha-card-border-radius, 12px);
    transition:
      border-color 0.2s ease,
      box-shadow 0.2s ease,
      transform 0.1s ease;
  }

  .card:hover {
    border-color: var(--ha-primary-color, #03a9f4);
    box-shadow: var(--ha-card-hover-shadow);
  }

  .card:active {
    transform: scale(0.98);
  }

  @media (prefers-reduced-motion: reduce) {
    .card:active {
      transform: none !important;
    }
  }

  /* A drive radio takes the focus on its host. The option and device cards
     take it on the card, and a host that hands it on doesn't match
     :focus-visible */
  :host(:focus-visible) .card,
  .card:focus-visible {
    outline: var(--wa-focus-ring);
    outline-offset: var(--wa-focus-ring-offset);
  }

  :host(:state(checked)) .card {
    border-color: var(--ha-primary-color, #03a9f4);
    box-shadow: var(--ha-card-selected-shadow);
  }

  /* Forced colors would draw every card with the same border */
  @media (forced-colors: active) {
    :host(:state(checked)) .card {
      border-color: Highlight;
    }
  }
`;

/**
 * The check on the chosen card, as a `.selected-indicator`. Where it sits is
 * up to the card.
 */
export const selectedIndicatorStyles = css`
  .selected-indicator {
    width: 24px;
    height: 24px;
    background-color: var(--ha-primary-fill, #006787);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--wa-color-brand-on-loud, white);
    font-size: 14px;
  }

  /* Forced colors would paint the circle like the card, or hide it behind a
   * backplate, leaving only a small tick */
  @media (forced-colors: active) {
    .selected-indicator {
      forced-color-adjust: none;
      background-color: Highlight;
      color: HighlightText;
    }
  }
`;
