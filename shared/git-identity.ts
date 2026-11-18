// hotfix 2026-11-16 (b) the commit identity check, one home for the engine (`git_identity_set`) and the web form: both
// non-empty, no control character (a newline would end the config line), no leading "-" (never read as an option), an
// email shape `x@y.z`.
export type IdentityIssue = 'name' | 'email';

// eslint-disable-next-line no-control-regex -- C0 / DEL control bytes are exactly what is refused
const CONTROL = /[\x00-\x1f\x7f]/;
const EMAIL = /^[^\s@<>]+@[^\s@<>.]+(\.[^\s@<>.]+)+$/;

const bad = (v: string, max: number) => !v.trim() || v.trim().length > max || CONTROL.test(v) || v.trim().startsWith('-');

export function identityIssue(name: string, email: string): IdentityIssue | null {
  if (bad(name, 100)) return 'name';
  if (bad(email, 254) || !EMAIL.test(email.trim())) return 'email';
  return null;
}
