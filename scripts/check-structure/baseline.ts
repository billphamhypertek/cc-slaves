import { SECTIONS, THRESHOLD, type Measurement, type Section } from './measure';

/**
 * The ratchet half of `check:structure` (coding standard §1): the baseline file, rules (a)–(d) and the writers
 * `--update` / `--rekey`. Pure functions over a `Measurement`; the CLI does the IO. The baseline may only shrink.
 */

export interface Baseline { sections: Record<Section, Map<string, number>> }
/** (a) new over the limit · (b) grew · (c) back under the limit · (c′) points at nothing · (d) hard · `ref` moved by hand. */
type Rule = 'a' | 'b' | 'c' | 'c′' | 'd' | 'ref';
export interface Finding { rule: Rule; section: Section | 'hard'; key: string; message: string }

export const emptyBaseline = (): Baseline => ({
  sections: { files: new Map(), functions: new Map(), edges: new Map(), cycles: new Map(), patterns: new Map() },
});

/** Every finding is red: there is no warning level (a key under the limit must leave the baseline at once). */
export function evaluate(m: Measurement, b: Baseline, ref?: Baseline): Finding[] {
  const out: Finding[] = [];
  if (ref) out.push(...againstRef(m, b, ref));
  for (const h of m.hard) {
    out.push({ rule: 'd', section: 'hard', key: h.key,
      message: h.rule === 'L4' ? 'L4: a runtime cycle between fragments of one assembler' : `${h.rule} import is forbidden` });
  }
  for (const s of SECTIONS) {
    const measured = m.values[s];
    const base = b.sections[s];
    for (const [key, value] of measured) {
      if (value <= THRESHOLD[s] || base.has(key)) continue;
      const message = s === 'edges' && m.l6.has(key) ? 'L6: a fragment imports its assembler' : `${value} > ${THRESHOLD[s]} and not in the baseline`;
      out.push({ rule: s === 'edges' && m.l6.has(key) ? 'd' : 'a', section: s, key, message });
    }
    for (const [key, entry] of base) {
      const value = measured.get(key);
      if (value === undefined) {
        out.push({ rule: 'c′', section: s, key, message: 'points at nothing any more: remove it with --update or move it with --rekey' });
      } else if (value <= THRESHOLD[s]) {
        out.push({ rule: 'c', section: s, key, message: `${value} ≤ ${THRESHOLD[s]}: remove the key with --update` });
      } else if (value > entry) {
        out.push({ rule: 'b', section: s, key, message: `grew ${entry} → ${value}` });
      }
    }
  }
  return out;
}

/**
 * The working baseline may only move the ways the writers move it. Red when, against the ref's baseline: a key in both
 * is higher, or a new key is not measured over the threshold or sits above its measured value (`--rekey` only).
 */
function againstRef(m: Measurement, b: Baseline, ref: Baseline): Finding[] {
  const out: Finding[] = [];
  for (const s of SECTIONS) {
    for (const [key, value] of b.sections[s]) {
      const bad = (message: string) => out.push({ rule: 'ref', section: s, key, message });
      const was = ref.sections[s].get(key);
      if (was !== undefined) {
        if (value > was) bad(`raised by hand ${was} → ${value} (the baseline may only shrink)`);
        continue;
      }
      const measured = m.values[s].get(key);
      if (measured === undefined || measured <= THRESHOLD[s]) bad('new key that is not measured over the threshold');
      else if (value > measured) bad(`new key at ${value}, above its measured ${measured}`);
      else if (seedable(key, ref)) continue;
      else if (![...ref.sections[s].keys()].some((k) => !b.sections[s].has(k))) bad('new key with no key gone (only --rekey adds one)');
    }
  }
  return out;
}

