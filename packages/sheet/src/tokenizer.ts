/**
 * Lexer for formula text (the part after the leading '='). Malformed input
 * never throws out of the module boundary: tokenize reports failure through
 * its Result-shaped return, and the parser turns that into #PARSE!.
 */

export type TokenType =
  | 'number'
  | 'string'
  | 'ref'
  | 'name'
  | 'operator'
  | 'open'
  | 'close'
  | 'comma'
  | 'colon'
  | 'percent';

export interface Token {
  readonly type: TokenType;
  readonly text: string;
  readonly position: number;
}

export type TokenizeResult =
  | { readonly ok: true; readonly tokens: readonly Token[] }
  | { readonly ok: false; readonly position: number };

const OPERATOR_STARTS = new Set(['+', '-', '*', '/', '^', '&', '=', '<', '>']);
const REF_PATTERN = /^\$?[A-Za-z]{1,3}\$?[1-9][0-9]*/;
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.]*/;
const NUMBER_PATTERN = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/;

export function tokenize(text: string): TokenizeResult {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === undefined) {
      break;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'open', text: ch, position: i });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'close', text: ch, position: i });
      i += 1;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma', text: ch, position: i });
      i += 1;
      continue;
    }
    if (ch === ':') {
      tokens.push({ type: 'colon', text: ch, position: i });
      i += 1;
      continue;
    }
    if (ch === '%') {
      tokens.push({ type: 'percent', text: ch, position: i });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      let j = i + 1;
      let closed = false;
      while (j < text.length) {
        const c = text[j];
        if (c === '"') {
          if (text[j + 1] === '"') {
            value += '"';
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        value += c ?? '';
        j += 1;
      }
      if (!closed) {
        return { ok: false, position: i };
      }
      tokens.push({ type: 'string', text: value, position: i });
      i = j;
      continue;
    }
    if (OPERATOR_STARTS.has(ch)) {
      const two = text.slice(i, i + 2);
      if (two === '<>' || two === '<=' || two === '>=') {
        tokens.push({ type: 'operator', text: two, position: i });
        i += 2;
        continue;
      }
      tokens.push({ type: 'operator', text: ch, position: i });
      i += 1;
      continue;
    }
    const rest = text.slice(i);
    const numberMatch = NUMBER_PATTERN.exec(rest);
    if (numberMatch !== null && ((ch >= '0' && ch <= '9') || ch === '.')) {
      const matched = numberMatch[0];
      tokens.push({ type: 'number', text: matched, position: i });
      i += matched.length;
      continue;
    }
    const refMatch = REF_PATTERN.exec(rest);
    if (refMatch !== null) {
      const matched = refMatch[0];
      // A reference candidate followed by more name characters is a name after
      // all (e.g. "A1B" or a function like "LOG10" if one ever existed).
      const after = rest[matched.length];
      if (after === undefined || !/[A-Za-z0-9_.]/.test(after)) {
        tokens.push({ type: 'ref', text: matched, position: i });
        i += matched.length;
        continue;
      }
    }
    const nameMatch = NAME_PATTERN.exec(rest);
    if (nameMatch !== null && ch !== '$') {
      const matched = nameMatch[0];
      tokens.push({ type: 'name', text: matched, position: i });
      i += matched.length;
      continue;
    }
    return { ok: false, position: i };
  }
  return { ok: true, tokens };
}
