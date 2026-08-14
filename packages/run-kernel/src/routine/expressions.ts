/**
 * Expressions parse to a closed, pure AST: no assignment, statements, member calls, iteration, or
 * ambient state; same source and scope must yield the same value.
 */

export type ExpressionErrorCode =
  | "expression_arity"
  | "expression_depth_exceeded"
  | "expression_forbidden_property"
  | "expression_syntax"
  | "expression_too_long"
  | "expression_type"
  | "expression_unknown_function"
  | "expression_unknown_root";

/**
 * Expression rejection. The message carries the reason code and the offending symbol only —
 * never the evaluated value, the surrounding scope, or a Secret reference.
 */
export class ExpressionError extends Error {
  readonly name = "ExpressionError";

  constructor(
    readonly code: ExpressionErrorCode,
    readonly detail = ""
  ) {
    super(`${code}${detail ? `:${detail}` : ""}`);
  }
}

export const DEFAULT_EXPRESSION_ROOTS = ["input", "states", "trigger", "loop", "item"] as const;

export const MAX_EXPRESSION_LENGTH = 1_000;
export const MAX_EXPRESSION_DEPTH = 32;

/** Prototype-reaching names never resolve, at parse time, regardless of the value shape. */
const FORBIDDEN_PROPERTIES = new Set(["__proto__", "constructor", "prototype"]);

type PureFunction = (args: readonly unknown[]) => unknown;

function sizeOf(value: unknown): number {
  if (typeof value === "string" || Array.isArray(value)) return value.length;
  if (value !== null && typeof value === "object") return Object.keys(value).length;
  throw new ExpressionError("expression_type", "len");
}

function asString(value: unknown, fn: string): string {
  if (typeof value !== "string") throw new ExpressionError("expression_type", fn);
  return value;
}

/** Pure, total, deterministic. Nothing here reads a clock, a random source, or the environment. */
const FUNCTIONS: Readonly<Record<string, { arity: number | "variadic"; call: PureFunction }>> = {
  len: { arity: 1, call: (args) => sizeOf(args[0]) },
  has: {
    arity: 2,
    call: (args) => {
      const [target, key] = args;
      if (target === null || typeof target !== "object") return false;
      const name = asString(key, "has");
      if (FORBIDDEN_PROPERTIES.has(name)) return false;
      return Object.hasOwn(target as object, name);
    },
  },
  lower: { arity: 1, call: (args) => asString(args[0], "lower").toLowerCase() },
  upper: { arity: 1, call: (args) => asString(args[0], "upper").toUpperCase() },
  trim: { arity: 1, call: (args) => asString(args[0], "trim").trim() },
  contains: {
    arity: 2,
    call: (args) => {
      const [haystack, needle] = args;
      if (Array.isArray(haystack)) return haystack.includes(needle);
      return asString(haystack, "contains").includes(asString(needle, "contains"));
    },
  },
  startsWith: {
    arity: 2,
    call: (args) => asString(args[0], "startsWith").startsWith(asString(args[1], "startsWith")),
  },
  endsWith: {
    arity: 2,
    call: (args) => asString(args[0], "endsWith").endsWith(asString(args[1], "endsWith")),
  },
  coalesce: {
    arity: "variadic",
    call: (args) => args.find((value) => value !== undefined && value !== null) ?? null,
  },
};

type TokenKind = "number" | "string" | "ident" | "punct" | "eof";
interface Token {
  kind: TokenKind;
  value: string;
}

const PUNCTUATION = [
  "&&",
  "||",
  "==",
  "!=",
  "<=",
  ">=",
  "(",
  ")",
  "[",
  "]",
  ",",
  ".",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "!",
] as const;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      let cursor = index + 1;
      let literal = "";
      while (cursor < source.length && source[cursor] !== char) {
        if (source[cursor] === "\\") {
          cursor += 1;
          if (cursor >= source.length) throw new ExpressionError("expression_syntax", "string");
        }
        literal += source[cursor];
        cursor += 1;
      }
      if (cursor >= source.length) throw new ExpressionError("expression_syntax", "string");
      tokens.push({ kind: "string", value: literal });
      index = cursor + 1;
      continue;
    }
    if (char >= "0" && char <= "9") {
      let cursor = index;
      while (cursor < source.length && /[0-9.]/.test(source[cursor] as string)) cursor += 1;
      const literal = source.slice(index, cursor);
      if (!/^\d+(\.\d+)?$/.test(literal)) throw new ExpressionError("expression_syntax", "number");
      tokens.push({ kind: "number", value: literal });
      index = cursor;
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let cursor = index;
      while (cursor < source.length && /[A-Za-z0-9_$]/.test(source[cursor] as string)) cursor += 1;
      tokens.push({ kind: "ident", value: source.slice(index, cursor) });
      index = cursor;
      continue;
    }
    const punct = PUNCTUATION.find((candidate) => source.startsWith(candidate, index));
    if (punct === undefined) throw new ExpressionError("expression_syntax", char);
    tokens.push({ kind: "punct", value: punct });
    index += punct.length;
  }
  tokens.push({ kind: "eof", value: "" });
  return tokens;
}

