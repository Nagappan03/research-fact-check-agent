// Shared slug helper. Used by research.js (to name output files) and by
// send-brief-email.js (to find the output file that matches a topic).

/** "Vector Databases & Embeddings" -> "vector-databases-embeddings" */
export function slugify(text) {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "") // strip accents
      .replace(/[^a-z0-9]+/g, "-") // anything else becomes a hyphen
      .replace(/^-+|-+$/g, "") || "topic"
  );
}
