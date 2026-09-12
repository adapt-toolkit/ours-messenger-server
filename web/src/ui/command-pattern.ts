import { RegExpParser, type AST } from '@eslint-community/regexpp';

// Never execute an advertised expression with the native backtracking engine.
// regexpp parses ECMAScript /u; native matching is restricted to ONE character
// atom against ONE code point. All composition runs below with a shared budget.
const MAX_PATTERN_LENGTH = 256;
const MAX_REPETITION = 256;
const MAX_PATTERN_DEPTH = 24;
const MAX_CACHE = 64;
export class PatternBudgetError extends Error {}
export function patternBudget() { return { remaining: 100_000 }; }
export type PatternBudget = ReturnType<typeof patternBudget>;
function spend(budget: PatternBudget) {
  if (--budget.remaining < 0) throw new PatternBudgetError('pattern validation work limit exceeded');
}
type Node = AST.Pattern | AST.Alternative | AST.Element;
type Compiled = { root: AST.Pattern; atoms: Map<Node, RegExp> };
const cache = new Map<string, Compiled | string>();
function compile(pattern: string): Compiled | string {
  const cached = cache.get(pattern);
  if (cached !== undefined) return cached;
  if (pattern.length > MAX_PATTERN_LENGTH) return `pattern exceeds ${MAX_PATTERN_LENGTH} characters`;
  if (!pattern.startsWith('^') || !pattern.endsWith('$')) return 'pattern must be anchored with ^ and $';
  let result: Compiled | string;
  try {
    const root = new RegExpParser({ ecmaVersion: 2024 }).parsePattern(pattern, 0, pattern.length, { unicode: true });
    const atoms = new Map<Node, RegExp>();
    const visit = (node: Node, depth: number): void => {
      if (depth > MAX_PATTERN_DEPTH) throw Error(`pattern depth exceeds ${MAX_PATTERN_DEPTH}`);
      switch (node.type) {
        case 'Pattern': case 'Group': case 'CapturingGroup':
          if (node.type === 'Group' && node.modifiers) throw Error('pattern group modifiers are not supported');
          for (const child of node.alternatives) visit(child, depth + 1);
          break;
        case 'Alternative':
          for (const child of node.elements) visit(child, depth + 1);
          break;
        case 'Quantifier':
          if (node.min > MAX_REPETITION || (Number.isFinite(node.max) && node.max > MAX_REPETITION)) {
            throw Error(`pattern repetition must not exceed ${MAX_REPETITION}`);
          }
          visit(node.element, depth + 1);
          break;
        case 'Assertion':
          if (node.kind === 'lookbehind') throw Error('pattern lookbehind is not supported');
          if (node.kind === 'lookahead') for (const child of node.alternatives) visit(child, depth + 1);
          break;
        case 'Character': case 'CharacterSet': case 'CharacterClass':
          atoms.set(node, new RegExp(`^(?:${node.raw})$`, 'u'));
          break;
        default: throw Error(`pattern ${node.type} is not supported`);
      }
    };
    visit(root, 0);
    result = { root, atoms };
  } catch (error) {
    result = error instanceof SyntaxError ? 'pattern has invalid Unicode syntax' : (error as Error).message;
  }
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
  cache.set(pattern, result);
  return result;
}
export function safePatternError(value: unknown): string | null {
  if (typeof value !== 'string') return 'pattern must be a string';
  const compiled = compile(value);
  return typeof compiled === 'string' ? compiled : null;
}

// Sets of reachable code-point offsets avoid exponential duplicate paths. No
// captures/backreferences are supported, so greedy/lazy ordering cannot change
// acceptance. Repetition is iterative: stack use depends on AST depth, not input.
export function matchesPattern(pattern: string, value: string, budget: PatternBudget): boolean {
  const compiled = compile(pattern);
  if (typeof compiled === 'string') throw Error(compiled);
  const chars = Array.from(value);
  const add = (set: Set<number>, position: number) => { spend(budget); set.add(position); };
  const union = (target: Set<number>, source: Set<number>) => {
    for (const position of source) add(target, position);
  };
  const alternatives = (nodes: AST.Alternative[], position: number): Set<number> => {
    const result = new Set<number>();
    for (const node of nodes) { spend(budget); union(result, match(node, position)); }
    return result;
  };
  const advance = (node: Node, positions: Set<number>): Set<number> => {
    const next = new Set<number>();
    for (const position of positions) { spend(budget); union(next, match(node, position)); }
    return next;
  };
  const match = (node: Node, position: number): Set<number> => {
    spend(budget);
    switch (node.type) {
      case 'Pattern': case 'Group': case 'CapturingGroup':
        return alternatives(node.alternatives, position);
      case 'Alternative': {
        let positions = new Set([position]);
        for (const element of node.elements) {
          spend(budget);
          positions = advance(element, positions);
          if (!positions.size) break;
        }
        return positions;
      }
      case 'Quantifier': {
        let positions = new Set([position]);
        for (let index = 0; index < node.min; index++) {
          spend(budget);
          positions = advance(node.element, positions);
          if (!positions.size) return positions;
        }
        const result = new Set<number>();
        union(result, positions);
        for (let index = node.min; index < node.max && positions.size; index++) {
          spend(budget);
          const next = advance(node.element, positions);
          if (node.max === Infinity) {
            // Transitive closure: an offset already explored has the same future.
            for (const offset of next) { spend(budget); if (result.has(offset)) next.delete(offset); }
          }
          union(result, next);
          positions = next;
        }
        return result;
      }
      case 'Assertion': {
        let accepted: boolean;
        if (node.kind === 'start') accepted = position === 0;
        else if (node.kind === 'end') accepted = position === chars.length;
        else if (node.kind === 'word') {
          const word = (char: string | undefined) => char !== undefined && /^[a-zA-Z0-9_]$/.test(char);
          accepted = (word(chars[position - 1]) !== word(chars[position])) !== node.negate;
        } else if (node.kind === 'lookahead') {
          accepted = (alternatives(node.alternatives, position).size > 0) !== node.negate;
        } else throw Error('unsupported assertion');
        return new Set(accepted ? [position] : []);
      }
      default: {
        const atom = compiled.atoms.get(node)!;
        return new Set(position < chars.length && atom.test(chars[position]) ? [position + 1] : []);
      }
    }
  };
  // Keep ECMAScript search semantics even for textual ^...$ patterns whose
  // alternations may not all be anchored (e.g. ^a|b$).
  for (let position = 0; position <= chars.length; position++) {
    spend(budget);
    if (match(compiled.root, position).size > 0) return true;
  }
  return false;
}
