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
    const [sky, app, css, widgets] = await Promise.all([read("src/elysa/Sky.tsx"), read("src/elysa/ElysaApp.tsx"), read("src/elysa/elysa.css"), read("src/elysa/widgets.tsx")]);
    assert.match(sky, /aria-hidden="true"/, "the sky is decoration");
    assert.match(sky, /const still = \(\) => reduced\.matches \|\| !motion;/, "the sky holds still under reduced motion or the pause control");
    assert.match(sky, /if \(document\.hidden \|\| now - last < 33\) return;/, "and draws at most 30 frames a second, never while hidden");
    assert.match(app, /aria-pressed=\{!motion\} onClick=\{onMotion\}>\{motion \? "Pause animations" : "Play animations"\}/, "a visible pause control");
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /:root\[data-motion='off'\] \.tape-track \{ animation-play-state: paused; \}|\.tape:hover \.tape-track, :root\[data-motion='off'\] \.tape-track \{ animation-play-state: paused; \}/);
    assert.match(widgets, /role="timer"/, "the countdown is announced as a timer");
  });

  it("signs only what the router this network lists would receive", async () => {
    const pay = await read("src/elysa/pay.tsx");
    assert.match(pay, /if \(prepared\.to\.toLowerCase\(\) !== view\.contracts\.router\?\.toLowerCase\(\)\) throw new Error/);
    assert.match(pay, /navigate\(`\/r\/\$\{view\.id\}\/\$\{hash\}\?ms=\$\{elapsed\}&fresh=1`\)/, "the receipt opens with the measured confirmation time");
  });

  it("uses the new mark, not the earlier bird", async () => {
    const [favicon, logo] = await Promise.all([read("public/favicon.svg"), read("src/elysa/Logo.tsx")]);
    assert.match(logo, /"Ascent"/);
    assert.match(favicon, /#7CF2D4/);
    assert.doesNotMatch(favicon, /swallow|bird/i);
  });
});
