export type ParsedCliArguments = {
  command: string | undefined;
  positionals: string[];
  option(name: string, fallback?: string): string | undefined;
  hasFlag(name: string): boolean;
};

export function parseCliArguments(argv: string[]): ParsedCliArguments {
  const [command, ...tokens] = argv;
  const positionals: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const valueOptions = new Set(['version', 'out', 'theme', 'source', 'constraints', 'repairs', 'design-repairs', 'feedback', 'limit', 'save']);
  const booleanOptions = new Set(['bind', 'injected', 'legacy']);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const name = token.slice(2);
    const value = tokens[i + 1];
    if (booleanOptions.has(name)) {
      flags.add(name);
      continue;
    }
    if (valueOptions.has(name)) {
      if (value !== undefined) {
        if (!options.has(name)) options.set(name, value);
        i++;
      } else {
        flags.add(name);
      }
      continue;
    }
    if (value !== undefined && !value.startsWith('--')) {
      if (!options.has(name)) options.set(name, value);
      i++;
    } else {
      flags.add(name);
    }
  }

  return {
    command,
    positionals,
    option: (name, fallback) => options.get(name) ?? fallback,
    hasFlag: name => flags.has(name),
  };
}
