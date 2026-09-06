const articleWordRanges = {
  compact: [700, 1000],
  standard: [1100, 1700],
  long: [1800, 2600],
};

// Without a locale, use plain numbers for generation prompts.
export function formatArticleWordRange(length, locale) {
  const range = Object.hasOwn(articleWordRanges, length)
    ? articleWordRanges[length]
    : articleWordRanges.standard;
  if (locale === undefined) {
    return range.join("-");
  }
  const formatter = new Intl.NumberFormat(locale);
  return range.map((words) => formatter.format(words)).join("–");
}
