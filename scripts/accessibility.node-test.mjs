import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { translate } from "../public/i18n.js";

const theme = readFileSync("public/theme.css", "utf8");
function tokens(selector) {
  const block = theme.slice(theme.indexOf(selector));
  return Object.fromEntries(
    [
      ...block
        .slice(0, block.indexOf("}"))
        .matchAll(/--([\w-]+):\s*(#[\da-f]{3,6});/g),
    ].map(([, name, value]) => [name, value]),
  );
}
function luminance(color) {
  const hex =
    color.length === 4
      ? [...color.slice(1)].map((digit) => digit + digit).join("")
      : color.slice(1);
  const channels = hex.match(/../g).map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
const light = tokens(":root {");
const palettes = {
  light,
  login: { ...light, ...tokens(":root.login-page {") },
  dark: { ...light, ...tokens(":root,\n") },
};
for (const [name, palette] of Object.entries(palettes)) {
  test(`${name}: utility text and control boundaries remain distinguishable`, () => {
    for (const surface of ["cream", "paper", "control-surface"]) {
      for (const foreground of ["muted", "accent-text"]) {
        assert.ok(
          contrast(palette[foreground], palette[surface]) >= 4.5,
          `${foreground} on ${surface} must meet 4.5:1`,
        );
      }
      assert.ok(
        contrast(palette["control-border"], palette[surface]) >= 3,
        `control border on ${surface} must meet 3:1`,
      );
    }
    assert.ok(
      contrast(palette["accent-text"], palette["transcript-flash"]) >= 4.5,
      "Playback timestamps must remain readable during the transcript highlight",
    );
  });
}
test("playback labels explain the action and retain the visible timestamp in both languages", () => {
  assert.equal(
    translate("nl", "transcript.playFrom", { time: "02:14" }),
    "Speel vanaf 02:14",
  );
  assert.equal(
    translate("en", "transcript.playFrom", { time: "02:14" }),
    "Play from 02:14",
  );
});
