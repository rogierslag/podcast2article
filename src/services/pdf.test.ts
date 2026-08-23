import { describe, expect, it } from "vitest";
import { pdfDownloadName } from "./pdf.js";

describe("PDF download names", () => {
  it("keeps a readable Unicode article title", () => {
    expect(pdfDownloadName("Waarom AI wél werkt")).toBe("Waarom AI wél werkt.pdf");
  });

  it("removes path separators and reserved filename characters", () => {
    expect(pdfDownloadName('Audio/video: een vraag? <deel 1>')).toBe("Audio video een vraag deel 1.pdf");
  });

  it("falls back when the title contains no usable characters", () => {
    expect(pdfDownloadName("  ...  ")).toBe("artikel.pdf");
  });
});