/** Rules added after the baseline existed (spec v2.4 §6.7 D53): their debt enters once, with `--seed <rule>`. */
const SEEDED_RULES: readonly string[] = ['space-literal', 'bar-literal'];
const ruleOf = (key: string): string => key.slice(0, key.indexOf('@'));
/** A new key of a seeded rule passes the ref check while the ref has no key of that rule yet (the rule is being introduced). */
const seedable = (key: string, ref: Baseline): boolean =>
  SEEDED_RULES.includes(ruleOf(key)) && ![...ref.sections.patterns.keys()].some((k) => ruleOf(k) === ruleOf(key));

/** `--seed <rule>`: every measured key of a seeded rule over the threshold enters at its measured value; nothing else moves. */
export function seedBaseline(m: Measurement, b: Baseline, rule: string): { baseline: Baseline } | { error: string } {
  if (!SEEDED_RULES.includes(rule)) return { error: `${rule} is not a seeded rule (${SEEDED_RULES.join(', ')})` };
  const out = emptyBaseline();
  for (const x of SECTIONS) for (const [k, v] of b.sections[x]) out.sections[x].set(k, v);
  for (const [k, v] of m.values.patterns) if (ruleOf(k) === rule && v > THRESHOLD.patterns && !out.sections.patterns.has(k)) out.sections.patterns.set(k, v);
  return { baseline: out };
}

/** `--update`: min(measured, baseline); drops (c) and (c′) keys; never adds. */
export function updateBaseline(m: Measurement, b: Baseline): Baseline {
  const out = emptyBaseline();
  for (const s of SECTIONS) {
    for (const [key, entry] of b.sections[s]) {
      const value = m.values[s].get(key);
      if (value !== undefined && value > THRESHOLD[s]) out.sections[s].set(key, Math.min(value, entry));
    }
  }
  return out;
}

/** `--rekey`: the only way to rename a key (a file moved); refused when the new key measures more than the old value. */
export function rekey(m: Measurement, b: Baseline, oldKey: string, newKey: string): { baseline: Baseline } | { error: string } {
  const s = SECTIONS.find((x) => b.sections[x].has(oldKey));
  if (!s) return { error: `${oldKey} is not in the baseline` };
  const old = b.sections[s].get(oldKey)!;
  if (b.sections[s].has(newKey)) return { error: `${newKey} is already in the baseline` };
  const value = m.values[s].get(newKey);
  if (value === undefined) return { error: `${newKey} is not measured in section ${s}` };
  if (value <= THRESHOLD[s]) return { error: `${newKey} measures ${value} ≤ ${THRESHOLD[s]}: drop ${oldKey} with --update instead` };
  if (value > old) return { error: `refused: ${newKey} measures ${value} > ${old} of ${oldKey}` };
  const out = emptyBaseline();
  for (const x of SECTIONS) for (const [k, v] of b.sections[x]) if (k !== oldKey || x !== s) out.sections[x].set(k, v);
  out.sections[s].set(newKey, value);
  return { baseline: out };
}

/** `--init` (once, when no baseline exists): every key over the threshold, at its measured value. */
export function initBaseline(m: Measurement): Baseline {
  const out = emptyBaseline();
  for (const s of SECTIONS) for (const [k, v] of m.values[s]) if (v > THRESHOLD[s] && !(s === 'edges' && m.l6.has(k))) out.sections[s].set(k, v);
  return out;
}

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Stable text: fixed section order, keys sorted by code unit. */
export function serializeBaseline(b: Baseline): string {
  const obj: Record<string, Record<string, number>> = {};
  for (const s of SECTIONS) {
    const sec: Record<string, number> = {};
    for (const key of [...b.sections[s].keys()].sort(byKey)) sec[key] = b.sections[s].get(key)!;
    obj[s] = sec;
  }
  return `${JSON.stringify(obj, null, 2)}\n`;
}

export function parseBaseline(text: string): Baseline {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const b = emptyBaseline();
  for (const s of SECTIONS) {
    for (const [key, v] of Object.entries((raw[s] ?? {}) as Record<string, unknown>)) {
      if (typeof v !== 'number') throw new Error(`structure baseline: ${s}.${key} is not a number`);
      b.sections[s].set(key, v);
    }
  }
  return b;
}
