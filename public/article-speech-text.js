// Version 1 is persisted with the passage index; keep segmentation identical across browsers and the server.
export function articleSpeechPassages(article) {
  const blocks = [article.title, article.dek];
  for (const section of article.sections) {
    blocks.push(
      section.heading,
      ...section.paragraphs.map((part) => part.text),
    );
  }
  blocks.push(...article.takeaways.map((part) => part.text));
  return blocks.flatMap((block) => {
    const sentences = block.match(/[^.!?。！？]+(?:[.!?。！？]+|$)/gu) || [];
    return sentences.flatMap((sentence) => {
      const passages = [];
      let passage = "";
      for (const word of sentence.trim().split(/\s+/u)) {
        if (passage && passage.length + word.length + 1 > 160) {
          passages.push(passage);
          passage = "";
        }
        // Unbroken text (including CJK) must also remain a bounded utterance.
        const characters = Array.from(word);
        while (characters.length > 160) {
          if (passage) {
            passages.push(passage);
            passage = "";
          }
          passages.push(characters.splice(0, 160).join(""));
        }
        if (characters.length) {
          passage += `${passage ? " " : ""}${characters.join("")}`;
        }
      }
      if (passage) {
        passages.push(passage);
      }
      return passages;
    });
  });
}
