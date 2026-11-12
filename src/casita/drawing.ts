export type Point = readonly [number, number];

export const HOUSE_PATH =
  "M120,109.38c0,4.12-3.38,7.5-7.5,7.5H7.5c-4.12,0-7.5-3.38-7.5-7.5v-45c0-4.12,2.39-9.89,5.3-12.8L54.7,2.19c2.92-2.92,7.69-2.92,10.61,0l49.39,49.39c2.92,2.92,5.3,8.68,5.3,12.8v45Z";
export const FACE_COLOR = "#f2f4f9";
export const PIVOT: Point = [60, 116.88];
export const LEFT_EYE: Point = [33, 65.88];
export const RIGHT_EYE: Point = [87, 65.88];
export const EYE_RADIUS = 8;

export const QUESTION_PATH =
  "M111.91,12.57c0,2.03-.66,3.7-1.99,5.03-.69.69-1.37,1.31-2.05,1.87-.85.69-1.46,1.25-1.81,1.68s-.56.9-.62,1.4v.69h-4.52v-.91c.02-.48.09-.93.22-1.35s.27-.78.44-1.09.42-.64.74-1,.63-.66.92-.92.68-.6,1.19-1.02c.73-.6,1.29-1.09,1.67-1.47s.68-.8.91-1.23.34-.9.34-1.4c0-.86-.3-1.59-.89-2.18s-1.37-.89-2.34-.89c-1.04,0-1.9.33-2.58,1s-1.03,1.48-1.03,2.45h-4.58c0-2.25.78-4.14,2.34-5.67s3.5-2.29,5.82-2.29c1.44,0,2.75.29,3.93.88s2.13,1.44,2.84,2.56c.71,1.12,1.06,2.41,1.06,3.86ZM106.06,26.89c0,.71-.25,1.3-.76,1.78s-1.16.72-1.95.72-1.4-.24-1.91-.73-.77-1.07-.77-1.77.26-1.3.77-1.79,1.15-.74,1.91-.74,1.4.25,1.93.74.79,1.09.79,1.79Z";
export const BUBBLES: readonly (readonly [number, number, number])[] = [
  [91.66, 28.34, 3.66],
  [100.8, 19.2, 5.49],
  [112.69, 7.31, 7.31],
];

export const clamp = (v: number, min: number, max: number) =>
  v < min ? min : v > max ? max : v;
export const clamp01 = (v: number) => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => {
  const u = clamp01(t);
  return u * u * (3 - 2 * u);
};
export const round = (v: number) =>
  Math.abs(v) < 0.005 ? "0" : String(Math.round(v * 100) / 100);

function starPath(outer: number, inner: number): string {
  let d = "";
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 ? inner : outer;
    d += `${i ? "L" : "M"}${round(r * Math.cos(a))},${round(r * Math.sin(a))}`;
  }
  return `${d}Z`;
}

export const PARTICLE_PATHS = {
  heart:
    "M0,-9.77c-3.12,-3.12 -8.19,-3.12 -11.31,0c-3.12,3.12 -3.12,8.19 0,11.31L0,12.86L11.31,1.54c3.12,-3.12 3.12,-8.19 0,-11.31c-3.12,-3.12 -8.19,-3.12 -11.31,0Z",
  star: starPath(6.4, 2.6),
};

export function polygonPath(points: readonly Point[]): string {
  if (points.length < 3) return "";
  return `${points
    .map(([x, y], i) => `${i ? "L" : "M"}${round(x)},${round(y)}`)
    .join("")}Z`;
}

/**
 * The region between a top and a bottom curve. Each curve rises or dips by
 * its height over its half width, as one bump with rounded corners.
 */
export interface Mouth {
  /** Size, 0 hides the mouth */
  s: number;
  tY: number;
  tR: number;
  tA: number;
  tH: number;
  bY: number;
  bR: number;
  bA: number;
  bH: number;
  /** How far the tongue is out, 0 to 1 */
  tongue: number;
  tgX: number;
  tgY: number;
  /** Negative when the tongue sticks up */
  tgH: number;
}

const MOUTH_X = 60;
const MOUTH_POINTS = 90;
const TONGUE_POINTS = 40;

function bump(x: number, c: number, a: number, h: number) {
  if (a <= 1e-6 || h <= 1e-6) return 0;
  const d = Math.abs(x - c);
  if (d > a) return 0;
  const corner = Math.min(h, a);
  const flat = a - corner;
  if (d <= flat) return h;
  const q = d - flat;
  return h - corner + Math.sqrt(Math.max(0, corner * corner - q * q));
}

function curve(
  cx: number,
  y: number,
  halfWidth: number,
  bumpWidth: number,
  height: number,
  count: number,
  reverse: boolean
): Point[] {
  const R = Math.max(0, halfWidth);
  const a = Math.max(0, bumpWidth);
  const sign = height < 0 ? -1 : 1;
  return Array.from({ length: count }, (_, i): Point => {
    const k = reverse ? count - 1 - i : i;
    const x = cx - R * Math.cos((Math.PI * k) / (count - 1));
    return [x, y + sign * bump(x, cx, a, Math.abs(height))];
  });
}

function scaleMouth(points: Point[], m: Mouth): Point[] {
  if (Math.abs(m.s - 1) < 1e-4) return points;
  const cy =
    (m.tY + m.bY) / 2 + (Math.max(m.tH, m.bH, 0) + Math.min(m.tH, m.bH, 0)) / 2;
  return points.map(([x, y]) => [
    MOUTH_X + (x - MOUTH_X) * m.s,
    cy + (y - cy) * m.s,
  ]);
}

export function mouthOutline(m: Mouth): Point[] {
  if (m.s <= 0.01) return [];
  return scaleMouth(
    [
      ...curve(MOUTH_X, m.tY, m.tR, m.tA, m.tH, MOUTH_POINTS, false),
      ...curve(MOUTH_X, m.bY, m.bR, m.bA, m.bH, MOUTH_POINTS, true),
    ],
    m
  );
}

export function tongueOutline(m: Mouth): Point[] {
  if (m.tongue <= 0.01 || m.s <= 0.01) return [];
  const R = 12 * m.tongue;
  const H = Math.abs(m.tgH) * m.tongue;
  const points =
    m.tgH < 0
      ? [
          ...curve(m.tgX, m.tgY, R, R, -H, TONGUE_POINTS, false),
          ...curve(m.tgX, m.tgY + 1.2, R, R, 0, TONGUE_POINTS, true),
        ]
      : [
          ...curve(m.tgX, m.tgY - 1.2, R, R, 0, TONGUE_POINTS, false),
          ...curve(m.tgX, m.tgY, R, R, H, TONGUE_POINTS, true),
        ];
  return scaleMouth(points, m);
}
