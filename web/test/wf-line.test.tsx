// v2.9 §4.7 the effective config at the head of a session: "Quy trình PO · Build · bản a1b2c3" in the session list, the
// Điều phối head and a lane's Inspector; its hover lists the blocked skills + the rules on. No `wf` on the wire = no line.
import { describe, expect, test } from 'bun:test';
import { createRef, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionRowView, Snapshot } from '../../shared/protocol.ts';
import type { WfRef } from '../../shared/workflows.ts';
import { LangProvider } from '../src/lib/i18n.tsx';
import type { Selection } from '../src/lib/inspector.ts';
import { Inspector } from '../src/ui/Inspector.tsx';
import { SessionList } from '../src/ui/SessionList.tsx';
import { MOCK_PO_REV } from '../dev/wf-mock.ts';
import { lane, snapshot } from './fixtures.ts';

const html = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="vi">{el}</LangProvider>);
const WF: WfRef = { rev: MOCK_PO_REV, name: 'Quy trình PO', step: 'build', stepName: 'Build', deny: ['superpowers:writing-plans'], rules: ['priority_first'], maxDoc: 3 };
const LINE = /<span class="wfl mono" title="Skill bị chặn: superpowers:writing-plans\nLuật bật: Giao mục ưu tiên trước · 3 phiên tài liệu cùng lúc">Quy trình PO · Build · bản a1b2c3<\/span>/;
const row = (over: Partial<SessionRowView> = {}): SessionRowView => ({ sessionId: 's1', projectId: 'p1', seq: 1, title: null, state: 'ended', startedAt: 1, endedAt: 2,
  accountFirst: 'pm@x', accountLast: 'pm@x', lanes: 0, tokens: { input: 1, output: 0, cacheWrite: 0, cacheRead: 0 }, costUsd: 1, endReason: 'ended_by_po',
  handoffPath: null, ctxLast: 1, resumable: true, ...over });
const list = (r: SessionRowView) => html(<SessionList at={{ x: 0, y: 0, w: 300, h: 400 }} os={[]} viewed={null} pi={null} onPick={() => {}} onClose={() => {}}
  list={{ running: [], ended: [r], max: 3 }} />);
const insp = (snap: Snapshot, sel: Selection) => html(<Inspector sel={sel} target={{ kind: 'orchestrator', projectId: snap.projects[0]!.id }} snap={snap} project={snap.projects[0]!} now={10}
  offline={false} dataAt={null} subs={{}} stream={undefined} live={undefined} subLines={[]} subLoading={false} subLive={undefined} hideTools={false} onHideTools={() => {}} paused={false}
  draft={null} inputRef={createRef<HTMLTextAreaElement>()} onSel={() => {}} onClose={() => {}} onMenu={() => {}} modal={false} token={() => null} onFocusInput={() => {}}
  onSend={() => Promise.resolve()} onInterrupt={() => {}} onLocal={() => {}} onStopAsk={() => {}} onOrchestrator={() => {}} onOlder={() => {}} onJumpEnd={() => {}} onError={() => {}}
  onResume={() => {}} onProjectResume={() => Promise.resolve()} sessions={snap.orchestrators} viewed={snap.orchestrators[0] ?? null} sessionsList={null} onHistory={() => {}}
  onView={() => {}} onSessionResume={() => {}} onOpenHandoff={() => {}} loadPreview={() => Promise.resolve(null)} onPause={() => {}} onMoveAll={() => {}} onRelogin={() => {}}
  onEditCaps={() => {}} done={{ total: 0, cleanupDays: 30, load: () => Promise.resolve(null), onMerge() {}, onContinue() {}, onVscode() {}, onRetry() {} }}
  modelSend={() => Promise.resolve(null)} modelReq={{ n: 0 }} />);

describe('v2.9 §4.7 effective config line', () => {
  test('§4.7 session list row: the line + its hover; none without wf', () => {
    expect(list(row({ wf: WF }))).toMatch(LINE);
    expect(list(row())).not.toContain('wfl');
  });
  test('§4.7 Điều phối head carries the line of its session', () => {
    const s = snapshot();
    const snap = snapshot({ orchestrators: [{ ...s.orchestrators[0]!, wf: WF }] });
    expect(insp(snap, { k: 'orch' })).toMatch(LINE);
    expect(insp(s, { k: 'orch' })).not.toContain('wfl');
  });
  test('§4.7 a lane Inspector carries the line of its lane step', () => {
    const snap = snapshot({ lanes: [lane('R1', { state: 'running', wf: WF })] });
    expect(insp(snap, { k: 'lane', name: 'R1' })).toMatch(LINE);
    expect(insp(snapshot({ lanes: [lane('R1', { state: 'running' })] }), { k: 'lane', name: 'R1' })).not.toContain('wfl');
  });
});
