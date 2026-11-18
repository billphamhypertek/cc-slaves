// A minimal valid pack (Thiết kế → Build → Xong + Chung + Lane) as a files map; tests override one file at a time.
export type Files = Record<string, string>;

export const fm = (yaml: string, body = ''): string => `---\n${yaml}\n---\n${body}`;

export function basePack(over: Files = {}): Files {
  return {
    'WORKFLOW.md': fm('name: Thử\ndescription: một quy trình thử\ndoc_label: Spec\ndocs_done: done', 'Lời dặn chung.'),
    'steps/design.md': fm('type: design\nname: Thiết kế\ndocs: docs/specs\nnext: { to: build, start: button }', 'Viết spec. {{tools}}'),
    'steps/build.md': fm('type: build\nname: Build\nnext: { to: done }', 'Build theo mục.'),
    'steps/general.md': fm('type: general\nname: Chung', 'Việc chung.'),
    'steps/lane.md': fm('type: lane\nphases: [queue, code, done]', 'Làm brief.'),
    ...over,
  };
}

/** `over` with `null` deletes that file. */
export function packWith(over: Record<string, string | null>): Files {
  const out = basePack();
  for (const [k, v] of Object.entries(over)) { if (v === null) delete out[k]; else out[k] = v; }
  return out;
}
