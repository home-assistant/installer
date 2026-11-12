import { labToCss } from "./color.js";
import {
  BUBBLES,
  EYE_RADIUS,
  FACE_COLOR,
  HOUSE_PATH,
  LEFT_EYE,
  PARTICLE_PATHS,
  PIVOT,
  QUESTION_PATH,
  RIGHT_EYE,
  clamp,
  clamp01,
  lerp,
  mouthOutline,
  polygonPath,
  round,
  smooth,
  tongueOutline,
  type Point,
} from "./drawing.js";
import {
  PARAMS,
  delayFor,
  lookFor,
  springFor,
  values,
  type Expression,
  type Life,
  type Param,
  type SpringPreset,
  type Targets,
  type Values,
} from "./expressions.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const TAU = Math.PI * 2;
const STAR_COLOR = "#ffd23f";
const STEP = 1 / 240;
const GAZE_REACH = 4.2;
const FACE_FOLLOW = 0.38;

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const frac = (v: number) => v - Math.floor(v);
const backOut = (u: number) => 1 + 2.7 * (u - 1) ** 3 + 1.7 * (u - 1) ** 2;

function wobble() {
  const a = rand(0, TAU);
  const b = rand(0, TAU);
  const c = rand(0, TAU);
  return (t: number) =>
    0.55 * Math.sin(t + a) +
    0.3 * Math.sin(t * 2.13 + b) +
    0.15 * Math.sin(t * 4.37 + c);
}

interface Blink {
  start: number;
  close: number;
  hold: number;
  open: number;
}

const blinkEnd = (b: Blink) => b.start + b.close + b.hold + b.open;

function openness(b: Blink, clock: number): number {
  const t = clock - b.start;
  if (t < b.close) return 1 - (t / b.close) ** 2;
  if (t < b.close + b.hold) return 0;
  const u = (t - b.close - b.hold) / b.open;
  return u >= 1 ? 1 : 1 + 2.3 * (u - 1) ** 3 + 1.3 * (u - 1) ** 2;
}

export type ParticleKind = keyof typeof PARTICLE_PATHS;

export interface BurstOptions {
  count?: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  gravity?: number;
  spread?: number;
  /** Seconds */
  life?: number;
  startSize?: number;
  endSize?: number;
  spin?: number;
  sway?: number;
}

const BURST_DEFAULTS: Record<ParticleKind, Required<BurstOptions>> = {
  heart: {
    count: 1,
    x: 60,
    y: 30,
    vx: 0,
    vy: -22,
    gravity: 0,
    spread: 18,
    life: 1.9,
    startSize: 0.22,
    endSize: 0.42,
    spin: 0,
    sway: 4,
  },
  star: {
    count: 1,
    x: 60,
    y: 30,
    vx: 0,
    vy: 0,
    gravity: 0,
    spread: 0,
    life: 2.2,
    startSize: 0.75,
    endSize: 0.75,
    spin: 160,
    sway: 0,
  },
};

interface Particle {
  el: SVGPathElement;
  age: number;
  life: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  gravity: number;
  rot: number;
  spin: number;
  startSize: number;
  endSize: number;
  sway: number;
  swayPhase: number;
}

function make<K extends keyof SVGElementTagNameMap>(
  tag: K,
  parent: Element,
  attrs: Record<string, string | number> = {}
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) {
    el.setAttribute(name, String(value));
  }
  parent.append(el);
  return el;
}

export interface CasitaFaceOptions {
  expression?: Expression;
  /** Without it, Casita holds each expression still */
  animated?: boolean;
}

export class CasitaFace {
  private readonly _svg: SVGSVGElement;
  private readonly _animated: boolean;
  private _expression: Expression;
  private _life: Life;

  private readonly _pose: Values;
  private readonly _value: Values;
  private readonly _velocity: Values;
  private readonly _target: Values;
  private readonly _out: Values;
  private readonly _stiffness: Values;
  private readonly _damping: Values;
  private _pending: { at: number; param: Param; value: number }[] = [];

  private _clock = 0;
  private _frame = 0;
  private _lastTime = 0;

  private _lookTarget: Point | null = null;
  private _lookUntil = 0;
  private _glance: Point = [0, 0];
  private _jitter: Point = [0, 0];
  private _nextGlance = 400;
  private _nextJitter = 0;
  private _nextBlink = rand(800, 2500);
  private _nextFidget = rand(3000, 6000);
  private _blink: Blink | null = null;
  private _secondBlinkAt: number | null = null;
  private _breathPhase = rand(0, TAU);
  private readonly _breathNoise = wobble();
  private readonly _swayNoise = wobble();
  private readonly _bobNoise = wobble();
  private _squash: { amount: number; until: number } | null = null;
  private _jump: { speed: number; at: number } | null = null;

