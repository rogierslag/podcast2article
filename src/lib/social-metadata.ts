import escapeHtml from "escape-html";

export interface SocialImage {
  url: string;
  alt: string;
  width?: number;
  height?: number;
  type?: string;
}

interface SocialPreview {
  type: "website" | "article";
  title: string;
  description: string;
  url: string;
  image: SocialImage;
  publishedAt?: string;
}

/** Render previews on the server because link crawlers do not run the UI. */
export function socialMetadata(preview: SocialPreview): string {
  const properties: Record<string, string | number | undefined> = {
    "og:type": preview.type,
    "og:site_name": "Podcast2Article",
    "og:title": preview.title,
    "og:description": preview.description,
    "og:url": preview.url,
    "og:image": preview.image.url,
    "og:image:alt": preview.image.alt,
    "og:image:width": preview.image.width,
    "og:image:height": preview.image.height,
    "og:image:type": preview.image.type,
    "article:published_time": preview.publishedAt,
  };
  const names: Record<string, string> = {
    "twitter:card": "summary_large_image",
    "twitter:title": preview.title,
    "twitter:description": preview.description,
    "twitter:image": preview.image.url,
    "twitter:image:alt": preview.image.alt,
  };

  return [
    `<link rel="canonical" href="${escapeHtml(preview.url)}">`,
    ...Object.entries(properties)
      .filter(([, value]) => value !== undefined)
      .map(
        ([property, value]) =>
          `<meta property="${property}" content="${escapeHtml(String(value))}">`,
      ),
    ...Object.entries(names).map(
      ([name, value]) => `<meta name="${name}" content="${escapeHtml(value)}">`,
    ),
  ].join("\n  ");
}
