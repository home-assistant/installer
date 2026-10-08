import { html, svg } from "lit";

export function renderCasitaThinking(text: string) {
  return html`
    <div style="position: relative; width: 100%; height: 100%;">
      ${svg`
          <svg class="casita-mascot" viewBox="0 -20 160 136.88" xmlns="http://www.w3.org/2000/svg">
            <!-- House body -->
            <path fill="#18bcf2" d="M120,109.38c0,4.12-3.38,7.5-7.5,7.5H7.5c-4.12,0-7.5-3.38-7.5-7.5v-45c0-4.12,2.39-9.89,5.3-12.8L54.7,2.19c2.92-2.92,7.69-2.92,10.61,0l49.39,49.39c2.92,2.92,5.3,8.68,5.3,12.8v45Z"/>
            <!-- Mouth with tongue (animated to the left and back) -->
            <path fill="#f2f4f9" d="M80,88.88c0-6.63-5.37-12-12-12s-12,5.37-12,12h24Z">
              <animateTransform attributeName="transform" type="translate" values="0,0;-6,0;0,0" dur="0.8s" begin="3.5s;tongueLick.end+4s" id="tongueLick"/>
            </path>
            <!-- Eyes (with blink animation) -->
            <ellipse fill="#f2f4f9" cx="33" cy="65.88" rx="8" ry="8">
              <animate attributeName="ry" values="8;1;8" dur="0.15s" begin="2.5s;blink1.end+3s" id="blink1"/>
            </ellipse>
            <ellipse fill="#f2f4f9" cx="87" cy="65.88" rx="8" ry="8">
              <animate attributeName="ry" values="8;1;8" dur="0.15s" begin="2.55s;blink2.end+3s" id="blink2"/>
            </ellipse>
            <!-- Nose/line -->
            <line fill="none" stroke="#f2f4f9" stroke-miterlimit="10" stroke-width="6" x1="40" y1="91.88" x2="80" y2="91.88"/>
            <!-- Thinking dots -->
            <circle fill="#18bcf2" cx="100" cy="25" r="5"/>
            <circle fill="#18bcf2" cx="120" cy="5" r="7"/>
            <circle fill="#18bcf2" cx="142" cy="-12" r="9"/>
          </svg>
        `}
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
        <div class="cloud-text">${text}...</div>
      </div>
    </div>
  `;
}

export function renderCasitaHappy() {
  return svg`
      <svg class="casita-mascot" viewBox="0 0 120 116.88" xmlns="http://www.w3.org/2000/svg">
        <path fill="#18bcf2" d="M120,109.38c0,4.12-3.38,7.5-7.5,7.5H7.5c-4.12,0-7.5-3.38-7.5-7.5v-45c0-4.12,2.39-9.89,5.3-12.8L54.7,2.19c2.92-2.92,7.69-2.92,10.61,0l49.39,49.39c2.92,2.92,5.3,8.68,5.3,12.8v45Z"/>
        <!-- Big smile -->
        <path fill="#f2f4f9" d="M80,80.88c0,11.05-8.95,20-20,20s-20-8.95-20-20h40Z"/>
        <!-- Happy eyes with blink -->
        <ellipse fill="#f2f4f9" cx="33" cy="65.88" rx="8" ry="8">
          <animate attributeName="ry" values="8;1;8" dur="0.15s" begin="1s;happyBlink1.end+4s" id="happyBlink1"/>
        </ellipse>
        <ellipse fill="#f2f4f9" cx="87" cy="65.88" rx="8" ry="8">
          <animate attributeName="ry" values="8;1;8" dur="0.15s" begin="1.05s;happyBlink2.end+4s" id="happyBlink2"/>
        </ellipse>
      </svg>
    `;
}

export function renderCasitaSad() {
  // Pleading Casita with animated tears and blinking eyes
  return svg`
      <svg class="casita-mascot" viewBox="0 0 120 116.88" xmlns="http://www.w3.org/2000/svg">
        <path fill="#f7931e" d="M120,109.38c0,4.12-3.38,7.5-7.5,7.5H7.5c-4.12,0-7.5-3.38-7.5-7.5v-45c0-4.12,2.39-9.89,5.3-12.8L54.7,2.19c2.92-2.92,7.69-2.92,10.61,0l49.39,49.39c2.92,2.92,5.3,8.68,5.3,12.8v45Z"/>
        <!-- Big pleading eyes with blink -->
        <ellipse fill="#f2f4f9" cx="33" cy="65.88" rx="12" ry="12">
          <animate attributeName="ry" values="12;2;12" dur="0.15s" begin="2s;sadBlink1.end+3s" id="sadBlink1"/>
        </ellipse>
        <ellipse fill="#f2f4f9" cx="87" cy="65.88" rx="12" ry="12">
          <animate attributeName="ry" values="12;2;12" dur="0.15s" begin="2.05s;sadBlink2.end+3s" id="sadBlink2"/>
        </ellipse>
        <!-- Sad mouth -->
        <path fill="none" stroke="#f2f4f9" stroke-miterlimit="10" stroke-width="6" d="M44,96.88c0-8.84,7.16-16,16-16s16,7.16,16,16"/>
        <!-- Animated tears -->
        <path class="casita-tear" fill="#f2f4f9" d="M96.24,86.64c2.34,2.34,2.34,6.14,0,8.49s-6.14,2.34-8.49,0-2.34-6.14,0-8.49l4.24-4.24,4.24,4.24Z"/>
        <path class="casita-tear delay" fill="#f2f4f9" d="M32.24,86.64c2.34,2.34,2.34,6.14,0,8.49s-6.14,2.34-8.49,0-2.34-6.14,0-8.49l4.24-4.24,4.24,4.24Z"/>
      </svg>
    `;
}
