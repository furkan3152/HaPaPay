import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("ElysaPay's interface", () => {
  it("serves only Elysium: no other network's code reaches the pages", async () => {
    const files: string[] = [];
    const walk = async (directory: string) => {
      for (const entry of await readdir(new URL(`../${directory}`, import.meta.url), { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(`${directory}${entry.name}/`);
        else if (/\.tsx?$/.test(entry.name)) files.push(`${directory}${entry.name}`);
      }
    };
    await walk("src/elysa/");
    for (const file of files) {
      const source = await read(file);
      assert.doesNotMatch(source, /solana|robinhood|arc-chains|stock-tokens/i, `${file} reaches another network`);
    }
    assert.match(await read("src/main.tsx"), /<ElysaApp \/>/);
  });

  it("keeps motion optional and decoration out of the accessibility tree", async () => {
    const [desk, mascot, app, css, widgets] = await Promise.all([read("src/elysa/Desk.tsx"), read("src/elysa/Mascot.tsx"), read("src/elysa/ElysaApp.tsx"), read("src/elysa/elysa.css"), read("src/elysa/widgets.tsx")]);
    assert.match(desk, /<div className="desk" aria-hidden="true">/, "the desk is decoration");
    assert.match(desk, /if \(!motion \|\| window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches\) return;/, "its drifting band follows the pause control and reduced motion");
    assert.match(mascot, /aria-hidden="true">/, "Ely is decoration; the page says what Ely says");
    assert.match(app, /aria-pressed=\{!motion\} onClick=\{onMotion\}>\{motion \? "Pause animations" : "Play animations"\}/, "a visible pause control");
    assert.match(css, /:root\[data-motion='off'\] \.ely-svg/, "Ely rests when animations are paused");
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(widgets, /role="timer"/, "the countdown is announced as a timer");
  });

  it("draws in dots: no glass, no gradient that is not a dot", async () => {
    const css = await read("src/elysa/elysa.css");
    assert.doesNotMatch(css, /backdrop-filter: blur\(1[6-9]px\)|linear-gradient\(1[0-9]{2}deg, #/, "no glass panels or aurora gradients");
    assert.match(css, /--font-display: "Doto"/, "the dot-matrix face");
    for (const [, gradient] of css.matchAll(/(radial-gradient\([^;]*?\))/g)) {
      assert.match(gradient, /circle|px circle at/, `${gradient.slice(0, 60)} is a dot or a pointer mask`);
    }
  });

  it("signs only what the router this network lists would receive", async () => {
    const pay = await read("src/elysa/pay.tsx");
    assert.match(pay, /if \(prepared\.to\.toLowerCase\(\) !== view\.contracts\.router\?\.toLowerCase\(\)\) throw new Error/);
    assert.match(pay, /navigate\(`\/r\/\$\{view\.id\}\/\$\{hash\}\?ms=\$\{elapsed\}&fresh=1`\)/, "the receipt opens with the measured confirmation time");
  });

  it("uses the new dot mark and Ely, not the earlier bird", async () => {
    const [favicon, logo, morph] = await Promise.all([read("public/favicon.svg"), read("src/elysa/Logo.tsx"), read("src/components/DotMorph.tsx")]);
    assert.match(logo, /an E drawn in dots whose top stroke lets its last dot go/);
    assert.match(favicon, /#97FCE4/);
    assert.match(morph, /ely\(g\) \{/, "the hero's dots can gather into Ely");
    assert.doesNotMatch(favicon, /swallow|bird/i);
  });
});