  private readonly _particles: Particle[] = [];
  private readonly _spareParticles: SVGPathElement[] = [];
  private _bodyColor = FACE_COLOR;
  private _colorKey = "";
  private _mouthKey = "";

  private readonly _body: SVGGElement;
  private readonly _house: SVGPathElement;
  private readonly _face: SVGGElement;
  private readonly _eyes: readonly [SVGEllipseElement, SVGEllipseElement];
  private readonly _dot: SVGCircleElement;
  private readonly _mouth: SVGPathElement;
  private readonly _tongue: SVGPathElement;
  private readonly _bubbles: {
    el: SVGCircleElement;
    x: number;
    y: number;
    r: number;
  }[];
  private readonly _question: SVGPathElement;
  private readonly _particleLayer: SVGGElement;

  constructor(svg: SVGSVGElement, options: CasitaFaceOptions = {}) {
    this._svg = svg;
    this._animated = options.animated ?? true;
    this._expression = options.expression ?? "happy";
    const look = lookFor(this._expression);
    this._life = look.life;

    const start: Targets = {
      "mouth.tgX": 68,
      "mouth.tgY": 86.88,
      "mouth.tgH": 12,
      ...look.targets,
    };
    this._pose = values((p) => start[p] ?? 0);
    this._value = { ...this._pose };
    this._out = { ...this._pose };
    this._target = { ...this._pose };
    this._velocity = values(() => 0);
    this._stiffness = values(() => 0);
    this._damping = values(() => 0);
    this._setSprings(look.spring);

    svg.replaceChildren();
    const world = make("g", svg);
    this._body = make("g", world);
    this._house = make("path", this._body, { d: HOUSE_PATH });
    this._face = make("g", this._body, { fill: FACE_COLOR });
    this._eyes = [
      make("ellipse", this._face, { rx: EYE_RADIUS }),
      make("ellipse", this._face, { rx: EYE_RADIUS }),
    ];
    this._dot = make("circle", this._face, { r: 0 });
    this._mouth = make("path", this._face);
    this._tongue = make("path", this._face);
    this._bubbles = BUBBLES.map(([x, y, r]) => ({
      el: make("circle", this._body, { cx: x, cy: y, r: 0 }),
      x,
      y,
      r,
    }));
    this._question = make("path", this._body, { d: QUESTION_PATH });
    this._particleLayer = make("g", world);

    this._render(this._value, 1);
  }

  get running(): boolean {
    return this._frame !== 0;
  }

  /** Returns whether the expression changed */
  setExpression(id: Expression): boolean {
    if (id === this._expression) return false;
    const look = lookFor(id);
    this._expression = id;
    this._life = look.life;
    this._setSprings(look.spring);
    this._pending = [];
    for (const param of PARAMS) {
      const value = look.targets[param];
      if (value === undefined) continue;
      const delay = this._animated ? delayFor(param) : 0;
      if (delay > 0) {
        this._pending.push({ at: this._clock + delay, param, value });
      } else {
        this._pose[param] = value;
      }
    }
    if (!this._animated) {
      Object.assign(this._value, this._pose);
      this._render(this._value, 1);
    }
    return true;
  }

  lookAt(point: Point | null, forMs: number) {
    this._lookTarget = point;
    this._lookUntil = this._clock + forMs;
  }

  toSvgPoint(clientX: number, clientY: number): Point | null {
    const ctm = this._svg.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return [p.x, p.y];
  }

  hop(strength = 1) {
    if (!this.running) return;
    this._squash = { amount: 0.1 * strength, until: this._clock + 110 };
    this._jump = { speed: -260 * strength, at: this._clock + 110 };
  }

