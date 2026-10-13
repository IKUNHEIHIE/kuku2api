// Clone JSON definitions with stable object keys. Arrays and primitive values keep their order/content.
// Iteration avoids imposing an additional nesting limit on schema annotations and examples.
export function stableToolDefinitions(tools) {
  const output = new Array(tools.length);
  const copies = new WeakMap([[tools, output]]);
  const pending = [tools];
  while (pending.length) {
    const input = pending.pop(), target = copies.get(input);
    const keys = Object.keys(input);
    if (!Array.isArray(input)) keys.sort();
    for (const key of keys) {
      let value = input[key];
      if (value !== null && typeof value === 'object') {
        if (!copies.has(value)) {
          copies.set(value, Array.isArray(value) ? new Array(value.length) : {});
          pending.push(value);
        }
        value = copies.get(value);
      }
      // Preserve literal __proto__/constructor keys as data without invoking prototype setters.
      Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
    }
  }
  return output;
}
