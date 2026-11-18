// v2.9 §10.1 the workflow library commands + §5.9 the author drafts (Mac only: none is in REMOTE_ALLOWED, N6). A refused one is a
// `WorkflowLibError` (code + Vietnamese message); every change also reaches the Mac as `workflows_changed`. G5: applying a
// workflow pushes the project too (`ProjectView.workflow`: the Tasks chip and rail follow at once; no Chung restart, 22:36).
import type { Engine } from '../engine.ts';
import type { Handlers } from './router.ts';

export function workflowHandlers(e: Engine): Pick<Handlers, 'workflow_get' | 'workflow_save' | 'workflow_create' | 'workflow_import' | 'workflow_delete' | 'project_set_workflow' | 'workflow_edit'
  | 'workflow_draft_start' | 'workflow_draft_say' | 'workflow_draft_stop' | 'workflow_draft_discard' | 'workflow_draft_patch' | 'workflow_draft_save'
  | 'workflow_draft_undo' | 'workflow_draft_quota'> {
  const w = () => e.workflows;
  return {
    workflow_get: (c) => w().get('rev' in c ? { rev: c.rev } : { id: c.id }),
    workflow_save: (c) => w().save(c.id, c.files, c.baseRev),
    workflow_create: (c) => w().create(c.from, c.name),
    workflow_import: (c) => w().importDir(c.dir, c.preview === true),
    workflow_delete: (c) => w().remove(c.id),
    project_set_workflow: (c) => {
      w().setProject(c.projectId, c.id);
      const pv = e.projectView(c.projectId);
      if (pv) e.broadcast({ type: 'project', project: pv });
    },
    workflow_edit: (c) => w().edit(c.files, c.edits),
    // v2.9 §4.10 / §5.9 author by prompt (Mac only, like every workflow command)
    workflow_draft_start: (c) => e.authors.start(c.fromId, c.text),
    workflow_draft_say: (c) => e.authors.say(c.draftId, c.text),
    workflow_draft_stop: (c) => e.authors.interrupt(c.draftId),
    workflow_draft_discard: (c) => e.authors.discard(c.draftId),
    workflow_draft_patch: (c) => e.authors.patch(c.draftId, c.edits),
    workflow_draft_save: (c) => e.authors.save(c.draftId, c.name),
    workflow_draft_undo: (c) => e.authors.undo(c.draftId),
    workflow_draft_quota: (c) => e.authors.quota(c.draftId, c.go),
  };
}
