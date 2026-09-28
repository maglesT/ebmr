/**
 * Canonical printer. print(parse(s)) is the canonical form of s, and parse(print(ast)) gives back
 * the same tree (ignoring spans): the round-trip law is a property test. Canonical form: single
 * spaces around binary operators and ":"/"?", no redundant parentheses, literals as written.
 */
import type { Expr } from './ast.ts';

const PRECEDENCE: Readonly<Record<string, number>> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
};
const UNARY = 7;
const PRIMARY = 8;
const CONDITIONAL = 0;

function precedenceOf(e: Expr): number {
  switch (e.type) {
    case 'Binary':
      return PRECEDENCE[e.op] ?? 0;
    case 'Unary':
      return UNARY;
    case 'Conditional':
      return CONDITIONAL;
    default:
      return PRIMARY;
  }
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function wrap(text: string, needed: boolean): string {
  return needed ? `(${text})` : text;
}

export function print(e: Expr): string {
  switch (e.type) {
    case 'Number':
      return e.unit === null ? e.text : `${e.text} [${e.unit}]`;
    case 'Unit':
      return `[${e.unit}]`;
    case 'String':
      return quote(e.value);
    case 'Bool':
      return e.value ? 'true' : 'false';
    case 'Path':
      return e.path;
    case 'Unary':
      return `${e.op}${wrap(print(e.operand), precedenceOf(e.operand) < UNARY)}`;
    case 'Binary': {
      const p = PRECEDENCE[e.op] ?? 0;
      const nonAssoc = p === 3 || p === 4;
      const lp = precedenceOf(e.left);
      const rp = precedenceOf(e.right);
      const left = wrap(print(e.left), lp < p || (nonAssoc && lp === p));
      const right = wrap(print(e.right), rp <= p);
      return `${left} ${e.op} ${right}`;
    }
    case 'Conditional': {
      const test = wrap(print(e.test), precedenceOf(e.test) === CONDITIONAL);
      const consequent = wrap(print(e.consequent), precedenceOf(e.consequent) === CONDITIONAL);
      return `${test} ? ${consequent} : ${print(e.alternate)}`;
    }
    case 'Call':
      return `${e.callee}(${e.args.map(print).join(', ')})`;
  }
}
