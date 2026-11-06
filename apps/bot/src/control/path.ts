/** Decode one URL path segment, returning null for malformed percent-encoding. */
export function decodePathSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
