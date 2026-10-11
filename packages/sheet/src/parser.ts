import { type BinaryOperator, type FormulaNode } from './ast.js';
import { parseA1 } from './refs.js';
import { SHEET_LIMITS } from './limits.js';
import { type Token, tokenize } from './tokenizer.js';

/**
 * Pratt parser over the token stream. Precedence, loosest first: comparison,
 * concatenation (&), additive, multiplicative, exponent, unary sign, postfix
 * percent. Exponent is left-associative, matching the incumbents rather than
 * mathematics.
 *
 * parseFormula never throws: malformed text returns null and the engine maps
 * that to #PARSE!.
 */

export type FormulaParseResult =
  | { readonly ok: true; readonly node: FormulaNode }
  | { readonly ok: false; readonly position: number; readonly message: string };

export function parseFormula(text: string): FormulaNode | null {
  const result = parseFormulaResult(text);
  return result.ok ? result.node : null;
}

/** Parse once, retaining a source position for authoring feedback. */
export function parseFormulaResult(text: string): FormulaParseResult {
  if (text.length > SHEET_LIMITS.maxRawLength) {
    return { ok: false, position: SHEET_LIMITS.maxRawLength, message: 'The formula is too long.' };
  }
  const lexed = tokenize(text);
  if (!lexed.ok) {
    return {
      ok: false,
      position: lexed.position,
      message: 'Check this character, string, or property reference.',
    };
  }
  const parser = new Parser(lexed.tokens, text.length);
  try {
    const node = parser.parseExpression(0);
    if (!parser.atEnd()) {
      return {
        ok: false,
        position: parser.position(),
        message: 'Unexpected text after the expression.',
      };
    }
    return { ok: true, node };
  } catch (error) {
    if (error instanceof ParseFailure) {
      return { ok: false, position: parser.position(), message: error.message };
    }
    throw error;
  }
}

class ParseFailure extends Error {}

const COMPARISON: readonly BinaryOperator[] = ['=', '<>', '<', '<=', '>', '>='];

function binaryPrecedence(op: string): number | null {
  if ((COMPARISON as readonly string[]).includes(op)) {
    return 1;
  }
  if (op === '&') {
    return 2;
  }
  if (op === '+' || op === '-') {
    return 3;
  }
  if (op === '*' || op === '/') {
    return 4;
  }
  if (op === '^') {
    return 5;
  }
  return null;
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly endPosition: number,
  ) {}

  atEnd(): boolean {
    return this.index >= this.tokens.length;
  }

  position(): number {
    return this.tokens[this.index]?.position ?? this.endPosition;
  }

  private peek(): Token | null {
    return this.tokens[this.index] ?? null;
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (token === undefined) {
      throw new ParseFailure('unexpected end of formula');
    }
    this.index += 1;
    return token;
  }

  parseExpression(minPrecedence: number): FormulaNode {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      if (token === null) {
        return left;
      }
      if (token.type === 'percent') {
        this.index += 1;
        left = { kind: 'percent', operand: left };
        continue;
      }
      if (token.type !== 'operator') {
        return left;
      }
      const precedence = binaryPrecedence(token.text);
      if (precedence === null || precedence < minPrecedence) {
        return left;
      }
      this.index += 1;
      const right = this.parseExpression(precedence + 1);
      left = { kind: 'binary', op: token.text as BinaryOperator, left, right };
    }
  }

  private parseUnary(): FormulaNode {
    const token = this.peek();
    if (token !== null && token.type === 'operator' && (token.text === '-' || token.text === '+')) {
      this.index += 1;
      return { kind: 'unary', op: token.text, operand: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): FormulaNode {
    let node = this.parsePrimary();
    for (;;) {
      const token = this.peek();
      if (token !== null && token.type === 'percent') {
        this.index += 1;
        node = { kind: 'percent', operand: node };
        continue;
      }
      return node;
    }
  }

  private parsePrimary(): FormulaNode {
    const token = this.next();
    switch (token.type) {
      case 'number': {
        const value = Number(token.text);
        if (!Number.isFinite(value)) {
          throw new ParseFailure(`not a number: ${token.text}`);
        }
        return { kind: 'number', value };
      }
      case 'string':
        return { kind: 'string', value: token.text };
      case 'ref': {
        const start = parseA1(token.text);
        if (start === null) {
          throw new ParseFailure(`not a reference: ${token.text}`);
        }
        const colon = this.peek();
        if (colon !== null && colon.type === 'colon') {
          this.index += 1;
          const endToken = this.next();
          if (endToken.type !== 'ref') {
            throw new ParseFailure('range must end in a reference');
          }
          const end = parseA1(endToken.text);
          if (end === null) {
            throw new ParseFailure(`not a reference: ${endToken.text}`);
          }
          return { kind: 'range', start, end };
        }
        return { kind: 'ref', ref: start };
      }
      case 'field':
        return { kind: 'field', name: token.text };
      case 'name': {
        const upper = token.text.toUpperCase();
        if (upper === 'TRUE') {
          return { kind: 'boolean', value: true };
        }
        if (upper === 'FALSE') {
          return { kind: 'boolean', value: false };
        }
        const open = this.peek();
        if (open?.type !== 'open') {
          // A bare name is not a value; spreadsheets call this #NAME? but at
          // parse time it is simply not a formula we accept.
          throw new ParseFailure(`bare name: ${token.text}`);
        }
        this.index += 1;
        const args: FormulaNode[] = [];
        const first = this.peek();
        if (first !== null && first.type === 'close') {
          this.index += 1;
          return { kind: 'call', name: upper, args };
        }
        for (;;) {
          args.push(this.parseExpression(0));
          const separator = this.next();
          if (separator.type === 'close') {
            return { kind: 'call', name: upper, args };
          }
          if (separator.type !== 'comma') {
            throw new ParseFailure('expected , or ) in argument list');
          }
        }
      }
      case 'open': {
        const inner = this.parseExpression(0);
        const close = this.next();
        if (close.type !== 'close') {
          throw new ParseFailure('expected )');
        }
        return inner;
      }
      default:
        throw new ParseFailure(`unexpected token: ${token.text}`);
    }
  }
}