  burst(kind: ParticleKind, options: BurstOptions = {}) {
    if (!this.running) return;
    const o = { ...BURST_DEFAULTS[kind], ...options };
    const many = o.count > 1;
    for (let i = 0; i < o.count; i++) {
      const [x, y] = this._houseToSvg(
        o.x + (o.spread ? rand(-o.spread / 2, o.spread / 2) : 0),
        o.y + (o.spread ? rand(-o.spread / 6, o.spread / 6) : 0)
      );
      const el =
        this._spareParticles.pop() ?? make("path", this._particleLayer);
      el.setAttribute("d", PARTICLE_PATHS[kind]);
      el.setAttribute("fill", kind === "heart" ? this._bodyColor : STAR_COLOR);
      el.style.display = "";
      this._particles.push({
        el,
        age: 0,
        life: o.life * (many ? rand(0.85, 1.15) : 1),
        x,
        y,
        vx: o.vx + (o.spread ? rand(-4, 4) : 0),
        vy: o.vy * (many ? rand(0.8, 1.2) : 1),
        gravity: o.gravity,
        rot: 0,
        spin: o.spin,
        startSize: o.startSize,
        endSize: o.endSize,
        sway: o.sway,
        swayPhase: rand(0, TAU),
      });
    }
  }

  start() {
    if (this._frame || !this._animated) return;
    this._lastTime = 0;
    this._frame = requestAnimationFrame(this._onFrame);
  }

  stop() {
    cancelAnimationFrame(this._frame);
    this._frame = 0;
  }

  destroy() {
    this.stop();
    this._svg.replaceChildren();
  }

  step(dt: number) {
    const delta = clamp(dt, 0, 0.05);
    this._clock += delta * 1000;
    const clock = this._clock;

    this._pending = this._pending.filter((p) => {
      if (clock < p.at) return true;
      this._pose[p.param] = p.value;
      return false;
    });
    if (this._jump && clock >= this._jump.at) {
      this._velocity["body.y"] += this._jump.speed;
      this._jump = null;
    }
    if (this._lookTarget && clock > this._lookUntil) this._lookTarget = null;
    this._scheduleLife();

    const target = Object.assign(this._target, this._pose);
    if (this._squash && clock < this._squash.until) {
      target["body.sy"] -= this._squash.amount;
      target["body.sx"] += this._squash.amount * 0.6;
    } else {
      this._squash = null;
    }
    this._aimEyes(target);

    const steps = Math.max(1, Math.ceil(delta / STEP));
    const h = delta / steps;
    for (let s = 0; s < steps; s++) {
      for (const p of PARAMS) {
        const accel =
          this._stiffness[p] * (target[p] - this._value[p]) -
          this._damping[p] * this._velocity[p];
        this._velocity[p] += accel * h;
        this._value[p] += this._velocity[p] * h;
      }
    }

    const out = Object.assign(this._out, this._value);
    const t = clock / 1000;
    const { breath, sway } = this._life;
    this._breathPhase +=
      delta * TAU * breath.rate * (1 + 0.18 * this._breathNoise(t * 0.7));
    const b =
      Math.sin(this._breathPhase + 0.25 * Math.sin(this._breathPhase)) *
      breath.amp;
    out["body.sy"] *= 1 + b;
    out["body.sx"] *= 1 - b * 0.55;
    // Mostly a lean, so the base stays planted
    const sw = sway.amp * this._swayNoise(t * TAU * sway.rate * 0.35);
    out["body.rot"] += sw * 0.3;
    out["body.skew"] -= sw * 1.4;
    out["body.y"] += 0.9 * this._bobNoise(t * TAU * sway.rate * 0.27);

    out["body.sy"] = clamp(out["body.sy"], 0.86, 1.12);
    out["body.sx"] = clamp(out["body.sx"], 0.94, 1.08);
    out["body.y"] = Math.min(out["body.y"], 0);

    let eyesOpen = 1;
    if (this._blink) {
      eyesOpen = openness(this._blink, clock);
      if (clock > blinkEnd(this._blink)) this._blink = null;
    }

    this._render(out, eyesOpen);
    this._moveParticles(delta);
  }

  private readonly _onFrame = (time: number) => {
    this._frame = requestAnimationFrame(this._onFrame);
    const dt = this._lastTime ? (time - this._lastTime) / 1000 : 0;
    this._lastTime = time;
    this.step(dt);
  };

  private _setSprings(preset: SpringPreset | undefined) {
    for (const p of PARAMS) {
      const [k, c] = springFor(p, preset);
      this._stiffness[p] = k;
      this._damping[p] = c;
    }
  }

  private _startBlink(speed = 1): number {
    const { close, hold, open } = this._life.blink;
    this._blink = {
      start: this._clock,
      close: close * speed,
      hold,
      open: open * speed,
    };
    return blinkEnd(this._blink) - this._clock;
  }

