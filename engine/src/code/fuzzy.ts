// v2.3 §5.1 ⌘P "tìm mờ theo đường dẫn": the query's characters in order (case-insensitive); a hit in the file name, a hit at
// a segment / word start and a run of consecutive hits score more; shorter paths win ties. null = not a subsequence.
const BOUNDARY = new Set(['/', '-', '_', '.', ' ']);

function scoreIn(q: string, s: string, from: number): number | null {
  let score = 0;
  let prev = -2;
  let i = from;
  for (const ch of q) {
    const at = s.indexOf(ch, i);
    if (at < 0) return null;
    score += 1;
    if (at === prev + 1) score += 5;
    if (at === from || BOUNDARY.has(s[at - 1] ?? '/')) score += 8;
    prev = at;
    i = at + 1;
  }
  return score;
}

export function fuzzyScore(query: string, path: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return null;
  const s = path.toLowerCase();
  const all = scoreIn(q, s, 0);
  if (all === null) return null;
  const nameAt = s.lastIndexOf('/') + 1;
  const inName = scoreIn(q, s, nameAt);
  return Math.max(all, inName === null ? 0 : inName + 20) - path.length / 100;
}
