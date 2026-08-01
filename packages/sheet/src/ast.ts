import { type A1Ref } from './refs.js';

/**
 * The formula grammar's shape after parsing. Nodes carry no evaluation state;
 * the evaluator walks them against a cell reader and an op budget.
 */

export interface NumberNode {
  readonly kind: 'number';
  readonly value: number;
}

export interface StringNode {
  readonly kind: 'string';
  readonly value: string;
}

export interface BooleanNode {
  readonly kind: 'boolean';
  readonly value: boolean;
}

export interface RefNode {
  readonly kind: 'ref';
  readonly ref: A1Ref;
}

export interface RangeNode {
  readonly kind: 'range';
  readonly start: A1Ref;
  readonly end: A1Ref;
}

export type UnaryOperator = '-' | '+';

export interface UnaryNode {
  readonly kind: 'unary';
  readonly op: UnaryOperator;
  readonly operand: FormulaNode;
}

export interface PercentNode {
  readonly kind: 'percent';
  readonly operand: FormulaNode;
}

export type BinaryOperator =
  '+' | '-' | '*' | '/' | '^' | '&' | '=' | '<>' | '<' | '<=' | '>' | '>=';

export interface BinaryNode {
  readonly kind: 'binary';
  readonly op: BinaryOperator;
  readonly left: FormulaNode;
  readonly right: FormulaNode;
}

export interface CallNode {
  readonly kind: 'call';
  readonly name: string;
  readonly args: readonly FormulaNode[];
}

export type FormulaNode =
  | NumberNode
  | StringNode
  | BooleanNode
  | RefNode
  | RangeNode
  | UnaryNode
  | PercentNode
  | BinaryNode
  | CallNode;
