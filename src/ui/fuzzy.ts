/**
 * Whether `text` matches a fuzzy `query`: each word of the query appears in `text` with its letters
 * in order, gaps allowed ("ctl rev" matches "src/controller/ReviewController.ts"). Ignores case.
 */
export function fuzzyMatch(query: string, text: string): boolean {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .every((word) => {
      let at = 0;
      for (const char of word) {
        at = haystack.indexOf(char, at);
        if (at < 0) {
          return false;
        }
        at++;
      }
      return true;
    });
}
