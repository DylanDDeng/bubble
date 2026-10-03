/** Small display-only fields from an incomplete JSON object. Never retain the
 * growing content/patch in desktop history for every token. Canonical arguments
 * replace this preview once the SDK completes the call. */
export function toolInputPreview(argumentsText: string): Record<string, string> {
  const text = argumentsText.slice(0, 16_384);
  const fields = new Set(['path', 'file_path', 'command', 'pattern', 'query', 'url']);
  const result: Record<string, string> = {};
  let depth = 0;
  let key: string | undefined;
  let expectsKey = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const start = i++;
      for (; i < text.length; i++) {
        if (text[i] === '\\') { i++; continue; }
        if (text[i] === '"') break;
      }
      if (i >= text.length) break;
      if (depth !== 1) continue;
      let value: string;
      try { value = JSON.parse(text.slice(start, i + 1)); } catch { break; }
      if (expectsKey) { key = value; expectsKey = false; }
      else if (key) {
        if (fields.has(key) && value.length <= 4096) result[key] = value;
        key = undefined;
      }
    } else if (char === '{' || char === '[') {
      depth++;
      if (depth === 1 && char === '{') expectsKey = true;
      else key = undefined;
    } else if (char === '}' || char === ']') {
      depth--;
    } else if (char === ',' && depth === 1) {
      expectsKey = true;
      key = undefined;
    } else if (depth === 1 && !/[\s:]/.test(char)) {
      key = undefined;
    }
  }
  return result;
}
