import { describe, expect, it } from "vitest";
import { generateArticlePdf, pdfDownloadName } from "./pdf.js";
import type { Job } from "../types.js";

describe("PDF download names", () => {
  it("keeps a readable Unicode article title", () => {
    expect(pdfDownloadName("Waarom AI wél werkt")).toBe(
      "Waarom AI wél werkt.pdf",
    );
  });

  it("removes path separators and reserved filename characters", () => {
    expect(pdfDownloadName("Audio/video: een vraag? <deel 1>")).toBe(
      "Audio video een vraag deel 1.pdf",
    );
  });

  it("falls back when the title contains no usable characters", () => {
    expect(pdfDownloadName("  ...  ")).toBe("artikel.pdf");
  });
});

describe("PDF generation", () => {
  it("creates a PDF with a clickable source moment", async () => {
    const now = new Date().toISOString();
    const job: Job = {
      id: "11111111-1111-4111-8111-111111111111",
      sourceUrl: "https://example.com/episode",
      language: "nl",
      articleLength: "compact",
      stage: "complete",
      progress: 100,
      message: "Klaar",
      createdAt: now,
      updatedAt: now,
      episode: {
        sourceType: "spotify",
        sourceUrl: "https://example.com/episode",
        sourceName: "Voorbeeldpodcast",
        title: "Een aflevering",
        mediaUrl: "https://example.com/audio.mp3",
      },
      transcript: [
        {
          id: "t-00001",
          start: 83,
          end: 90,
          speaker: "Rogier",
          text: "Een bronfragment.",
        },
      ],
      article: {
        title: "Waarom AI wél werkt",
        dek: "Een compact artikel met een controleerbare bron.",
        readingTimeMinutes: 4,
        styleNote: "Direct, praktisch en zorgvuldig.",
        sections: [
          {
            heading: "De kern",
            paragraphs: [
              {
                text: "Dit is de inhoud van de eerste alinea.",
                sources: ["t-00001"],
              },
            ],
          },
        ],
        takeaways: [
          {
            text: "Controleer altijd de oorspronkelijke bron.",
            sources: ["t-00001"],
          },
        ],
      },
    };
    const pdf = Buffer.from(
      await generateArticlePdf(job, "https://podcast.example"),
    );
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.byteLength).toBeGreaterThan(1_000);
    expect(pdf.includes(Buffer.from("https://podcast.example/"))).toBe(true);
  });
});
