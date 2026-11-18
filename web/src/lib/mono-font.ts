// spec v2.3 §10.1 "Cắt giữa" measures with the row's own font: the app's `--f-mono` stack at the row's type-scale step.
// v2.4 §6.7 D53: the one home of a JS text size — the step's px is read from `:root` (styles.css), so a scale change moves
// every JS measure with the CSS; `STEPS` (= `TYPE_SCALE`, a check-structure test keeps them equal) only serves without a DOM.
const STEPS = { xxs: 11, xs: 12, sm: 13, md: 14, lg: 16, xl: 19, xxl: 25 } as const;
type Step = keyof typeof STEPS;
/** :root `--h-head` (the deck head bar, D53) for pure geometry with no DOM (`deck/flow/viewport.ts`); a check-structure test keeps it = :root */
export const H_HEAD = 28;

const family: Record<string, string> = {};
const rootVar = (name: string): string =>
  typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** the canvas `font` of mono text at a step of the scale (`var(--sm)` → `monoFont('sm')`) */
export function monoFont(step: Step): string {
  return `${stepPx(step)}px ${fam('--f-mono') || 'monospace'}`;
}

/** the canvas `font` of body text (`font:500 var(--xs) var(--f-body)` → `bodyFont('xs', 500)`) */
export function bodyFont(step: Step, weight = 400): string {
  return `${weight} ${stepPx(step)}px ${fam('--f-body') || 'sans-serif'}`;
}

/** the px of a canvas `font` string (a no-canvas fallback scales its per-character width by it); `--sm` when it has none */
export const fontPx = (font: string): number => parseFloat(/([\d.]+)px/.exec(font)?.[1] ?? '') || STEPS.sm;

const stepPx = (step: Step): number => parseFloat(rootVar(`--${step}`)) || STEPS[step];
const fam = (name: string): string => (family[name] ||= rootVar(name));