type Segment = { kind: "property"; name: string } | { kind: "index"; expression: Node };

type Node =
  | { kind: "literal"; value: unknown }
  | { kind: "path"; root: string; segments: Segment[] }
  | { kind: "call"; name: string; args: Node[] }
  | { kind: "unary"; operator: "!" | "-"; operand: Node }
  | { kind: "binary"; operator: string; left: Node; right: Node };

const KEYWORD_LITERALS: Readonly<Record<string, unknown>> = {
  true: true,
  false: false,
  null: null,
};

class Parser {
  private position = 0;
  private depth = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly roots: ReadonlySet<string>
  ) {}

  parse(): Node {
    const node = this.parseOr();
    if (this.peek().kind !== "eof") {
      throw new ExpressionError("expression_syntax", this.peek().value);
    }
    return node;
  }

  private peek(): Token {
    return this.tokens[this.position] as Token;
  }

  private eat(value: string): boolean {
    const token = this.peek();
    if (token.kind === "punct" && token.value === value) {
      this.position += 1;
      return true;
    }
    return false;
  }

  private expect(value: string): void {
    if (!this.eat(value)) throw new ExpressionError("expression_syntax", value);
  }

  private nested<T>(parse: () => T): T {
    this.depth += 1;
    if (this.depth > MAX_EXPRESSION_DEPTH) {
      throw new ExpressionError("expression_depth_exceeded");
    }
    const result = parse();
    this.depth -= 1;
    return result;
  }

  private parseBinary(operators: readonly string[], next: () => Node): Node {
    let left = next();
    for (;;) {
      const token = this.peek();
      if (token.kind !== "punct" || !operators.includes(token.value)) return left;
      this.position += 1;
      left = { kind: "binary", operator: token.value, left, right: next() };
    }
  }

  private parseOr(): Node {
    return this.nested(() => this.parseBinary(["||"], () => this.parseAnd()));
  }

  private parseAnd(): Node {
    return this.parseBinary(["&&"], () => this.parseComparison());
  }

  private parseComparison(): Node {
    return this.parseBinary(["==", "!=", "<=", ">=", "<", ">"], () => this.parseAdditive());
  }

  private parseAdditive(): Node {
    return this.parseBinary(["+", "-"], () => this.parseMultiplicative());
  }

  private parseMultiplicative(): Node {
    return this.parseBinary(["*", "/", "%"], () => this.parseUnary());
  }

  private parseUnary(): Node {
    if (this.eat("!")) return { kind: "unary", operator: "!", operand: this.parseUnary() };
    if (this.eat("-")) return { kind: "unary", operator: "-", operand: this.parseUnary() };
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    if (this.eat("(")) {
      const node = this.parseOr();
      this.expect(")");
      return node;
    }
    const token = this.peek();
    if (token.kind === "number") {
      this.position += 1;
      return { kind: "literal", value: Number(token.value) };
    }
    if (token.kind === "string") {
      this.position += 1;
      return { kind: "literal", value: token.value };
    }
    if (token.kind !== "ident") throw new ExpressionError("expression_syntax", token.value);
    this.position += 1;

    if (Object.hasOwn(KEYWORD_LITERALS, token.value)) {
      return { kind: "literal", value: KEYWORD_LITERALS[token.value] };
    }
    if (this.eat("(")) return this.parseCall(token.value);
    if (!this.roots.has(token.value)) {
      throw new ExpressionError("expression_unknown_root", token.value);
    }
    return { kind: "path", root: token.value, segments: this.parseSegments() };
  }

  private parseCall(name: string): Node {
    const definition = FUNCTIONS[name];
    if (definition === undefined) {
      throw new ExpressionError("expression_unknown_function", name);
    }
    const args: Node[] = [];
    if (!this.eat(")")) {
      do {
        args.push(this.nested(() => this.parseOr()));
      } while (this.eat(","));
      this.expect(")");
    }
    if (definition.arity !== "variadic" && args.length !== definition.arity) {
      throw new ExpressionError("expression_arity", name);
    }
    if (definition.arity === "variadic" && args.length === 0) {
      throw new ExpressionError("expression_arity", name);
    }
    return { kind: "call", name, args };
  }

  private parseSegments(): Segment[] {
    const segments: Segment[] = [];
    for (;;) {
      if (this.eat(".")) {
        const token = this.peek();
        if (token.kind !== "ident") throw new ExpressionError("expression_syntax", token.value);
        this.position += 1;
        if (FORBIDDEN_PROPERTIES.has(token.value)) {
          throw new ExpressionError("expression_forbidden_property", token.value);
        }
        segments.push({ kind: "property", name: token.value });
        continue;
      }
      if (this.eat("[")) {
        const expression = this.nested(() => this.parseOr());
        this.expect("]");
        segments.push({ kind: "index", expression });
        continue;
      }
      return segments;
    }
  }
}

