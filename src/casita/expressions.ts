import { hexToLab } from "./color.js";
import type { Mouth } from "./drawing.js";

const COLORS = { blue: "#18bcf2", orange: "#f7931e" } as const;

const MOUTH_FIELDS = [
  "s",
  "tY",
  "tR",
  "tA",
  "tH",
  "bY",
  "bR",
  "bA",
  "bH",
  "tongue",
  "tgX",
  "tgY",
  "tgH",
] as const satisfies readonly (keyof Mouth)[];

export const PARAMS = [
  "body.x",
  "body.y",
  "body.rot",
  "body.sx",
  "body.sy",
  "body.skew",
  "color.L",
  "color.a",
  "color.b",
  "face.x",
  "face.y",
  "eyes.x",
  "eyes.y",
  "dot.s",
  ...MOUTH_FIELDS.map((f) => `mouth.${f}` as const),
  "acc.bubbles",
  "acc.question",
] as const;
export type Param = (typeof PARAMS)[number];
export type Values = Record<Param, number>;
export type Targets = Partial<Values>;

export function values(fill: (param: Param) => number): Values {
  const out = {} as Values;
  for (const param of PARAMS) out[param] = fill(param);
  return out;
}

type Group = "body" | "color" | "face" | "gaze" | "dot" | "mouth" | "acc";

function groupOf(param: Param): Group {
  const [part] = param.split(".");
  switch (part) {
    case "body":
    case "color":
    case "face":
    case "mouth":
    case "acc":
      return part;
    case "eyes":
      return "gaze";
    case "dot":
      return "dot";
    default:
      throw new Error(`Unknown parameter ${param}`);
  }
}

/** Stiffness and damping */
export type Spring = readonly [number, number];

const GROUP_SPRINGS: Record<Group, Spring> = {
  body: [200, 17],
  color: [90, 19],
  face: [190, 24],
  gaze: [650, 46],
  dot: [480, 34],
  mouth: [360, 29],
  acc: [230, 15],
};

const PRESETS = {
  bouncy: [300, 13],
  heavy: [70, 12],
} as const satisfies Record<string, Spring>;
export type SpringPreset = keyof typeof PRESETS;

const PRESET_GROUPS: readonly Group[] = ["body", "dot", "mouth", "acc"];

const GROUP_DELAYS: Record<Group, number> = {
  body: 0,
  color: 0,
  face: 0,
  gaze: 60,
  dot: 60,
  mouth: 110,
  acc: 170,
};

export function springFor(param: Param, preset?: SpringPreset): Spring {
  const group = groupOf(param);
  return preset && PRESET_GROUPS.includes(group)
    ? PRESETS[preset]
    : GROUP_SPRINGS[group];
}

export const delayFor = (param: Param) => GROUP_DELAYS[groupOf(param)];

export interface Life {
  breath: { rate: number; amp: number };
  blink: {
    on: boolean;
    min: number;
    max: number;
    /** Chance that a blink comes twice */
    double: number;
    close: number;
    hold: number;
    open: number;
  };
  glance: {
    on: boolean;
    min: number;
    max: number;
    range: number;
    jitter: number;
  };
  sway: { amp: number; rate: number };
}

type LifeChanges = { [K in keyof Life]?: Partial<Life[K]> };

// Tuned for Casita at about 120px, where smaller motion goes unnoticed
const DEFAULT_LIFE: Life = {
  breath: { rate: 0.23, amp: 0.03 },
  blink: {
    on: true,
    min: 2200,
    max: 5600,
    double: 0.18,
    close: 95,
    hold: 45,
    open: 150,
  },
  glance: { on: true, min: 650, max: 2600, range: 3.6, jitter: 0.18 },
  sway: { amp: 1.4, rate: 0.28 },
};

function lifeWith(changes: LifeChanges = {}): Life {
  return {
    breath: { ...DEFAULT_LIFE.breath, ...changes.breath },
    blink: { ...DEFAULT_LIFE.blink, ...changes.blink },
    glance: { ...DEFAULT_LIFE.glance, ...changes.glance },
    sway: { ...DEFAULT_LIFE.sway, ...changes.sway },
  };
}

type MouthShape = Partial<Mouth>;

const open = (): MouthShape => ({
  tY: 80.88,
  tR: 20,
  tA: 20,
  tH: 0,
  bY: 80.88,
  bR: 20,
  bA: 20,
  bH: 20,
});
const frown = (): MouthShape => ({
  tY: 96.88,
  tR: 19,
  tA: 19,
  tH: -19,
  bY: 96.88,
  bR: 13,
  bA: 13,
  bH: -13,
});
const tongueOut = (): MouthShape => ({
  tY: 88.88,
  tR: 20,
  tA: 20,
  tH: 0,
  bY: 94.88,
  bR: 20,
  bA: 20,
  bH: 0,
  tongue: 1,
  tgX: 68,
  tgY: 88.88,
  tgH: -12,
});

interface Pose {
  color?: keyof typeof COLORS;
  /** One dot between the eyes */
  dot?: number;
  mouth: MouthShape;
  bubbles?: number;
  question?: number;
  spring?: SpringPreset;
  life?: LifeChanges;
}

const POSES = {
  happy: {
    mouth: open(),
    spring: "bouncy",
    life: { breath: { rate: 0.3, amp: 0.04 } },
  },
  focusing: {
    mouth: tongueOut(),
    bubbles: 1,
    life: {
      glance: { range: 1.8, min: 1400, max: 3600 },
      blink: { min: 3500, max: 7000 },
    },
  },
  loading: {
    dot: 1,
    mouth: { ...open(), s: 0 },
    life: { blink: { on: false }, glance: { on: false } },
  },
  sad: {
    color: "orange",
    mouth: frown(),
    spring: "heavy",
    life: {
      breath: { rate: 0.17, amp: 0.025 },
      glance: { range: 2.4, min: 1500, max: 4000 },
      blink: { close: 140, open: 240 },
    },
  },
  problem: { color: "orange", mouth: frown(), question: 1 },
} satisfies Record<string, Pose>;

export type Expression = keyof typeof POSES;

export const EXPRESSIONS = Object.keys(POSES) as Expression[];

export const isExpression = (value: string): value is Expression =>
  Object.prototype.hasOwnProperty.call(POSES, value);

export interface Look {
  targets: Targets;
  spring?: SpringPreset;
  life: Life;
}

function lookOf(pose: Pose): Look {
  const [L, a, b] = hexToLab(COLORS[pose.color ?? "blue"]);
  const targets: Targets = {
    "body.x": 0,
    "body.y": 0,
    "body.rot": 0,
    "body.sx": 1,
    "body.sy": 1,
    "body.skew": 0,
    "color.L": L,
    "color.a": a,
    "color.b": b,
    "face.x": 0,
    "face.y": 0,
    "eyes.x": 0,
    "eyes.y": 0,
    "dot.s": pose.dot ?? 0,
    "mouth.s": 1,
    "mouth.tongue": 0,
    "acc.bubbles": pose.bubbles ?? 0,
    "acc.question": pose.question ?? 0,
  };
  // The tongue's anchor is left out when unused, so it goes back in from where it was
  for (const field of MOUTH_FIELDS) {
    const v = pose.mouth[field];
    if (v !== undefined) targets[`mouth.${field}`] = v;
  }
  return { targets, spring: pose.spring, life: lifeWith(pose.life) };
}

const LOOKS = Object.fromEntries(
  EXPRESSIONS.map((id) => [id, lookOf(POSES[id])])
) as Record<Expression, Look>;

export const lookFor = (id: Expression): Look => LOOKS[id];
