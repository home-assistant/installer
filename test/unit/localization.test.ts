import { expect } from "@open-wc/testing";
import { html, render } from "lit";
import { formatBytes } from "../../src/api/commands.js";
import { detectLanguage } from "../../src/localization/initialize.js";
import {
  type Catalog,
  formatNumber,
  getLanguage,
  localize,
  localizeBackend,
  localizeContent,
  setLanguage,
} from "../../src/localization/localize.js";

// Stands in for the catalogs shipped next to en.json
const shipped: Record<string, Catalog> = {
  de: { "common.next": "Weiter" },
  pt: { "common.next": "Seguinte" },
  "pt-BR": { "common.next": "Próximo" },
  "fr-CA": { "common.next": "Suivant" },
  nb: { "common.next": "Neste" },
  sr: { "common.next": "Даље" },
  "sr-Latn": { "common.next": "Dalje" },
  "zh-Hans": { "common.next": "下一步" },
  "zh-Hant": { "common.next": "下一頁" },
};

function loader(loaded: string[] = []) {
  return async (name: string) => {
    loaded.push(name);
    const catalog = shipped[name];
    if (!catalog) throw new Error(`${name}.json is not shipped`);
    return catalog;
  };
}

async function resolve(preferences: string[], loaded?: string[]) {
  await detectLanguage(preferences, undefined, loader(loaded));
  return getLanguage();
}

describe("localization", () => {
  afterEach(() => setLanguage("en"));

  it("uses the English catalog and retains supported regional formatting", async () => {
    expect(await resolve(["en-gb"])).to.equal("en-GB");
    expect(await resolve(["en-IN"])).to.equal("en-IN");
    expect(await resolve(["it-IT", "en-GB"])).to.equal("en-GB");
    expect(await resolve(["invalid_locale", "it-IT"])).to.equal("en");
    expect(await resolve([])).to.equal("en");
    setLanguage("en-IN");
    expect(localize("common.next")).to.equal("Next");
    expect(formatNumber(1234567)).to.equal("12,34,567");
  });

  it("loads the first shipped catalog, exact tag before base language", async () => {
    const loaded: string[] = [];
    expect(await resolve(["de-AT"], loaded)).to.equal("de-AT");
    expect(loaded).to.deep.equal(["de-AT", "de-Latn", "de"]);
    expect(localize("common.next")).to.equal("Weiter");
    expect(await resolve(["de-DE"])).to.equal("de-DE");
    expect(formatNumber(1234.5)).to.equal("1.234,5");
    expect(await resolve(["pt-BR"])).to.equal("pt-BR");
    expect(localize("common.next")).to.equal("Próximo");
    expect(await resolve(["pt-PT"])).to.equal("pt-PT");
    expect(localize("common.next")).to.equal("Seguinte");
    expect(await resolve(["invalid_locale", "it-IT", "fr-CA"])).to.equal(
      "fr-CA"
    );
    expect(localize("common.next")).to.equal("Suivant");
    // English is always shipped, so a later preference never wins over it
    expect(await resolve(["it-IT", "en-GB", "de"])).to.equal("en-GB");
    expect(localize("common.next")).to.equal("Next");
  });

  it("matches a catalog by script before the base language", async () => {
    for (const [preference, next] of [
      ["zh-CN", "下一步"],
      ["zh-SG", "下一步"],
      ["zh", "下一步"],
      ["zh-TW", "下一頁"],
      ["zh-HK", "下一頁"],
      ["zh-Hant-TW", "下一頁"],
      ["sr-Latn-RS", "Dalje"],
      ["sr-RS", "Даље"],
      ["nb-NO", "Neste"],
      ["en-GB", "Next"],
    ]) {
      expect(await resolve([preference])).to.equal(preference);
      expect(localize("common.next"), preference).to.equal(next);
    }
  });

  it("shows the English for a missing, empty or broken translation", () => {
    setLanguage("de", {
      "common.next": "Weiter",
      "common.back": " ",
      "app.title": 42,
      "components.vm_resources.cores": "{count, plural",
      "utm.update_timeout": "Öffne {link}",
      "backend.proxmox.node_offline": "Knoten {node} ist offline",
    });
    expect(localize("common.next")).to.equal("Weiter");
    expect(localize("common.cancel")).to.equal("Cancel");
    expect(localize("common.back")).to.equal("Back");
    expect(localize("app.title")).to.equal("Home Assistant Installer");
    expect(localize("components.vm_resources.cores", { count: 2 })).to.equal(
      "2 cores"
    );
    expect(
      localize("utm.update_timeout", { address: "http://192.0.2.1" })
    ).to.contain("Open http://192.0.2.1");
    expect(
      localizeBackend("backend.proxmox.node_offline", { node: "pve" })
    ).to.equal("Knoten pve ist offline");
    // Without the parameter neither catalog can say it; the backend's can
    expect(localizeBackend("backend.proxmox.node_offline", {})).to.equal(
      undefined
    );
  });

  it("uses English plural rules for an English fallback", () => {
    const key = "components.vm_resources.cores";
    setLanguage("ja", {});
    expect(localize(key, { count: 1 })).to.equal("1 core");
    setLanguage("fr", {});
    expect(localize(key, { count: 0 })).to.equal("0 cores");
  });

  it("prefers the native OS locale over the browser and falls back safely", async () => {
    await detectLanguage(["en-US"], async () => "en-GB", loader());
    expect(getLanguage()).to.equal("en-GB");
    await detectLanguage(["en-IN"], async () => null, loader());
    expect(getLanguage()).to.equal("en-IN");
    await detectLanguage(["en-GB"], async () => "invalid_locale", loader());
    expect(getLanguage()).to.equal("en-GB");
    await detectLanguage(
      ["en-US"],
      async () => {
        throw new Error("locale unavailable");
      },
      loader()
    );
    expect(getLanguage()).to.equal("en-US");
    expect(await resolve(["fr-FR"])).to.equal("en");
  });

  it("does not let an unresponsive native locale command or catalog prevent startup", async () => {
    await detectLanguage(
      ["en-GB"],
      () => new Promise(() => undefined),
      loader()
    );
    expect(getLanguage()).to.equal("en-GB");
    await detectLanguage(["de"], undefined, () => new Promise(() => undefined));
    expect(getLanguage()).to.equal("en");
  });

  it("keeps the decimal byte basis and flooring", () => {
    expect(formatBytes(0)).to.equal("0 bytes");
    expect(formatBytes(1000)).to.equal("1 kB");
    expect(formatBytes(1599)).to.equal("1.5 kB");
    expect(formatBytes(1000 ** 3)).to.equal("1 GB");
    expect(
      formatNumber(Number((1.25).toFixed(1)), {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })
    ).to.equal("1.3");
    expect(
      formatNumber(0.125, { style: "percent", maximumFractionDigits: 20 })
    ).to.equal("12.5%");
  });

  it("renders dynamic data as text while preserving code-owned rich placeholders", () => {
    const drive = '<img src=x onerror="alert(1)">';
    const el = document.createElement("div");
    render(
      html`${localizeContent("components.confirm_dialog.erase_warning", {
        drive: html`<strong>${drive}</strong>`,
      })}`,
      el
    );
    expect(el.querySelector("img")).to.equal(null);
    expect(el.querySelector("strong")?.textContent).to.equal(drive);
    expect(el.textContent).to.equal(
      `All data on ${drive} will be permanently erased. This action cannot be undone.`
    );
    expect(
      localize("utm.update_timeout", { address: "http://192.0.2.1" })
    ).to.contain("http://192.0.2.1");
  });
});
