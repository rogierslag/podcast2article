import PDFDocument from "pdfkit";
import type { ArticleParagraph, Job, TranscriptSegment } from "../types.js";

const colors = {
  ink: "#1b201d",
  muted: "#626862",
  orange: "#e85e2a",
  green: "#376453",
  line: "#d8d1c4",
};

function cleanText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-");
}

function timestamp(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3_600);
  const minutes = Math.floor((value % 3_600) / 60);
  const remainder = value % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function articleMomentUrl(
  baseUrl: string,
  jobId: string,
  seconds: number,
): string {
  const url = new URL("/", baseUrl);
  url.hash = `job=${jobId}&time=${Math.max(0, Math.floor(seconds))}`;
  return url.toString();
}

function ensureSpace(document: PDFKit.PDFDocument, points: number): void {
  const bottom = document.page.height - document.page.margins.bottom;
  if (document.y + points > bottom) {
    document.addPage();
  }
}

function sourceMoments(
  document: PDFKit.PDFDocument,
  value: ArticleParagraph,
  transcriptById: Map<string, TranscriptSegment>,
  jobId: string,
  baseUrl: string,
): void {
  const sources = value.sources
    .map((id) => transcriptById.get(id))
    .filter((source): source is TranscriptSegment => Boolean(source));
  if (!sources.length) {
    return;
  }

  document
    .font("Courier-Bold")
    .fontSize(7)
    .fillColor(colors.green)
    .text("BRON  ", { continued: true });
  sources.forEach((source, index) => {
    document.text(timestamp(source.start), {
      continued: index < sources.length - 1,
      link: articleMomentUrl(baseUrl, jobId, source.start),
      underline: true,
    });
    if (index < sources.length - 1) {
      document.text("  ·  ", {
        continued: true,
        underline: false,
        link: undefined,
      });
    }
  });
  document.moveDown(1.15);
}

function renderParagraph(
  document: PDFKit.PDFDocument,
  value: ArticleParagraph,
  transcriptById: Map<string, TranscriptSegment>,
  jobId: string,
  baseUrl: string,
): void {
  if (value.kind === "quote") {
    document
      .font("Times-Bold")
      .fontSize(15)
      .fillColor(colors.green)
      .text(cleanText(value.text), {
        indent: 16,
        lineGap: 4,
        align: "left",
      });
  } else {
    document
      .font("Helvetica")
      .fontSize(10.5)
      .fillColor(colors.ink)
      .text(cleanText(value.text), { lineGap: 3, align: "left" });
  }
  document.moveDown(0.35);
  sourceMoments(document, value, transcriptById, jobId, baseUrl);
}

function addPageNumbers(document: PDFKit.PDFDocument): void {
  const range = document.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    document.switchToPage(index);
    const label = `${index - range.start + 1} / ${range.count}`;
    const bottomMargin = document.page.margins.bottom;
    document.page.margins.bottom = 0;
    document
      .font("Courier")
      .fontSize(7)
      .fillColor(colors.muted)
      .text(label, document.page.margins.left, document.page.height - 31, {
        align: "right",
        lineBreak: false,
        width:
          document.page.width -
          document.page.margins.left -
          document.page.margins.right,
      });
    document.page.margins.bottom = bottomMargin;
  }
}

