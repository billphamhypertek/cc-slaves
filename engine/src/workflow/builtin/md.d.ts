// The built-in packs are md files embedded as text (`import … with { type: 'text' }`, kept in `bun build --compile`).
declare module '*.md' {
  const text: string;
  export default text;
}
