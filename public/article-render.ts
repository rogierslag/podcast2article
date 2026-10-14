import type {
  Article,
  ArticleParagraph,
  Episode,
  TranscriptSegment,
} from "../src/types.js";
import {
  countLabel,
  dateLocale,
  translate,
  type UiLanguage,
} from "../src/shared/i18n.ts";
import {
  articleSectionId,
  escapeHtml,
  formatTimestamp,
  html,
} from "./article-format.ts";

type CitationSource = Pick<TranscriptSegment, "id" | "start">;
type SourceAttribution = Pick<
  Episode,
  | "sourceType"
  | "sourceUrl"
  | "sourceName"
  | "title"
  | "imageUrl"
  | "publishedAt"
  | "durationSeconds"
>;

interface ArticleRenderOptions {
  language: UiLanguage;
  byline: string;
  citationMode: "source" | "time";
}

const sourceLinkKeys: Record<Episode["sourceType"], string> = {
  "google-drive": "source.viewDrive",
  youtube: "source.viewYoutube",
  fathom: "source.viewFathom",
  rss: "source.viewPodcast",
  spotify: "source.viewSpotify",
};

export function renderSourceAttribution(
  episode: SourceAttribution,
  language: UiLanguage,
): string {
  const details = [
    episode.publishedAt
      ? new Date(episode.publishedAt).toLocaleDateString(dateLocale(language), {
          dateStyle: "long",
        })
      : "",
    episode.durationSeconds
      ? countLabel(
          language,
          "duration",
          Math.round(episode.durationSeconds / 60),
        )
      : "",
  ].filter(Boolean);
  const image = episode.imageUrl
    ? html`
        <img
          class="source-attribution-image"
          src="${escapeHtml(episode.imageUrl)}"
          alt="${escapeHtml(translate(language, "source.image", { name: episode.sourceName }))}"
        />
      `
    : "";
  return html`
    ${image}
    <div class="source-attribution-body">
      <span class="source-attribution-publication"
        >${escapeHtml(episode.sourceName)}</span
      >
      <p class="source-attribution-title">${escapeHtml(episode.title)}</p>
      <p class="source-attribution-meta">
        ${escapeHtml(details.join(" · "))}${details.length ? " · " : ""}
        <a
          href="${escapeHtml(episode.sourceUrl)}"
          target="_blank"
          rel="noreferrer"
          >${translate(language, sourceLinkKeys[episode.sourceType])}</a
        >
      </p>
    </div>
  `;
}

function sourceButtons(
  ids: readonly string[],
  sources: ReadonlyMap<string, CitationSource>,
  options: ArticleRenderOptions,
): string {
  const buttons = ids
    .map((id) => {
      const source = sources.get(id);
      if (!source) {
        return "";
      }
      const time = formatTimestamp(source.start);
      const label = translate(
        options.language,
        options.citationMode === "source" ? "source.jump" : "source.listen",
        { time },
      );
      const target =
        options.citationMode === "source"
          ? html`data-source="${escapeHtml(id)}"`
          : html`data-time="${source.start}"`;
      return html`<button
        class="source-link"
        ${target}
        aria-label="${escapeHtml(label)}"
        title="${escapeHtml(label)}"
      >
        ${time}
      </button>`;
    })
    .filter(Boolean)
    .join(" ");
  return buttons ? html`<span class="sources">${buttons}</span>` : "";
}

function articleBlock(
  block: ArticleParagraph,
  sources: ReadonlyMap<string, CitationSource>,
  options: ArticleRenderOptions,
): string {
  const paragraph = html`<p>
    ${escapeHtml(block.text)} ${sourceButtons(block.sources, sources, options)}
  </p>`;
  return block.kind === "quote"
    ? html`<blockquote>${paragraph}</blockquote>`
    : paragraph;
}

export function renderArticle(
  article: Article,
  citationSources: readonly CitationSource[],
  options: ArticleRenderOptions,
): string {
  const sources = new Map<string, CitationSource>();
  for (const source of citationSources) {
    // Match the previous first-source lookup when a response contains duplicate IDs.
    if (!sources.has(source.id)) {
      sources.set(source.id, source);
    }
  }
  const sections = article.sections
    .map((section, index) => {
      const paragraphs = section.paragraphs
        .map((paragraph) => articleBlock(paragraph, sources, options))
        .join("");
      return html`
        <section>
          <h2 id="${articleSectionId(section.heading, index)}">
            ${escapeHtml(section.heading)}
          </h2>
          ${paragraphs}
        </section>
      `;
    })
    .join("");
  const takeaways = article.takeaways
    .map(
      (item) => html`
        <li>
          ${escapeHtml(item.text)}
          ${sourceButtons(item.sources, sources, options)}
        </li>
      `,
    )
    .join("");
  return html`
    <h1>${escapeHtml(article.title)}</h1>
    <p class="dek">${escapeHtml(article.dek)}</p>
    <p class="byline">${escapeHtml(options.byline)}</p>
    ${sections}
    <div class="takeaways">
      <h2>${translate(options.language, "article.takeaways")}</h2>
      <ul>
        ${takeaways}
      </ul>
    </div>
  `;
}

export function renderContents(
  article: Article,
  sectionHref: (sectionId: string) => string,
): string {
  return article.sections
    .map(
      (section, index) => html`
        <a
          href="${escapeHtml(sectionHref(articleSectionId(section.heading, index)))}"
          >${escapeHtml(section.heading)}</a
        >
      `,
    )
    .join("");
}