function renderArticle(
  document: PDFKit.PDFDocument,
  job: Job,
  baseUrl: string,
): void {
  const article = job.article!;
  const episode = job.episode!;
  const transcript = job.transcript!;
  const transcriptById = new Map(
    transcript.map((segment) => [segment.id, segment]),
  );
  const contentWidth =
    document.page.width -
    document.page.margins.left -
    document.page.margins.right;

  document.save();
  [14, 27, 35, 20].forEach((height, index) => {
    document
      .roundedRect(
        document.page.margins.left + index * 7,
        document.y + 35 - height,
        3.5,
        height,
        2,
      )
      .fill(colors.orange);
  });
  document.restore();
  document.moveDown(3.2);

  document
    .font("Courier-Bold")
    .fontSize(8)
    .fillColor(colors.orange)
    .text(cleanText(episode.sourceName.toUpperCase()), {
      characterSpacing: 0.7,
      link: episode.sourceUrl,
      underline: true,
    });
  document.moveDown(1.1);
  document
    .font("Times-Bold")
    .fontSize(31)
    .fillColor(colors.ink)
    .text(cleanText(article.title), { lineGap: 1 });
  document.moveDown(0.65);
  document
    .font("Helvetica")
    .fontSize(13)
    .fillColor(colors.muted)
    .text(cleanText(article.dek), { lineGap: 4 });
  document.moveDown(1);

  const details = [
    `${article.readingTimeMinutes} minuten leestijd`,
    `${transcript.length} bronfragmenten`,
    episode.publishedAt
      ? new Date(episode.publishedAt).toLocaleDateString("nl-NL", {
          dateStyle: "long",
        })
      : undefined,
  ]
    .filter(Boolean)
    .join("  ·  ");
  document
    .font("Courier")
    .fontSize(7.5)
    .fillColor(colors.muted)
    .text(details.toUpperCase(), { characterSpacing: 0.35 });
  document.moveDown(1.8);
  document
    .strokeColor(colors.line)
    .lineWidth(0.7)
    .moveTo(document.page.margins.left, document.y)
    .lineTo(document.page.margins.left + contentWidth, document.y)
    .stroke();
  document.moveDown(1.6);

  const noteTop = document.y;
  document.save();
  document.rect(document.page.margins.left, noteTop, 2, 34).fill(colors.orange);
  document.restore();
  document
    .font("Helvetica-Oblique")
    .fontSize(9)
    .fillColor(colors.muted)
    .text(
      cleanText(article.styleNote),
      document.page.margins.left + 13,
      noteTop,
      {
        lineGap: 2,
        width: contentWidth - 13,
      },
    );
  document.moveDown(2);

  for (const section of article.sections) {
    ensureSpace(document, 80);
    document
      .font("Times-Bold")
      .fontSize(20)
      .fillColor(colors.ink)
      .text(cleanText(section.heading), { lineGap: 2 });
    document.moveDown(0.7);
    for (const value of section.paragraphs) {
      renderParagraph(document, value, transcriptById, job.id, baseUrl);
    }
  }

  document.font("Helvetica").fontSize(10.5);
  const takeawaysHeight =
    62 +
    article.takeaways.reduce(
      (height, takeaway) =>
        height +
        document.heightOfString(cleanText(takeaway.text), {
          width: contentWidth - 15,
          lineGap: 3,
        }) +
        31,
      0,
    );
  const usablePageHeight =
    document.page.height -
    document.page.margins.top -
    document.page.margins.bottom;
  ensureSpace(document, Math.min(takeawaysHeight, usablePageHeight));
  document.moveDown(0.6);
  document.save();
  document
    .rect(document.page.margins.left, document.y, contentWidth, 4)
    .fill(colors.orange);
  document.restore();
  document.moveDown(1.2);
  document
    .font("Times-Bold")
    .fontSize(19)
    .fillColor(colors.ink)
    .text("Kernpunten");
  document.moveDown(0.7);
  for (const takeaway of article.takeaways) {
    ensureSpace(document, 60);
    const bulletY = document.y + 4;
    document.save();
    document
      .circle(document.page.margins.left + 3, bulletY, 2)
      .fill(colors.orange);
    document.restore();
    document
      .font("Helvetica")
      .fontSize(10.5)
      .fillColor(colors.ink)
      .text(
        cleanText(takeaway.text),
        document.page.margins.left + 15,
        document.y,
        {
          lineGap: 3,
          width: contentWidth - 15,
        },
      );
    document.moveDown(0.35);
    sourceMoments(document, takeaway, transcriptById, job.id, baseUrl);
  }

  addPageNumbers(document);
}

export function pdfDownloadName(title: string): string {
  const safeTitle = title
    .normalize("NFKC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
  return `${safeTitle || "artikel"}.pdf`;
}

export function generateArticlePdf(
  job: Job,
  baseUrl: string,
): Promise<Uint8Array> {
  if (!job.article || !job.episode || !job.transcript) {
    return Promise.reject(
      new Error("De opdracht bevat niet alle gegevens voor PDF-export."),
    );
  }
  const document = new PDFDocument({
    size: "A4",
    margins: { top: 54, right: 58, bottom: 58, left: 58 },
    bufferPages: true,
    compress: true,
    info: {
      Title: cleanText(job.article.title),
      Author: cleanText(job.episode.sourceName),
      Subject: "Brongebonden artikel met aanklikbare transcriptiemomenten",
      Creator: "Podcast2Article",
    },
  });
  const chunks: Buffer[] = [];
  const result = new Promise<Uint8Array>((resolve, reject) => {
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.once("end", () => resolve(Buffer.concat(chunks)));
    document.once("error", reject);
  });
  try {
    renderArticle(document, job, baseUrl);
    document.end();
  } catch (error) {
    document.destroy(error instanceof Error ? error : new Error(String(error)));
  }
  return result;
}
