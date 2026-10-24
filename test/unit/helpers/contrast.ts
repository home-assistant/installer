// sRGB channels (0 to 1) of a computed colour, rgb() or color(srgb …), painted
// over an opaque background
function paint(color: string, background = [1, 1, 1]) {
  const [r, g, b, alpha = 1] = color.match(/[\d.]+/g)!.map(Number);
  // rgb() counts to 255, color(srgb …) to 1
  const scale = color.startsWith("color(") ? 1 : 255;
  return [r, g, b].map(
    (value, i) => (value / scale) * alpha + background[i] * (1 - alpha)
  );
}

function luminance(rgb: number[]) {
  const [r, g, b] = rgb.map((v) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  );
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

/**
 * WCAG contrast of a computed colour drawn over layers listed from the top
 * down, so a tint is blended with the page under it.
 */
export function contrast(foreground: string, ...backgrounds: string[]) {
  const base = backgrounds.reduceRight(
    (under, color) => paint(color, under),
    [1, 1, 1]
  );
  const values = [luminance(paint(foreground, base)), luminance(base)].sort(
    (a, b) => b - a
  );
  return (values[0] + 0.05) / (values[1] + 0.05);
}
