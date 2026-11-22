/** Splits a search into terms; double quotes keep spaces inside one (`tag:"peak time"`). */
export function searchTerms(query: string): string[] {
  return query.match(/(?:[^\s"]+|"[^"]*"?)+/g) ?? [];
}
