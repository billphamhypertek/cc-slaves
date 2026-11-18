// hf1117-p4 (perf-audit C5 + C6, orchestrator 10:05 ruling): calm motion. Glyph loops run on an HTML wrapper (composited
// `transform` / `opacity`, no SVG style + layout per frame), only running states spin; buttons fade in 120 ms, no hover
// lift / brightness, hover = neutral --sel step, keyboard focus a static ring.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { Glyph } from '../src/deck/flow/Glyph.tsx';
import { makeT } from '../../shared/i18n/index.ts';
import type { OrchestratorState } from '../../shared/protocol.ts';
import { buildFlow, type Glyph as GlyphState, type OrchData } from '../src/deck/flow/model.ts';
import { snapshot } from './fixtures.ts';

const ALL: GlyphState[] = ['starting', 'running', 'idle', 'waiting_po', 'switching', 'waiting_quota', 'draining', 'paused', 'stopped',
  'broken', 'done', 'root', 'root_quota', 'root_down', 'root_ask', 'root_start', 'root_run'];
const h = (s: GlyphState, live = true) => renderToStaticMarkup(<Glyph state={s} live={live} orbit={3} />);
const css = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('C5 glyph loops on a composited HTML wrapper', () => {
  test('every animated class sits on an HTML <span class="gl …">, never on an SVG child', () => {
    for (const s of ALL) {
      const m = h(s);
      expect(m).not.toMatch(/<(?:g|circle|path|rect|svg)\b[^>]*class="[^"]*\ba-/);
      for (const c of m.matchAll(/<(\w+)[^>]*class="([^"]*\ba-[^"]*)"/g)) expect([c[1], c[2]!.split(' ')[0]]).toEqual(['span', 'gl']);
    }
  });
  test('only running states spin: running / starting / root_start / root_run; idle, root, waiting_po, root_ask stand still', () => {
    for (const s of ['running', 'starting', 'root_start', 'root_run'] as const) expect(h(s)).toContain('a-spin');
    for (const s of ['idle', 'root', 'waiting_po', 'root_ask'] as const) expect(h(s)).not.toMatch(/a-spin|a-orb/);
    expect(h('waiting_po')).toContain('a-wave');
    expect(h('root_ask')).toContain('a-wave');
  });
  test('hf-fa IMPORTANT-2: a running / switching orchestrator spins (root_run), an idle one stands still (root)', () => {
    const orch = (state: OrchestratorState) => {
      const base = snapshot();
      const m = buildFlow({ snap: { ...base, orchestrators: base.orchestrators.map(o => ({ ...o, state })) }, projectId: 'p1', subagents: {}, selected: null, now: 1, tr: makeT('vi'), live: true });
      return m.nodes.find(n => n.data.kind === 'orchestrator')!.data as OrchData;
    };
    for (const st of ['running', 'switching'] as const) {
      const d = orch(st);
      expect(d.glyph).toBe('root_run');
      expect(h(d.glyph)).toContain('a-spin');
    }
    const idle = orch('idle');
    expect(idle.glyph).toBe('root');
    expect(h(idle.glyph)).not.toMatch(/a-spin|a-orb/);
  });
  test('paused gate: one static SVG, no wrapper span', () => {
    for (const s of ALL) {
      const m = h(s, false);
      expect(m).not.toContain('class="gl');
      expect(m.match(/<svg/g)).toHaveLength(1);
    }
  });
  test('flow.css: no SVG transform-origin, no slow-spin variants left', () => {
    const f = css('../src/deck/flow/flow.css');
    expect(f).not.toMatch(/a-slow|a-vslow|transform-origin:18px/);
    expect(f).toMatch(/\.deck \.so \.gl\{[^}]*position:absolute/);
  });
});

describe('C6 calm buttons', () => {
  const s = css('../src/styles.css');
  test('opacity fades in 120 ms, nothing at .6s', () => {
    expect(s).toContain(':is(.btn,.ib,.tab,.arow,.choice){transition:opacity 120ms var(--ease)}');
    expect(s).not.toMatch(/opacity \.6s|\.6s/);
    // hf-fa MINOR-1 (ruling 10:42): the inbox row fade too
    const ib = css('../src/ui/inbox.css');
    expect(ib).toMatch(/#inbox \.card\{[^}]*transition:opacity 120ms var\(--ease\)/);
    expect(ib).not.toMatch(/\.6s/);
  });
  test('hover: no lift, no brightness, neutral --sel step, no accent border / tint', () => {
    expect(s).not.toMatch(/translateY\(-1px\)|brightness/);
    expect(s).toContain(':is(.btn,.ib,.tab,.arow,.choice):not(:disabled):hover{background-image:linear-gradient(var(--sel),var(--sel))}');
    for (const m of s.matchAll(/([^{}]*:hover[^{}]*)\{([^}]*)\}/g)) {
      if (/\.(?:btn|arow|choice)\b/.test(m[1]!)) expect(m[2]).not.toMatch(/accent/);
    }
  });
  test('keyboard focus: a static ring, no scale pulse', () => {
    expect(s).not.toMatch(/mo-focus|focus-visible[^{]*\{[^}]*animation/);
    expect(s).toContain('button:focus-visible,textarea:focus-visible');
  });
});

test('orbit dots: they turn only on a running glyph; a Chờ PO glyph keeps them still', () => {
  const dot = /r="1.8"/g;
  expect(h('running').match(dot)).toHaveLength(3);
  expect(h('running')).toContain('class="gl a-orb"');
  expect(h('waiting_po').match(dot)).toHaveLength(3);
});
