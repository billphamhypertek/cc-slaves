// Renders `inline code` spans from engine text (card titles like "D2 xin chạy: Bash `rm -rf build/`") without HTML injection.
import type { ReactElement } from 'react';

export function Rich({ text }: { text: string }): ReactElement {
  const parts = text.split(/(`[^`]+`)/g);
  return <>{parts.map((p, i) => (p.startsWith('`') && p.endsWith('`') && p.length > 1 ? <code key={i}>{p.slice(1, -1)}</code> : p))}</>;
}
