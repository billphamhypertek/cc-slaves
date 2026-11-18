// v2.2 §6 namespaces kept out of the first paint (bundle cap, `scripts/bundle-budget.json`): the engine loads them with
// both catalogs (index.ts); the web calls `loadLazyNs()` from the lazy chunk that shows them (Skills & MCP sheet incl. v2.5 Bộ công cụ + Graph code, Code / Git mode).
// How to add a key / namespace: docs/ref/i18n.md.
import { extendCatalog } from './core.ts';
import enAttachChip from './en/attachChip.json';
import enCode from './en/code.json';
import enGit from './en/git.json';
import enGitSetup from './en/gitSetup.json';
import enGraph from './en/graph.json';
import enMcpLogin from './en/mcpLogin.json';
import enModelMenu from './en/modelMenu.json';
import enSkillsMcp from './en/skillsMcp.json';
import enToolkit from './en/toolkit.json';
import enWorkflow from './en/workflow.json';
import viAttachChip from './vi/attachChip.json';
import viCode from './vi/code.json';
import viGit from './vi/git.json';
import viGitSetup from './vi/gitSetup.json';
import viGraph from './vi/graph.json';
import viMcpLogin from './vi/mcpLogin.json';
import viModelMenu from './vi/modelMenu.json';
import viSkillsMcp from './vi/skillsMcp.json';
import viToolkit from './vi/toolkit.json';
import viWorkflow from './vi/workflow.json';

export const LAZY_NS = {
  vi: { skillsMcp: viSkillsMcp, mcpLogin: viMcpLogin, code: viCode, git: viGit, gitSetup: viGitSetup, modelMenu: viModelMenu, attachChip: viAttachChip, toolkit: viToolkit, graph: viGraph, workflow: viWorkflow },
  en: { skillsMcp: enSkillsMcp, mcpLogin: enMcpLogin, code: enCode, git: enGit, gitSetup: enGitSetup, modelMenu: enModelMenu, attachChip: enAttachChip, toolkit: enToolkit, graph: enGraph, workflow: enWorkflow },
} as const;

export function loadLazyNs(): void {
  extendCatalog('vi', LAZY_NS.vi);
  extendCatalog('en', LAZY_NS.en);
}
