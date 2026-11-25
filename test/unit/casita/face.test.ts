import { expect } from "@open-wc/testing";
import { CasitaFace } from "../../../src/casita/face.js";

const svgs: SVGSVGElement[] = [];

function draw(options: ConstructorParameters<typeof CasitaFace>[1] = {}) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 120 116.88");
  svg.style.width = "120px";
  svg.style.height = "120px";
  document.body.append(svg);
  svgs.push(svg);
  return { svg, face: new CasitaFace(svg, options) };
}

/** Advances by `seconds` in 1/60 s frames, calling `each` after every frame */
function run(face: CasitaFace, seconds: number, each?: () => void) {
  for (let t = 0; t < seconds; t += 1 / 60) {
    face.step(1 / 60);
    each?.();
  }
}

const house = (svg: SVGSVGElement) => svg.querySelector("path")!;
const eyes = (svg: SVGSVGElement) => [...svg.querySelectorAll("ellipse")];
const bodyY = (svg: SVGSVGElement) =>
  Number(
    /translate\([\d.-]+ ([\d.-]+)\)/.exec(
      svg.querySelector("g g")!.getAttribute("transform")!
    )![1]
  );

describe("CasitaFace", () => {
  afterEach(() => {
    for (const svg of svgs.splice(0)) svg.remove();
  });

  it("blends into a new expression", () => {
    const { svg, face } = draw({ expression: "happy" });
    expect(house(svg).getAttribute("fill")).to.equal("rgb(24 188 242)");
    expect(face.setExpression("happy")).to.be.false;
    expect(face.setExpression("problem")).to.be.true;
    run(face, 0.1);
    const halfway = house(svg).getAttribute("fill");
    expect(halfway).to.not.equal("rgb(24 188 242)");
    expect(halfway).to.not.equal("rgb(247 147 30)");
    run(face, 3);
    expect(house(svg).getAttribute("fill")).to.equal("rgb(247 147 30)");
  });

  it("puts the tongue away and the mouth back when it stops focusing", () => {
    const { svg, face } = draw({ expression: "focusing" });
    const tongue = () => svg.querySelectorAll("g g g path")[1];
    expect(tongue()!.getAttribute("d")).to.not.equal("");
    face.setExpression("loading");
    run(face, 3);
    expect(tongue()!.getAttribute("d")).to.equal("");
    face.setExpression("happy");
    run(face, 3);
    expect(svg.querySelectorAll("g g g path")[0]!.getAttribute("d")).to.match(
      /^M/
    );
  });

  it("blinks and glances around on its own", () => {
    const { svg, face } = draw({ expression: "happy" });
    let blinked = false;
    const lefts = new Set<string>();
    run(face, 12, () => {
      const [left] = eyes(svg);
      if (Number(left!.getAttribute("ry")) < 4) blinked = true;
      lefts.add(left!.getAttribute("cx")!);
    });
    expect(blinked).to.be.true;
    expect(lefts.size).to.be.greaterThan(10);
  });

  it("looks at a point for a while, then around again", () => {
    const { svg, face } = draw({ expression: "loading" });
    face.lookAt([400, 60], 1000);
    run(face, 0.5);
    expect(Number(eyes(svg)[0]!.getAttribute("cx"))).to.be.greaterThan(35);
    run(face, 1.5);
    expect(Number(eyes(svg)[0]!.getAttribute("cx"))).to.be.closeTo(33, 0.5);
  });

  it("finds a point on screen in its own coordinates", () => {
    const { svg, face } = draw();
    const box = svg.getBoundingClientRect();
    const [x, y] = face.toSvgPoint(box.left + box.width / 2, box.top)!;
    expect(x).to.be.closeTo(60, 1);
    expect(y).to.be.closeTo(-1.6, 2);
  });

  it("hops and bursts only while it runs", () => {
    const { svg, face } = draw();
    face.hop();
    face.burst("star");
    run(face, 0.3);
    expect(bodyY(svg)).to.be.closeTo(116.88, 2);
    expect(svg.querySelectorAll("g > g:last-child path")).to.have.length(0);

    face.start();
    face.hop();
    face.burst("star", { count: 3, spread: 20 });
    face.burst("heart");
    let lowest = Infinity;
    run(face, 0.5, () => (lowest = Math.min(lowest, bodyY(svg))));
    face.stop();
    expect(lowest).to.be.lessThan(112);
    const particles = [
      ...svg.querySelectorAll<SVGPathElement>("g > g:last-child path"),
    ];
    expect(particles).to.have.length(4);
    run(face, 3);
    for (const particle of particles) {
      expect(particle.style.display).to.equal("none");
    }
  });

  it("holds each expression still without animation", () => {
    const { svg, face } = draw({ expression: "focusing", animated: false });
    face.start();
    expect(face.running).to.be.false;
    face.setExpression("sad");
    expect(house(svg).getAttribute("fill")).to.equal("rgb(247 147 30)");
  });

  it("clears its drawing once destroyed", () => {
    const { svg, face } = draw();
    face.destroy();
    expect(svg.childElementCount).to.equal(0);
  });
});
