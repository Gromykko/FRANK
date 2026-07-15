// {0}/{1}… placeholder replacement, shared by the React t() and the pure
// feature modules (safety reasons, cache status) whose default stays English.
// No React imports — safe anywhere.
export type Translate = (s: string, ...args: (string | number)[]) => string;

export const interpolate: Translate = (s, ...args) =>
  s.replace(/\{(\d+)\}/g, (match, idx) => {
    const value = args[Number(idx)];
    return value === undefined ? match : String(value);
  });
