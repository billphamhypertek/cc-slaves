// v2.2 §5.3 a server name with a control char (CR / LF / NUL, e.g. a repo `.mcp.json` key) is a view row with an
// error: never in a lane file, never a login target (its id would reach a `security -i` line).
import { describe, expect, test } from 'bun:test';
import { buildCatalog, sessionMcp, type CatalogSources } from '../../src/mcp/catalog.ts';
import { oauthServerOf } from '../../src/mcp/oauth.ts';

const EVIL = 'evil\ndelete-generic-password -s cc-slaves-engine-token -a cc-slaves\nx';
const PROJECTS = [{ id: 'p1', path: '/w/p1' }];
const src: CatalogSources = {
  claudeJson: {},
  projectMcp: { p1: { mcpServers: { [EVIL]: { type: 'http', url: 'https://as.evil' }, ok: { type: 'http', url: 'https://ok' } } } },
  plugins: [{ key: 'pl\r@m', installPath: '/plug', scope: 'user', enabled: true, servers: { s: { type: 'http', url: 'https://p' } } }],
};
const ON = { offForLanes: [], projectOn: [`project:p1:${EVIL}`, 'project:p1:ok'], pluginsOff: [] };

describe('§5.3 control chars in MCP names', () => {
  test('§5.3 a project / plugin entry whose id has a control char gets error bad_name (escaped) and stays out of lanes', () => {
    const c = buildCatalog(src, PROJECTS, ON);
    const bad = c.find((e) => e.id === `project:p1:${EVIL}`)!;
    expect(bad.error).toEqual({ code: 'bad_name', name: 'evil\\ndelete-generic-password -s cc-slaves-engine-token -a cc-slaves\\nx' });
    expect(bad.forLanes).toBe(false);
    expect(c.find((e) => e.source === 'plugin')!.error?.code).toBe('bad_name');
    expect(c.find((e) => e.id === 'project:p1:ok')).toMatchObject({ forLanes: true });
    expect(c.find((e) => e.id === 'project:p1:ok')!.error).toBeUndefined();
    const file = JSON.stringify(sessionMcp(c, 'p1', 1, 't'));
    expect(file).not.toContain('evil');
    expect(file).not.toContain('pl\\r');
  });

  test('§5.3 a bad_name entry is never a login target (no OAuth record, no Keychain write)', () => {
    const c = buildCatalog(src, PROJECTS, ON);
    expect(oauthServerOf(c, `project:p1:${EVIL}`)).toBeUndefined();
    expect(oauthServerOf(c, 'project:p1:ok')).toBeDefined();
  });

  test('§6 K4 "Đăng nhập: Không": an id in config mcp.noLogin is never a login target', () => {
    const c = buildCatalog(src, PROJECTS, ON);
    expect(oauthServerOf(c, 'project:p1:ok', ['project:p1:ok'])).toBeUndefined();
    expect(oauthServerOf(c, 'project:p1:ok', ['user:other'])).toBeDefined();
  });
});
