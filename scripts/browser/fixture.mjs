export const articleId = "00000000-0000-4000-8000-000000000931";
export const token = "r".repeat(43);
export const password = "regression-test-only-password";
export function articleFixture() {
  return {
    id: articleId,
    shareToken: token,
    sourceUrl: "https://example.com/recording",
    language: "nl",
    articleLength: "standard",
    stage: "complete",
    progress: 100,
    message: "Klaar",
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-01T10:00:00Z",
    completedAt: "2026-09-01T10:00:00Z",
    episode: {
      sourceType: "google-drive",
      sourceUrl: "https://example.com/recording",
      sourceName: "De werkweek",
      title: "Waarom aandacht en samenwerking ruimte nodig hebben",
      mediaUrl: "https://example.com/private-media",
    },
    transcript: [
      {
        id: "t-00001",
        start: 5,
        end: 10,
        speaker: "Sanne",
        text: "Meer rust geeft ruimte voor aandacht.",
      },
    ],
    article: {
      title: "When Better Ideas Arrive",
      dek: "Een gesprek over aandacht en samenwerken.",
      readingTimeMinutes: 5,
      styleNote: "Helder en rustig.",
      sections: Array.from({ length: 5 }, (_, index) => ({
        heading: `Ruimte voor aandacht ${index + 1}`,
        paragraphs: [
          {
            kind: "paragraph",
            text: "Een team heeft ruimte nodig om zorgvuldig samen te werken. ".repeat(
              12,
            ),
            sources: ["t-00001"],
          },
          {
            kind: "quote",
            text: "Meer rust geeft ruimte voor aandacht.",
            sources: ["t-00001"],
          },
          {
            kind: "paragraph",
            text: `Een lange verwijzing: https://example.com/${"aandacht".repeat(20)}`,
            sources: [],
          },
        ],
      })),
      takeaways: [{ text: "Maak ruimte voor aandacht.", sources: ["t-00001"] }],
    },
  };
}