  private _scheduleLife() {
    const clock = this._clock;
    const { glance, blink } = this._life;
    if (glance.on && !this._lookTarget && clock >= this._nextGlance) {
      const previousX = this._glance[0];
      if (Math.random() < 0.35) {
        this._glance = [0, 0];
      } else {
        const a = rand(0, TAU);
        const r = rand(0.35, 1) * glance.range;
        this._glance = [Math.cos(a) * r, Math.sin(a) * r * 0.6];
      }
      this._nextGlance = clock + rand(glance.min, glance.max);
      const far = Math.abs(this._glance[0] - previousX) > glance.range * 0.9;
      if (blink.on && far && Math.random() < 0.25) this._startBlink();
    }
    if (clock >= this._nextJitter) {
      const j = glance.jitter;
      this._jitter = [rand(-j, j), rand(-j, j) * 0.7];
      this._nextJitter = clock + rand(140, 420);
    }
    if (blink.on && clock >= this._nextBlink) {
      const duration = this._startBlink();
      if (Math.random() < blink.double) {
        this._secondBlinkAt = clock + duration + rand(50, 110);
      }
      this._nextBlink = clock + rand(blink.min, blink.max);
    }
    if (this._secondBlinkAt !== null && clock >= this._secondBlinkAt) {
      this._secondBlinkAt = null;
      if (blink.on) this._startBlink(0.8);
    }
    if (clock >= this._nextFidget) {
      this._nextFidget = clock + rand(4000, 9000);
      if (!glance.on || this._lookTarget) return;
      if (Math.random() < 0.4) {
        this.hop(0.35);
      } else {
        const side = Math.random() < 0.5 ? -1 : 1;
        this._glance = [side * glance.range * 1.2, rand(-0.5, 0.5)];
        this._nextGlance = clock + rand(900, 1600);
      }
    }
  }

  private _aimEyes(target: Values) {
    const look = this._lookTarget;
    const { glance } = this._life;
    let gx = 0;
    let gy = 0;
    if (look) {
      const dx = look[0] - PIVOT[0] - this._value["body.x"];
      const dy = look[1] - 70 - this._value["body.y"];
      const d = Math.hypot(dx, dy);
      if (d > 1e-3) {
        const reach = (d / (d + 38)) * GAZE_REACH;
        gx = (dx / d) * reach;
        gy = (dy / d) * reach * 0.75;
      }
    } else if (glance.on) {
      [gx, gy] = this._glance;
    }
    if (look || glance.on) {
      gx += this._jitter[0];
      gy += this._jitter[1];
    }
    target["eyes.x"] += gx;
    target["eyes.y"] += gy;
    target["face.x"] += gx * FACE_FOLLOW;
    target["face.y"] += gy * FACE_FOLLOW;
    if (!look) {
      const lean = gx / GAZE_REACH;
      target["body.rot"] += lean * 4;
      target["body.skew"] -= lean * 1.2;
      target["body.x"] += lean * 2;
    }
  }

  private _houseToSvg(hx: number, hy: number): Point {
    const o = this._out;
    const sx = (hx - PIVOT[0]) * o["body.sx"];
    const sy = (hy - PIVOT[1]) * o["body.sy"];
    const x = sx + sy * Math.tan((o["body.skew"] * Math.PI) / 180);
    const a = (o["body.rot"] * Math.PI) / 180;
    return [
      PIVOT[0] + o["body.x"] + x * Math.cos(a) - sy * Math.sin(a),
      PIVOT[1] + o["body.y"] + x * Math.sin(a) + sy * Math.cos(a),
    ];
  }

  private _moveParticles(dt: number) {
    for (let i = this._particles.length - 1; i >= 0; i--) {
      const p = this._particles[i];
      if (!p) continue;
      p.age += dt;
      const u = p.age / p.life;
      if (u >= 1) {
        p.el.style.display = "none";
        this._spareParticles.push(p.el);
        this._particles.splice(i, 1);
        continue;
      }
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      const x = p.x + p.sway * Math.sin(p.age * 3 + p.swayPhase);
      const pop = u < 0.15 ? 1 + 0.25 * Math.sin((u / 0.15) * Math.PI) : 1;
      const size = lerp(p.startSize, p.endSize, smooth(u)) * pop;
      const opacity = clamp01(u / 0.12) * (1 - smooth((u - 0.65) / 0.35));
      p.el.setAttribute(
        "transform",
        `translate(${round(x)} ${round(p.y)}) rotate(${round(p.rot)}) scale(${round(size)})`
      );
      p.el.setAttribute("opacity", round(opacity));
    }
  }

