import { html } from "lit";
import type { DeviceType } from "../api/types.js";

/** The icon for a kind of drive, sized and coloured by the caller's CSS. */
export function renderDriveIcon(deviceType: DeviceType) {
  switch (deviceType) {
    case "sd_card":
      return html`
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M18 2H10L4 8V20C4 21.1 4.9 22 6 22H18C19.1 22 20 21.1 20 20V4C20 2.9 19.1 2 18 2ZM12 8H10V4H12V8ZM15 8H13V4H15V8ZM18 8H16V4H18V8Z"
          />
        </svg>
      `;
    case "usb_drive":
      // USB trident symbol
      return html`
        <svg viewBox="0 0 192.756 192.756" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M81.114 37.464l16.415-28.96 16.834 28.751-12.164.077-.174 70.181c.988-.552 2.027-1.09 3.096-1.643 6.932-3.586 15.674-8.11 15.998-28.05h-8.533V53.251h24.568V77.82h-7.611c-.334 25.049-11.627 30.892-20.572 35.519-3.232 1.672-6.012 3.111-6.975 5.68l-.09 36.683a14.503 14.503 0 0 1 10.68 14.02 14.5 14.5 0 0 1-14.533 14.532 14.5 14.5 0 0 1-14.533-14.532 14.504 14.504 0 0 1 9.454-13.628l.057-22.801c-2.873-1.613-5.62-2.704-8.139-3.705-11.142-4.43-18.705-7.441-18.857-33.4a14.381 14.381 0 0 1-10.43-13.869c0-7.946 6.482-14.428 14.428-14.428 7.946 0 14.428 6.482 14.428 14.428 0 6.488-4.21 11.889-10.004 13.74.116 20.396 5.54 22.557 13.528 25.732 1.61.641 3.303 1.312 5.069 2.114l.214-86.517-12.154.076z"
          />
        </svg>
      `;
    case "ssd":
    case "nvme":
      return html`
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M2 6C2 4.9 2.9 4 4 4H20C21.1 4 22 4.9 22 6V18C22 19.1 21.1 20 20 20H4C2.9 20 2 19.1 2 18V6ZM4 6V18H20V6H4ZM6 8H8V10H6V8ZM6 12H8V14H6V12ZM10 8H12V10H10V8ZM10 12H12V14H10V12Z"
          />
        </svg>
      `;
    case "hdd":
      return html`
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M2 6C2 4.9 2.9 4 4 4H20C21.1 4 22 4.9 22 6V18C22 19.1 21.1 20 20 20H4C2.9 20 2 19.1 2 18V6ZM4 6V18H20V6H4ZM18 15C18 15.55 17.55 16 17 16C16.45 16 16 15.55 16 15C16 14.45 16.45 14 17 14C17.55 14 18 14.45 18 15Z"
          />
        </svg>
      `;
    default:
      return html`
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M2 6C2 4.9 2.9 4 4 4H20C21.1 4 22 4.9 22 6V18C22 19.1 21.1 20 20 20H4C2.9 20 2 19.1 2 18V6ZM4 6V18H20V6H4Z"
          />
        </svg>
      `;
  }
}
