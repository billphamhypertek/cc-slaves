// spec v2.3 §4.1 the one deck header bar, in the HUD over Tasks, Deck, the F9 list, Code and Git (v2.1 §4.8 drew it inside
// the deck and the list, so hiding the deck lost it): the v2.7 §4.1 Tasks · Deck · Code · Git switch (a tablist, outside the
// live stats; Tasks only on the Mac channel, §8; an orange dot without a number on Tasks while the project has unseen issues,
// §5.6), then the v2.1 stats line (one line, cut "…" from the right, "n chưa merge" amber, hover = every project's today) with
// the v2.7 §4.2-1 issues strip on the Deck (a button: Tasks on that spec).
import type { ReactElement } from 'react';
import type { DeckHead, HeadStrip } from '../lib/deckhead.ts';
import type { TasksAsk } from '../lib/traces.ts';
import { ProgressBar } from '../tasks/ProgressBar.tsx';
import { useT } from '../lib/i18n.tsx';
import type { Mode } from '../lib/keys.ts';
import { Icon, type IconName } from './icons.tsx';

const TABS: readonly { m: Mode; icon: IconName; key: string }[] = [
  { m: 'tasks', icon: 'listChecks', key: 'T' }, { m: 'deck', icon: 'workflow', key: 'D' }, { m: 'code', icon: 'fileCode', key: 'C' }, { m: 'git', icon: 'branch', key: 'G' },
];

function Strip({ s, onTasks }: { s: HeadStrip; onTasks: (go: TasksAsk) => void }): ReactElement {
  const tr = useT();
  return (
    <button type="button" className="hstrip" title={s.spec?.tip} onClick={() => onTasks({ sel: s.spec ? { spec: s.spec.id } : 'outside', issue: null })}>
      {s.spec ? <><b>{s.spec.short}</b><ProgressBar p={s.spec.progress} compact /><span className="n">{s.spec.progress.done}/{s.spec.progress.total}</span>
        {s.more ? <span className="o">+{s.more}</span> : null}</> : null}
      {s.outside ? <span className="o">{s.spec ? '· ' : ''}{tr('deck.strip.outsideA')} <b>{s.outside}</b></span> : null}
    </button>
  );
}

export function HeadBar({ head, mode, onMode, tasks, unseen, onTasks }: { head: DeckHead; mode: Mode; onMode: (m: Mode) => void; tasks: boolean; unseen: boolean; onTasks?: (go: TasksAsk) => void }): ReactElement {
  const tr = useT();
  return (
    <div className="dhead">
      <div className="wss" role="tablist" aria-label={tr('deck.mode.aria')}>
        {TABS.filter(t => tasks || t.m !== 'tasks').map(t => {
          const label = tr(`deck.mode.${t.m}`);
          return (
            <button key={t.m} type="button" role="tab" className={`wst${mode === t.m ? ' on' : ''}`} aria-selected={mode === t.m}
              title={tr('deck.mode.tip', { label, key: t.key })} onClick={() => onMode(t.m)}>
              <Icon n={t.icon} s={14} />{label}<span className="kb">{t.key}</span>
              {t.m === 'tasks' && unseen ? <i className="od" role="img" aria-label={tr('deck.mode.unseen')} title={tr('deck.mode.unseen')} /> : null}
            </button>
          );
        })}
      </div>
      <span className="dstat" role="status" aria-label={tr('deck.head.aria')} title={head.tip.length ? head.tip.join('\n') : undefined}>
        {head.parts.map((p, i) => (p.strip ? (mode === 'deck' && tasks && onTasks ? <Strip key={p.k} s={p.strip} onTasks={onTasks} /> : null)
          : <span key={p.k} className={`hp hp-${p.k}${p.warn ? ' warn' : ''}`}>{i ? <i className="sep" aria-hidden="true"> · </i> : null}{p.text}</span>
        ))}
      </span>
    </div>
  );
}