  private _render(o: Values, eyesOpen: number) {
    const colorKey = `${o["color.L"].toFixed(4)} ${o["color.a"].toFixed(4)} ${o["color.b"].toFixed(4)}`;
    if (colorKey !== this._colorKey) {
      this._colorKey = colorKey;
      this._bodyColor = labToCss(o["color.L"], o["color.a"], o["color.b"]);
      this._house.setAttribute("fill", this._bodyColor);
    }
    const [px, py] = PIVOT;
    this._body.setAttribute(
      "transform",
      `translate(${round(o["body.x"] + px)} ${round(o["body.y"] + py)}) rotate(${round(o["body.rot"])}) skewX(${round(o["body.skew"])}) scale(${o["body.sx"].toFixed(4)} ${o["body.sy"].toFixed(4)}) translate(${-px} ${-py})`
    );
    this._face.setAttribute(
      "transform",
      `translate(${round(o["face.x"])} ${round(o["face.y"])})`
    );

    const [ex, ey] = [o["eyes.x"], o["eyes.y"]];
    const dot = Math.max(0, o["dot.s"]);
    const wave = (i: number) =>
      this._animated
        ? -4 *
          clamp01(dot) *
          Math.max(0, Math.sin(this._clock / 160 - i * 0.9)) ** 2
        : 0;
    const ry = round(EYE_RADIUS * Math.max(0.1, eyesOpen));
    for (const [el, [x, y], i] of [
      [this._eyes[0], LEFT_EYE, 0],
      [this._eyes[1], RIGHT_EYE, 2],
    ] as const) {
      el.setAttribute("cx", round(x + ex));
      el.setAttribute("cy", round(y + ey + wave(i)));
      el.setAttribute("ry", ry);
    }
    this._dot.setAttribute("cx", round(60 + ex));
    this._dot.setAttribute("cy", round(LEFT_EYE[1] + ey + wave(1)));
    this._dot.setAttribute("r", round(EYE_RADIUS * dot));

    const mouth = {
      s: o["mouth.s"],
      tY: o["mouth.tY"],
      tR: o["mouth.tR"],
      tA: o["mouth.tA"],
      tH: o["mouth.tH"],
      bY: o["mouth.bY"],
      bR: o["mouth.bR"],
      bA: o["mouth.bA"],
      bH: o["mouth.bH"],
      tongue: o["mouth.tongue"],
      tgX: o["mouth.tgX"],
      tgY: o["mouth.tgY"],
      tgH: o["mouth.tgH"],
    };
    const mouthKey = Object.values(mouth).map(round).join(" ");
    if (mouthKey !== this._mouthKey) {
      this._mouthKey = mouthKey;
      this._mouth.setAttribute("d", polygonPath(mouthOutline(mouth)));
      this._tongue.setAttribute("d", polygonPath(tongueOutline(mouth)));
    }

    this._renderBubbles(o["acc.bubbles"]);
    this._renderQuestion(o["acc.question"]);
  }

  private _renderBubbles(amount: number) {
    const t = this._clock / 1000;
    const cycle = frac(t / 3.4);
    const vanish = 1 - smooth((cycle - 0.84) / 0.12);
    this._bubbles.forEach(({ el, x, y, r }, i) => {
      let s = Math.max(0, (amount - i * 0.25) / (1 - i * 0.25));
      let dx = 0;
      let dy = 0;
      if (this._animated && s > 0) {
        const u = clamp01((cycle - 0.06 - i * 0.16) / 0.14);
        s *= u > 0 ? backOut(u) * vanish : 0;
        dx = 1.2 * Math.sin(t * 1.3 + i * 1.7);
        dy = -2.2 * Math.sin(t * 1.8 - i * 0.9) - i * 1.5 * cycle;
      }
      el.setAttribute("r", round(r * Math.max(0, s)));
      el.setAttribute("cx", round(x + dx));
      el.setAttribute("cy", round(y + dy));
      el.setAttribute("fill", this._bodyColor);
    });
  }

  private _renderQuestion(amount: number) {
    this._question.style.display = amount > 0.005 ? "" : "none";
    if (amount <= 0.005) return;
    const t = this._clock / 1000;
    const rot = this._animated ? 9 * Math.sin(t * 2.2) : 0;
    const dy = this._animated ? -1.4 * Math.abs(Math.sin(t * 2.2)) : 0;
    this._question.setAttribute(
      "transform",
      `translate(104.5 ${round(29.4 + dy)}) rotate(${round(rot)}) scale(${round(Math.max(0, amount))}) translate(-104.5 -29.4)`
    );
    this._question.setAttribute("fill", this._bodyColor);
  }
}