function readProperty(target: unknown, key: string | number): unknown {
  if (target === null || target === undefined) return undefined;
  if (typeof key === "number") {
    return Array.isArray(target) ? target[key] : undefined;
  }
  if (FORBIDDEN_PROPERTIES.has(key)) return undefined;
  if (typeof target !== "object") return undefined;
  return Object.hasOwn(target, key) ? (target as Record<string, unknown>)[key] : undefined;
}

function compare(operator: string, left: unknown, right: unknown): unknown {
  switch (operator) {
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    default:
      break;
  }
  if (typeof left !== typeof right || (typeof left !== "number" && typeof left !== "string")) {
    throw new ExpressionError("expression_type", operator);
  }
  const a = left as number | string;
  const b = right as number | string;
  switch (operator) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    default:
      return a >= b;
  }
}

function arithmetic(operator: string, left: unknown, right: unknown): unknown {
  if (operator === "+" && typeof left === "string" && typeof right === "string") {
    return left + right;
  }
  if (typeof left !== "number" || typeof right !== "number") {
    throw new ExpressionError("expression_type", operator);
  }
  switch (operator) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    default:
      if (right === 0) throw new ExpressionError("expression_type", "divide_by_zero");
      return operator === "/" ? left / right : left % right;
  }
}

function evaluateNode(node: Node, scope: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "path": {
      let value = readProperty(scope, node.root);
      for (const segment of node.segments) {
        if (segment.kind === "property") {
          value = readProperty(value, segment.name);
          continue;
        }
        const key = evaluateNode(segment.expression, scope);
        if (typeof key !== "string" && typeof key !== "number") {
          throw new ExpressionError("expression_type", "index");
        }
        value = readProperty(value, key);
      }
      return value;
    }
    case "call":
      return (FUNCTIONS[node.name] as { call: PureFunction }).call(
        node.args.map((arg) => evaluateNode(arg, scope))
      );
    case "unary": {
      const operand = evaluateNode(node.operand, scope);
      if (node.operator === "!") return !operand;
      if (typeof operand !== "number") throw new ExpressionError("expression_type", "-");
      return -operand;
    }
    default: {
      if (node.operator === "&&") {
        return Boolean(evaluateNode(node.left, scope)) && Boolean(evaluateNode(node.right, scope));
      }
      if (node.operator === "||") {
        return Boolean(evaluateNode(node.left, scope)) || Boolean(evaluateNode(node.right, scope));
      }
      const left = evaluateNode(node.left, scope);
      const right = evaluateNode(node.right, scope);
      return ["==", "!=", "<", "<=", ">", ">="].includes(node.operator)
        ? compare(node.operator, left, right)
        : arithmetic(node.operator, left, right);
    }
  }
}

function collectReferences(node: Node, into: Set<string>): void {
  switch (node.kind) {
    case "path": {
      // Static prefix only: a dynamic index ends the provable path.
      const parts = [node.root];
      for (const segment of node.segments) {
        if (segment.kind !== "property") break;
        parts.push(segment.name);
      }
      into.add(parts.join("."));
      for (const segment of node.segments) {
        if (segment.kind === "index") collectReferences(segment.expression, into);
      }
      return;
    }
    case "call":
      for (const arg of node.args) collectReferences(arg, into);
      return;
    case "unary":
      collectReferences(node.operand, into);
      return;
    case "binary":
      collectReferences(node.left, into);
      collectReferences(node.right, into);
      return;
    default:
  }
}

export interface CompiledExpression {
  readonly source: string;
  /** Static dotted paths the expression reads, sorted — the compiler proves each one exists. */
  readonly references: readonly string[];
  evaluate(scope: Readonly<Record<string, unknown>>): unknown;
}

export interface CompileExpressionOptions {
  readonly roots?: readonly string[];
}

/**
 * Parse and validate one authored expression. Throws {@link ExpressionError} for anything the
 * language does not allow; the returned closure only walks the frozen AST.
 */
export function compileExpression(
  source: string,
  options: CompileExpressionOptions = {}
): CompiledExpression {
  if (source.length > MAX_EXPRESSION_LENGTH) throw new ExpressionError("expression_too_long");
  const roots = new Set(options.roots ?? DEFAULT_EXPRESSION_ROOTS);
  const node = new Parser(tokenize(source), roots).parse();
  const references = new Set<string>();
  collectReferences(node, references);
  return Object.freeze({
    source,
    references: Object.freeze([...references].sort()),
    evaluate: (scope: Readonly<Record<string, unknown>>) => evaluateNode(node, scope),
  });
}

export function evaluateCondition(
  expression: CompiledExpression,
  scope: Readonly<Record<string, unknown>>
): boolean {
  return Boolean(expression.evaluate(scope));
}
