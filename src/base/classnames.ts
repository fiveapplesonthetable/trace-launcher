// Joins class names into a single attribute string, dropping falsy entries so
// callers can write `condition && 'class'` inline. Returns undefined when
// nothing is left, which Mithril treats as "no class attribute".

type ClassArg = string | false | null | undefined;

export function classNames(...args: readonly ClassArg[]): string | undefined {
  let result = '';
  for (const arg of args) {
    if (arg) result += result === '' ? arg : ` ${arg}`;
  }
  return result === '' ? undefined : result;
}
