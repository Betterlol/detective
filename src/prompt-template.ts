export function renderPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`Missing prompt value: ${key}`);
    return value;
  });
}
