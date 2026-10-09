/**
 * The rule-table validator of the loader and the pure engine (the TypeScript copy of
 * market.validate_document), check by check: each refusal with its EBMR-MKT code and message, the
 * documents it must accept, and how a refused row drops out of the cross-row checks (build outline
 * 3.3.1, 3.3.5; ADR 0008; IN-52; INV-28). No database: rule-tables.test.ts shows, for representative
 * documents, that the SQL gate refuses them with the same codes.
 *
 * Row checks use the only India row of an India-governed key as the faulty row, so the expected
 * problems also include "no India (IN) row": a refused row must not count as India coverage.
 */
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { RuleTableProblem } from '../../src/market/errors.ts';
import { isValueType, validateRuleTableDocument, valueProblem, type ValidateOptions } from '../../src/market/validate.ts';

type Obj = Record<string, unknown>;

const K = 'kernel.t.interval';
const O = 'kernel.t.other';
const C = 'kernel.t.criteria';
const NOT_CANONICAL = 'is not a canonical decimal string (no exponent, no leading zeros, no trailing zeros)';
const NUMBERS = 'numbers must be written as quoted decimal strings, never as JSON numbers';

/** An India-governed SMALLER_STRICTER key (minutes). */
const key = (o: Obj = {}): Obj => ({ key: K, title: 'An interval', method: 'SMALLER_STRICTER', valueType: 'DECIMAL', unit: 'min', indiaGoverns: true, ...o });
/** Its India row, in force from 2024-01-01 without end. */
const row = (o: Obj = {}): Obj => ({
  ref: 'I.IN',
  key: K,
  market: 'IN',
  value: '30',
  unit: 'min',
  floor: 'HARD',
  source: 'test source',
  verification: 'P',
  effectiveFrom: '2024-01-01',
  ...o,
});
const doc = (keys: unknown = [key()], rows: unknown = [row()], o: Obj = {}): Obj => ({ table: 'kernel', version: 1, keys, rows, ...o });
const check = (d: unknown, options?: ValidateOptions): RuleTableProblem[] => validateRuleTableDocument(d, options);
const problem = (code: string, message: string): RuleTableProblem => ({ code, message });

/** A second key that India does not govern and that has no rows, to test one key check at a time. */
const other = (o: Obj): Obj => key({ key: O, title: 'Another key', indiaGoverns: false, ...o });
const withOther = (o: Obj): RuleTableProblem[] => check(doc([key(), other(o)]));

/** The coverage problem that follows when the only India row of the interval key is refused. */
const NO_INDIA_ROW = problem('EBMR-MKT-026', `key ${K} is governed by India but has no India (IN) row`);
const INDIA_GAP = problem('EBMR-MKT-026', `key ${K} is governed by India but India (IN) rows leave a gap in the effective period`);
/** Problems of a document whose only India row has one problem. */
const rowRefused = (code: string, message: string): RuleTableProblem[] => [problem(code, message), NO_INDIA_ROW];

describe('valueProblem: the shape of a rule value for its value type', () => {
  it('[IN-52] a missing value is refused for every value type', () => {
    for (const type of ['DECIMAL', 'BOOLEAN', 'CATEGORY', 'SET', 'CRITERIA', 'ANY']) {
      expect(valueProblem(type, ['A'], undefined)).toBe('the value is missing');
      expect(valueProblem(type, ['A'], null)).toBe('the value is missing');
    }
  });

  it('[IN-52] a number anywhere in a value is refused, also as a bigint from a parser that reads integers as bigints', () => {
    expect(valueProblem('DECIMAL', null, 30)).toBe(NUMBERS);
    expect(valueProblem('ANY', null, 30)).toBe(NUMBERS);
    expect(valueProblem('ANY', null, ['a', [{ limit: 1 }]])).toBe(NUMBERS);
    const fromYaml = parseYaml('limit: { percent: 5 }', { intAsBigInt: true }) as Obj;
    expect(typeof (fromYaml['limit'] as Obj)['percent']).toBe('bigint');
    expect(valueProblem('ANY', null, fromYaml)).toBe(NUMBERS);
    expect(valueProblem('ANY', null, 30n)).toBe(NUMBERS);
    expect(valueProblem('ANY', null, ['a', { b: 'c', d: [true, false] }])).toBeNull();
  });

  it('[IN-52] DECIMAL values are canonical decimal strings', () => {
    expect(valueProblem('DECIMAL', null, '7.5')).toBeNull();
    expect(valueProblem('DECIMAL', null, '-0.25')).toBeNull();
    expect(valueProblem('DECIMAL', null, '7.50')).toBe(`"7.50" ${NOT_CANONICAL}`);
    expect(valueProblem('DECIMAL', null, '1e3')).toBe(`"1e3" ${NOT_CANONICAL}`);
    expect(valueProblem('DECIMAL', null, true)).toBe(`true ${NOT_CANONICAL}`);
  });

  it('[IN-52] BOOLEAN values are true or false, not text', () => {
    expect(valueProblem('BOOLEAN', null, true)).toBeNull();
    expect(valueProblem('BOOLEAN', null, false)).toBeNull();
    expect(valueProblem('BOOLEAN', null, 'true')).toBe('"true" is not a boolean');
  });

  it('[IN-52] CATEGORY values are text from the key\'s ordered list', () => {
    expect(valueProblem('CATEGORY', ['LOW', 'HIGH'], 'HIGH')).toBeNull();
    expect(valueProblem('CATEGORY', ['LOW', 'HIGH'], 'MEDIUM')).toBe('"MEDIUM" is not one of the ordered values');
    // Without an ordered list (or with text in its place) no category is valid.
    expect(valueProblem('CATEGORY', null, 'HIGH')).toBe('"HIGH" is not one of the ordered values');
    expect(valueProblem('CATEGORY', 'LOW HIGH', 'HIGH')).toBe('"HIGH" is not one of the ordered values');
    // A category is text even when a (malformed) ordered list holds the same non-text value.
    expect(valueProblem('CATEGORY', [true], true)).toBe('true is not one of the ordered values');
  });

  it('[IN-52] SET values are arrays of distinct identifiers', () => {
    expect(valueProblem('SET', null, ['IP', 'BP_2024', 'Ph.Eur'])).toBeNull();
    expect(valueProblem('SET', null, [])).toBeNull();
    expect(valueProblem('SET', null, 'IP')).toBe('a set value must be an array of identifiers');
    expect(valueProblem('SET', null, ['IP', '-BP'])).toBe('set element "-BP" is not an identifier');
    expect(valueProblem('SET', null, ['IP', 'B P'])).toBe('set element "B P" is not an identifier');
    expect(valueProblem('SET', null, ['IP', true])).toBe('set element true is not an identifier');
    expect(valueProblem('SET', null, ['IP', 'BP', 'IP'])).toBe('set element "IP" is repeated');
  });

  it('[IN-52] CRITERIA values are arrays of criterion objects with distinct identifiers', () => {
    expect(valueProblem('CRITERIA', null, [{ id: 'C1', limit: '5' }, { id: 'C2' }])).toBeNull();
    expect(valueProblem('CRITERIA', null, [])).toBeNull();
    expect(valueProblem('CRITERIA', null, { id: 'C1' })).toBe('a criteria value must be an array of criterion objects');
    for (const bad of [['C1'], [null], [[{ id: 'C1' }]], [{ id: '-C1' }], [{ name: 'C1' }], [{ id: true }]]) {
      expect(valueProblem('CRITERIA', null, bad)).toBe('every criterion must be an object with an identifier in "id"');
    }
    expect(valueProblem('CRITERIA', null, [{ id: 'C1', limit: '5' }, { id: 'C2' }, { id: 'C1', limit: '6' }])).toBe('criterion C1 is repeated');
  });

  it('[IN-52] ANY accepts any value without numbers; an unknown value type is named', () => {
    expect(valueProblem('ANY', null, 'text')).toBeNull();
    expect(valueProblem('ANY', null, [{ stage: 'S1' }, true])).toBeNull();
    expect(valueProblem('FLOAT', null, '1')).toBe('unknown value type FLOAT');
    expect(valueProblem(undefined, null, '1')).toBe('unknown value type (missing)');
    expect(valueProblem(['DECIMAL'], null, '1')).toBe('unknown value type (missing)');
  });
});

describe('isValueType', () => {
  it('[meta] accepts exactly the six value type names', () => {
    for (const t of ['DECIMAL', 'BOOLEAN', 'CATEGORY', 'SET', 'CRITERIA', 'ANY']) expect(isValueType(t)).toBe(true);
    for (const t of ['decimal', 'FLOAT', '', ['DECIMAL'], undefined, null]) expect(isValueType(t)).toBe(false);
  });
});

describe('the document', () => {
  it('[IN-52] a document that is not a JSON object is refused and nothing else is checked', () => {
    for (const d of [null, undefined, 'kernel', true, [doc()]]) {
      expect(check(d)).toEqual([problem('EBMR-MKT-010', 'a rule-table document must be a JSON object')]);
    }
  });

  it('[IN-52] a minimal document and a document using every optional field are accepted', () => {
    expect(check(doc())).toEqual([]);
    const full = doc(
      [
        key({
          method: 'ORDERED',
          valueType: 'CATEGORY',
          unit: 'grade',
          orderedValues: ['LOW', 'HIGH'],
          statedMethod: null,
          predicates: { licenceForm: ['FORM_25', 'FORM_28'], sterile: [true, false] },
          catalogRefs: ['B-01', 'DI-02', 'PR-03', 'ST-04', 'IN-08'],
          description: 'a key with every field',
        }),
      ],
      [
        row({ unit: 'grade', value: 'HIGH', floor: 'GUIDANCE', hardFloor: 'LOW', predicate: {}, effectiveTo: null, note: 'a note' }),
        row({ ref: 'I.IN.f28', unit: 'grade', value: 'HIGH', predicate: { licenceForm: 'FORM_28', sterile: true }, verification: 'P~' }),
      ],
      { title: 'A table', change: { kind: 'INITIAL', description: 'first version' } },
    );
    expect(check(full)).toEqual([]);
  });

  it('[IN-52] unknown document fields are named and the rest of the document is still checked', () => {
    expect(check(doc([key({ title: '' })], [row()], { extra: 'x', notes: 'y' }))).toEqual([
      problem('EBMR-MKT-010', 'unknown document field "extra"'),
      problem('EBMR-MKT-010', 'unknown document field "notes"'),
      problem('EBMR-MKT-010', `key ${K} needs a title`),
    ]);
  });

  it('[IN-52] an unknown rule table is refused and nothing else is checked', () => {
    expect(check(doc([key({ title: '' })], 'x', { table: 'sterile2' }))).toEqual([problem('EBMR-MKT-011', 'unknown rule table "sterile2"')]);
    expect(check({ version: 0, keys: [], rows: 'x' })).toEqual([problem('EBMR-MKT-011', 'unknown rule table "(missing)"')]);
    expect(check(doc(undefined, undefined, { table: 7 }))).toEqual([problem('EBMR-MKT-011', 'unknown rule table "(missing)"')]);
    // A table name is looked up as text among the tables' own entries, never through coercion or the prototype.
    expect(check(doc(undefined, undefined, { table: ['kernel'] }))).toEqual([problem('EBMR-MKT-011', 'unknown rule table "(missing)"')]);
    expect(check(doc(undefined, undefined, { table: 'toString' }))).toEqual([problem('EBMR-MKT-011', 'unknown rule table "toString"')]);
    expect(check(doc(undefined, undefined, { table: 'constructor' }))).toEqual([problem('EBMR-MKT-011', 'unknown rule table "constructor"')]);
  });

  it('[IN-52] the rule tables can be given (market.rule_table); the table decides the key namespace', () => {
    const tables = { lab: 'lab.' };
    const lab = doc([key({ key: 'lab.t.interval' })], [row({ key: 'lab.t.interval' })], { table: 'lab' });
    expect(check(lab, { tables })).toEqual([]);
    expect(check(lab)).toEqual([problem('EBMR-MKT-011', 'unknown rule table "lab"')]);
    expect(check(doc(), { tables })).toEqual([problem('EBMR-MKT-011', 'unknown rule table "kernel"')]);
  });

  it('[IN-52] the version must be an integer from 1 to 999999', () => {
    for (const version of [1, 2, 999999]) expect(check(doc(undefined, undefined, { version }))).toEqual([]);
    for (const version of [undefined, null, '1', true, 1.5, 0, -1, 1000000]) {
      expect(check(doc(undefined, undefined, { version }))).toEqual([problem('EBMR-MKT-010', 'version must be a positive integer')]);
    }
  });

  it('[IN-52] keys must be a non-empty array; without keys nothing else is checked', () => {
    for (const keys of [undefined, 'kernel.t.interval', {}, { length: 0 }, []]) {
      expect(check({ ...doc(), keys, rows: 'x' })).toEqual([problem('EBMR-MKT-010', 'keys must be a non-empty array')]);
    }
  });

  it('[IN-52] rows must be an array; without rows no key is checked', () => {
    for (const rows of [undefined, 'I.IN', {}]) {
      expect(check({ ...doc([key({ title: '' })]), rows })).toEqual([problem('EBMR-MKT-010', 'rows must be an array')]);
    }
    expect(check(doc([key()], []))).toEqual([NO_INDIA_ROW]);
    expect(check(doc([other({})], []))).toEqual([]);
  });
});

describe('keys', () => {
  it('[IN-52] every key must be an object; the other keys are still checked', () => {
    const problems = check(doc([key(), K, null, [key()]]));
    expect(problems).toEqual([
      problem('EBMR-MKT-010', 'every key must be an object'),
      problem('EBMR-MKT-010', 'every key must be an object'),
      problem('EBMR-MKT-010', 'every key must be an object'),
    ]);
  });

  it('[IN-52] unknown key fields are named, with the key name when it is text', () => {
    expect(check(doc([key({ extra: 'x' })]))).toEqual([problem('EBMR-MKT-010', `key ${K}: unknown field "extra"`)]);
    expect(check(doc([key(), { key: 5, extra: 'x' }]))).toEqual([
      problem('EBMR-MKT-010', 'key ?: unknown field "extra"'),
      problem('EBMR-MKT-013', 'key name (missing) is not a dotted identifier'),
    ]);
  });

  it('[IN-52] a key name must be a dotted identifier; a refused key is not defined for its rows', () => {
    for (const name of ['kernel', 'Kernel.t.x', 'kernel.t x', 'kernel.t.', 'kernel.1x']) {
      expect(withOther({ key: name })).toEqual([problem('EBMR-MKT-013', `key name ${name} is not a dotted identifier`)]);
    }
    for (const name of [undefined, ['kernel.t.other']]) {
      expect(withOther({ key: name })).toEqual([problem('EBMR-MKT-013', 'key name (missing) is not a dotted identifier')]);
    }
    expect(check(doc([key({ key: 'Kernel.t.interval' })]))).toEqual([
      problem('EBMR-MKT-013', 'key name Kernel.t.interval is not a dotted identifier'),
      problem('EBMR-MKT-017', `row I.IN refers to key ${K}, which this table does not define`),
    ]);
  });

  it('[IN-52] a key outside the table\'s namespace is refused (the prefix includes the dot)', () => {
    expect(withOther({ key: 'tablets.t.other' })).toEqual([problem('EBMR-MKT-013', 'key tablets.t.other does not belong to table kernel (namespace kernel.*)')]);
    expect(withOther({ key: 'kernelx.t.other' })).toEqual([problem('EBMR-MKT-013', 'key kernelx.t.other does not belong to table kernel (namespace kernel.*)')]);
  });

  it('[IN-52] a key defined twice is refused; the first definition is the one its rows use', () => {
    expect(check(doc([key(), key({ title: '', unit: 'h' })]))).toEqual([problem('EBMR-MKT-013', `key ${K} is defined twice`)]);
  });

  it('[IN-52] a key needs a title that is not blank', () => {
    for (const title of [undefined, '', '   ', true]) expect(withOther({ title })).toEqual([problem('EBMR-MKT-010', `key ${O} needs a title`)]);
    expect(withOther({ title: ' T ' })).toEqual([]);
  });

  it('[IN-52] a description, when given, is text', () => {
    for (const description of ['text', null, undefined]) expect(withOther({ description })).toEqual([]);
    for (const description of [true, ['text']]) expect(withOther({ description })).toEqual([problem('EBMR-MKT-010', `key ${O}: description must be text`)]);
  });

  it('[IN-52] indiaGoverns must be true or false', () => {
    expect(withOther({ indiaGoverns: undefined })).toEqual([problem('EBMR-MKT-010', `key ${O}: indiaGoverns must be true or false`)]);
    expect(withOther({ indiaGoverns: 'false' })).toEqual([problem('EBMR-MKT-010', `key ${O}: indiaGoverns must be true or false`)]);
  });

  it('[IN-52] catalogRefs, when given, list control ids such as B-01, DI-02, PR-03, ST-04 or IN-08', () => {
    for (const catalogRefs of [[], ['B-01', 'DI-02', 'PR-03', 'ST-04', 'IN-08'], null, undefined]) expect(withOther({ catalogRefs })).toEqual([]);
    for (const catalogRefs of ['B-01', {}, ['B-1'], ['XB-01'], ['B-012'], ['B-01', 'Q-01'], [true], [['B-01']]]) {
      expect(withOther({ catalogRefs })).toEqual([problem('EBMR-MKT-010', `key ${O}: catalogRefs must list ids such as B-01 or IN-08`)]);
    }
  });

  it('[IN-52] a key needs a unit of 1 to 40 characters without white space', () => {
    for (const unit of ['%', 'mg/kg', 'x'.repeat(40)]) expect(withOther({ unit })).toEqual([]);
    for (const unit of [undefined, '', 'a b', ' min', 'min ', 'x'.repeat(41), true]) {
      expect(withOther({ unit })).toEqual([problem('EBMR-MKT-010', `key ${O} needs a unit`)]);
    }
  });

  it('[IN-52] an unknown comparison method and an unknown value type are refused and named', () => {
    expect(withOther({ method: 'STRICTEST' })).toEqual([problem('EBMR-MKT-014', `key ${O}: unknown comparison method STRICTEST`)]);
    expect(withOther({ method: undefined })).toEqual([problem('EBMR-MKT-014', `key ${O}: unknown comparison method (missing)`)]);
    expect(withOther({ method: true })).toEqual([problem('EBMR-MKT-014', `key ${O}: unknown comparison method (missing)`)]);
    expect(withOther({ valueType: 'FLOAT' })).toEqual([problem('EBMR-MKT-015', `key ${O}: unknown value type FLOAT`)]);
    expect(withOther({ valueType: undefined })).toEqual([problem('EBMR-MKT-015', `key ${O}: unknown value type (missing)`)]);
    expect(withOther({ valueType: ['DECIMAL'] })).toEqual([problem('EBMR-MKT-015', `key ${O}: unknown value type (missing)`)]);
    expect(withOther({ method: 'STRICTEST', valueType: 'BOOLEAN' })).toEqual([problem('EBMR-MKT-014', `key ${O}: unknown comparison method STRICTEST`)]);
  });

  it('[IN-52] a scalar comparison method on a multi-component value type is refused', () => {
    for (const [method, valueType] of [
      ['SMALLER_STRICTER', 'SET'],
      ['LARGER_STRICTER', 'CRITERIA'],
      ['ORDERED', 'ANY'],
      ['REQUIRED_IF_ANY', 'SET'],
    ] as const) {
      const orderedValues = method === 'ORDERED' ? ['LOW', 'HIGH'] : undefined;
      expect(withOther({ method, valueType, orderedValues })).toEqual([
        problem('EBMR-MKT-015', `key ${O}: scalar method ${method} on a multi-component key (value type ${valueType})`),
      ]);
    }
  });

  it('[IN-52] each comparison method takes only its own value type; NOT_COMPARABLE takes any', () => {
    const fits = [
      ['SMALLER_STRICTER', 'DECIMAL'],
      ['LARGER_STRICTER', 'DECIMAL'],
      ['ORDERED', 'CATEGORY'],
      ['REQUIRED_IF_ANY', 'BOOLEAN'],
      ['SET_UNION', 'SET'],
      ['ALL_APPLY', 'CRITERIA'],
      ['NOT_COMPARABLE', 'ANY'],
      ['NOT_COMPARABLE', 'DECIMAL'],
    ] as const;
    const misfits = [
      ['SMALLER_STRICTER', 'BOOLEAN'],
      ['LARGER_STRICTER', 'CATEGORY'],
      ['ORDERED', 'DECIMAL'],
      ['REQUIRED_IF_ANY', 'DECIMAL'],
      ['SET_UNION', 'CRITERIA'],
      ['ALL_APPLY', 'SET'],
      ['ALL_APPLY', 'ANY'],
    ] as const;
    const shape = (method: string, valueType: string): Obj => ({
      method,
      valueType,
      orderedValues: method === 'ORDERED' || valueType === 'CATEGORY' ? ['LOW', 'HIGH'] : undefined,
      statedMethod: method === 'NOT_COMPARABLE' ? 'PER_DESTINATION' : undefined,
    });
    for (const [method, valueType] of fits) expect(withOther(shape(method, valueType))).toEqual([]);
    for (const [method, valueType] of misfits) {
      expect(withOther(shape(method, valueType))).toEqual([problem('EBMR-MKT-015', `key ${O}: method ${method} does not fit value type ${valueType}`)]);
    }
  });

  it('[IN-52] ORDERED and CATEGORY keys list distinct identifiers from least to most strict; other keys have no list', () => {
    const MUST_LIST = problem('EBMR-MKT-016', `key ${O}: orderedValues must list distinct identifiers from least to most strict`);
    const ordered = (orderedValues: unknown): Obj => ({ method: 'ORDERED', valueType: 'CATEGORY', orderedValues });
    expect(withOther(ordered(['LOW', 'HIGH']))).toEqual([]);
    for (const list of [undefined, null, 'LOW', [], ['LOW', '-x'], ['-x', 'LOW'], ['LOW', true], ['LOW', 'HIGH', 'LOW']]) {
      expect(withOther(ordered(list))).toEqual([MUST_LIST]);
    }
    // The list is required by either the method or the value type.
    expect(withOther({ method: 'ORDERED', valueType: 'DECIMAL' })).toEqual([
      problem('EBMR-MKT-015', `key ${O}: method ORDERED does not fit value type DECIMAL`),
      MUST_LIST,
    ]);
    expect(withOther({ method: 'NOT_COMPARABLE', valueType: 'CATEGORY', statedMethod: 'PER_DESTINATION' })).toEqual([MUST_LIST]);
    expect(withOther({ method: 'NOT_COMPARABLE', valueType: 'CATEGORY', statedMethod: 'PER_DESTINATION', orderedValues: ['A'] })).toEqual([]);
    expect(withOther({ orderedValues: ['LOW', 'HIGH'] })).toEqual([problem('EBMR-MKT-016', `key ${O}: orderedValues is only for ORDERED keys`)]);
    expect(withOther({ orderedValues: null })).toEqual([]);
  });

  it('[IN-52] a NOT_COMPARABLE key states its method (PER_DESTINATION); other keys state none', () => {
    const notComparable = (statedMethod: unknown): Obj => ({ method: 'NOT_COMPARABLE', valueType: 'ANY', statedMethod });
    expect(withOther(notComparable('PER_DESTINATION'))).toEqual([]);
    for (const stated of [undefined, 'STRICTEST']) {
      expect(withOther(notComparable(stated))).toEqual([problem('EBMR-MKT-016', `key ${O}: a NOT_COMPARABLE key needs a stated method (PER_DESTINATION)`)]);
    }
    expect(withOther({ statedMethod: 'PER_DESTINATION' })).toEqual([problem('EBMR-MKT-016', `key ${O}: statedMethod is only for NOT_COMPARABLE keys`)]);
    expect(withOther({ statedMethod: null })).toEqual([]);
  });

  it('[IN-52] predicates map attribute names to lists of distinct text or true/false values', () => {
    for (const predicates of [undefined, null, {}, { licenceForm: ['FORM_25', 'FORM_28'], sterile: [true, false], mixed: ['A', true] }]) {
      expect(withOther({ predicates })).toEqual([]);
    }
    for (const predicates of ['licenceForm', ['licenceForm']]) {
      expect(withOther({ predicates })).toEqual([problem('EBMR-MKT-022', `key ${O}: predicates must map attribute names to their allowed values`)]);
    }
    const attrProblem = (attr: string) => problem('EBMR-MKT-022', `key ${O}: predicate ${attr} needs a list of distinct text or true/false values`);
    for (const attr of ['Licence', 'xLicence-form', '1form', 'licence_form']) expect(withOther({ predicates: { [attr]: ['A'] } })).toEqual([attrProblem(attr)]);
    for (const allowed of ['A', {}, [], [null], ['A', null], ['A', ['B']], ['A', 'A'], [true, true]]) {
      expect(withOther({ predicates: { ok: ['A'], form: allowed } })).toEqual([attrProblem('form')]);
    }
    expect(withOther({ predicates: { Bad: ['A'], form: [] } })).toEqual([attrProblem('Bad'), attrProblem('form')]);
  });
});

describe('rows', () => {
  it('[IN-52] every row must be an object; the other rows are still checked', () => {
    expect(check(doc([key()], [row(), 'I.IN', null, [row()]]))).toEqual([
      problem('EBMR-MKT-010', 'every row must be an object'),
      problem('EBMR-MKT-010', 'every row must be an object'),
      problem('EBMR-MKT-010', 'every row must be an object'),
    ]);
  });

  it('[IN-52] unknown row fields are named, with the row ref when it is text', () => {
    // An unknown field is reported but does not take the row out of the cross-row checks.
    expect(check(doc([key()], [row({ extra: 'x', remarks: 'y' })]))).toEqual([
      problem('EBMR-MKT-010', 'row I.IN: unknown field "extra"'),
      problem('EBMR-MKT-010', 'row I.IN: unknown field "remarks"'),
    ]);
    expect(check(doc([key()], [row({ ref: 7, extra: 'x' })]))).toEqual([
      problem('EBMR-MKT-010', 'row ?: unknown field "extra"'),
      problem('EBMR-MKT-029', 'row ? needs an identifier in "ref"'),
      NO_INDIA_ROW,
    ]);
  });

  it('[IN-52] a row needs an identifier in "ref", used once', () => {
    expect(check(doc([key()], [row({ ref: '-I.IN' })]))).toEqual(rowRefused('EBMR-MKT-029', 'row -I.IN needs an identifier in "ref"'));
    expect(check(doc([key()], [row({ ref: undefined })]))).toEqual(rowRefused('EBMR-MKT-029', 'row ? needs an identifier in "ref"'));
    const retention = key({ key: 'kernel.t.retention', method: 'LARGER_STRICTER', unit: 'mo' });
    expect(check(doc([key(), retention], [row(), row({ key: 'kernel.t.retention', unit: 'mo', value: '12' })]))).toEqual([
      problem('EBMR-MKT-029', 'row ref I.IN is used twice'),
      problem('EBMR-MKT-026', 'key kernel.t.retention is governed by India but has no India (IN) row'),
    ]);
  });

  it('[IN-52] a row must refer to a key this table defines', () => {
    expect(check(doc([key()], [row({ key: 'kernel.t.nope' })]))).toEqual(
      rowRefused('EBMR-MKT-017', 'row I.IN refers to key kernel.t.nope, which this table does not define'),
    );
    for (const k of [undefined, 5]) {
      expect(check(doc([key()], [row({ key: k })]))).toEqual(rowRefused('EBMR-MKT-017', 'row I.IN refers to key (missing), which this table does not define'));
    }
  });

  it('[IN-52] a row\'s market must be known; a refused row does not extend the period India must cover', () => {
    // India covers 2024; a valid row of another market without end would extend that period.
    const india2024 = row({ effectiveTo: '2025-01-01' });
    expect(check(doc([key()], [india2024, row({ ref: 'I.XX', market: 'XX', value: '20' })]))).toEqual([problem('EBMR-MKT-018', 'row I.XX: unknown market XX')]);
    expect(check(doc([key()], [india2024, row({ ref: 'I.XX', market: undefined, value: '20' })]))).toEqual([
      problem('EBMR-MKT-018', 'row I.XX: unknown market (missing)'),
    ]);
    expect(check(doc([key()], [india2024, row({ ref: 'I.EU', market: 'EU', value: '20' })]))).toEqual([INDIA_GAP]);
    const us = doc([key()], [row(), row({ ref: 'I.US', market: 'US', value: '20' })]);
    expect(check(us)).toEqual([]);
    expect(check(us, { knownMarkets: ['IN', 'EU'] })).toEqual([problem('EBMR-MKT-018', 'row I.US: unknown market US')]);
  });

  it('[IN-52] a row\'s unit must be its key\'s unit', () => {
    expect(check(doc([key()], [row({ unit: 'h' })]))).toEqual(rowRefused('EBMR-MKT-019', `row I.IN: unit h does not match the unit min of key ${K}`));
    expect(check(doc([key()], [row({ unit: undefined })]))).toEqual(rowRefused('EBMR-MKT-019', `row I.IN: unit (missing) does not match the unit min of key ${K}`));
  });

  it('[IN-52] a row\'s value must have the shape of its key\'s value type', () => {
    expect(check(doc([key()], [row({ value: '7.50' })]))).toEqual(rowRefused('EBMR-MKT-020', `row I.IN: "7.50" ${NOT_CANONICAL}`));
    expect(check(doc([key()], [row({ value: 30 })]))).toEqual(rowRefused('EBMR-MKT-020', `row I.IN: ${NUMBERS}`));
    expect(check(doc([key()], [row({ value: undefined })]))).toEqual(rowRefused('EBMR-MKT-020', 'row I.IN: the value is missing'));
  });

  it('[IN-52] a row\'s floor type and verification status come from their lists', () => {
    for (const floor of ['HARD', 'GUIDANCE', 'EXAMPLE', 'DESIGN']) expect(check(doc([key()], [row({ floor })]))).toEqual([]);
    for (const floor of ['SOFT', undefined]) {
      expect(check(doc([key()], [row({ floor })]))).toEqual(rowRefused('EBMR-MKT-021', 'row I.IN: floor must be HARD, GUIDANCE, EXAMPLE or DESIGN'));
    }
    for (const verification of ['P', 'P~', 'S', 'U', 'CHK', 'GK']) expect(check(doc([key()], [row({ verification })]))).toEqual([]);
    for (const verification of ['X', undefined]) {
      expect(check(doc([key()], [row({ verification })]))).toEqual(rowRefused('EBMR-MKT-021', 'row I.IN: verification must be P, P~, S, U, CHK or GK'));
    }
  });

  it('[IN-52] a row cites a source that is not blank; a note, when given, is text', () => {
    for (const source of [undefined, '', '   ', true]) {
      expect(check(doc([key()], [row({ source })]))).toEqual(rowRefused('EBMR-MKT-021', 'row I.IN needs a source citation'));
    }
    for (const note of ['a note', null, undefined]) expect(check(doc([key()], [row({ note })]))).toEqual([]);
    for (const note of [true, ['a note']]) expect(check(doc([key()], [row({ note })]))).toEqual(rowRefused('EBMR-MKT-021', 'row I.IN: note must be text'));
  });

  it('[IN-52] a row is in force from a real date written YYYY-MM-DD until an optional later date', () => {
    const FROM = 'row I.IN: effectiveFrom must be a date written YYYY-MM-DD';
    const TO = 'row I.IN: effectiveTo must be a date after effectiveFrom';
    for (const effectiveFrom of [undefined, '2024-02-30', '2024-1-01', '01-01-2024']) {
      expect(check(doc([key()], [row({ effectiveFrom })]))).toEqual(rowRefused('EBMR-MKT-021', FROM));
    }
    for (const effectiveTo of [null, undefined, '2024-01-02']) expect(check(doc([key()], [row({ effectiveTo })]))).toEqual([]);
    for (const effectiveTo of ['2023-12-31', '2024-01-01', 'never', '2024-13-01', true]) {
      expect(check(doc([key()], [row({ effectiveTo })]))).toEqual(rowRefused('EBMR-MKT-021', TO));
    }
    // Without a valid start the end is only checked for being a date.
    expect(check(doc([key()], [row({ effectiveFrom: '2024-02-30', effectiveTo: '2023-01-01' })]))).toEqual(rowRefused('EBMR-MKT-021', FROM));
    expect(check(doc([key()], [row({ effectiveFrom: '2024-02-30', effectiveTo: 'never' })]))).toEqual([
      problem('EBMR-MKT-021', FROM),
      problem('EBMR-MKT-021', TO),
      NO_INDIA_ROW,
    ]);
  });

  it('[IN-52] a row\'s predicate is an object of attributes and values its key declares', () => {
    const declared = key({ predicates: { licenceForm: ['FORM_25', 'FORM_28'], sterile: [true, false] } });
    expect(check(doc([declared], [row({ predicate: { licenceForm: 'FORM_28', sterile: false } })]))).toEqual([]);
    expect(check(doc([declared], [row({ predicate: null })]))).toEqual([]);
    for (const predicate of ['FORM_25', ['FORM_25']]) {
      expect(check(doc([declared], [row({ predicate })]))).toEqual(rowRefused('EBMR-MKT-022', 'row I.IN: predicate must be an object'));
    }
    expect(check(doc([declared], [row({ predicate: { licenceForm: 'FORM_99' } })]))).toEqual(
      rowRefused('EBMR-MKT-022', `row I.IN: predicate licenceForm = "FORM_99" is not declared on key ${K}`),
    );
    expect(check(doc([declared], [row({ predicate: { licenceForm: 'FORM_25', expiry: true } })]))).toEqual(
      rowRefused('EBMR-MKT-022', `row I.IN: predicate expiry = true is not declared on key ${K}`),
    );
    expect(check(doc([key()], [row({ predicate: { licenceForm: 'FORM_25' } })]))).toEqual(
      rowRefused('EBMR-MKT-022', `row I.IN: predicate licenceForm = "FORM_25" is not declared on key ${K}`),
    );
    // A key whose predicates are not a map declares nothing.
    expect(check(doc([key({ predicates: ['licenceForm'] })], [row({ predicate: { licenceForm: 'FORM_25' } })]))).toEqual([
      problem('EBMR-MKT-022', `key ${K}: predicates must map attribute names to their allowed values`),
      problem('EBMR-MKT-022', `row I.IN: predicate licenceForm = "FORM_25" is not declared on key ${K}`),
      NO_INDIA_ROW,
    ]);
  });
});

describe('hard floors', () => {
  it('[IN-52] a GUIDANCE, EXAMPLE or DESIGN value may carry a hard floor it is at least as strict as', () => {
    expect(check(doc([key()], [row({ floor: 'DESIGN', value: '20', hardFloor: '30' })]))).toEqual([]);
    expect(check(doc([key()], [row({ floor: 'GUIDANCE', hardFloor: '30' })]))).toEqual([]);
    expect(check(doc([key()], [row({ floor: 'EXAMPLE', hardFloor: null })]))).toEqual([]);
  });

  it('[IN-52] a HARD value is its own floor and takes no hard floor', () => {
    expect(check(doc([key()], [row({ hardFloor: '30' })]))).toEqual(
      rowRefused('EBMR-MKT-023', 'row I.IN: a HARD value is its own floor; hardFloor is only for GUIDANCE, EXAMPLE or DESIGN values'),
    );
  });

  it('[IN-52] a NOT_COMPARABLE key has no hard floor', () => {
    const perDestination = key({ method: 'NOT_COMPARABLE', valueType: 'ANY', statedMethod: 'PER_DESTINATION' });
    expect(check(doc([perDestination], [row({ floor: 'DESIGN', value: 'BY_DESTINATION', hardFloor: 'IN_RULE' })]))).toEqual(
      rowRefused('EBMR-MKT-023', 'row I.IN: a NOT_COMPARABLE key has no hard floor'),
    );
  });

  it('[IN-52] a hard floor has the shape of the key\'s value type', () => {
    expect(check(doc([key()], [row({ floor: 'DESIGN', value: '20', hardFloor: '30.0' })]))).toEqual(
      rowRefused('EBMR-MKT-023', `row I.IN: hardFloor: "30.0" ${NOT_CANONICAL}`),
    );
  });

  it('[IN-52] a value looser than its own hard floor is refused', () => {
    expect(check(doc([key()], [row({ floor: 'DESIGN', hardFloor: '20' })]))).toEqual(rowRefused('EBMR-MKT-023', 'row I.IN: the value is looser than its own hard floor'));
  });

  it('[IN-52] strictness against the hard floor is judged only for a well-formed value of a key with a known method', () => {
    // A malformed value is refused for its shape alone; it is never ranked against the floor.
    expect(check(doc([key()], [row({ floor: 'DESIGN', value: '7.50', hardFloor: '20' })]))).toEqual(rowRefused('EBMR-MKT-020', `row I.IN: "7.50" ${NOT_CANONICAL}`));
    // A key with an unknown method cannot rank its values, so only the method is refused.
    const unknownMethod = other({ method: 'STRICTEST' });
    const rows = [row(), row({ ref: 'O.EU', key: O, market: 'EU', floor: 'DESIGN', value: '30', hardFloor: '20' })];
    expect(check(doc([key(), unknownMethod], rows))).toEqual([problem('EBMR-MKT-014', `key ${O}: unknown comparison method STRICTEST`)]);
  });

  it('[IN-52] a key whose method does not fit its value type cannot rank a value against its hard floor: the misfit is reported, nothing is thrown', () => {
    // SMALLER_STRICTER reads decimals; these values are well-formed Booleans, categories and sets.
    for (const [valueType, value, hardFloor, misfit] of [
      ['BOOLEAN', true, false, 'method SMALLER_STRICTER does not fit value type BOOLEAN'],
      ['CATEGORY', 'HIGH', 'LOW', 'method SMALLER_STRICTER does not fit value type CATEGORY'],
      ['SET', ['A'], ['B'], 'scalar method SMALLER_STRICTER on a multi-component key (value type SET)'],
    ] as const) {
      const misfitting = other({ valueType, orderedValues: valueType === 'CATEGORY' ? ['LOW', 'HIGH'] : undefined });
      const rows = [row(), row({ ref: 'O.EU', key: O, market: 'EU', floor: 'DESIGN', value, hardFloor })];
      expect(check(doc([key(), misfitting], rows)), valueType).toEqual([problem('EBMR-MKT-015', `key ${O}: ${misfit}`)]);
    }
  });
});

describe('effective windows and predicate branches across rows', () => {
  const second = (o: Obj): Obj => row({ ref: 'I.IN.2', value: '25', ...o });
  const overlap = (pred = '{}') => problem('EBMR-MKT-024', `rows I.IN and I.IN.2: overlapping effective windows for key ${K}, market IN, predicate ${pred}`);

  it('[IN-52] rows of one key, market and predicate whose windows overlap are refused', () => {
    expect(check(doc([key()], [row(), second({ effectiveFrom: '2025-06-01' })]))).toEqual([overlap()]);
    expect(check(doc([key()], [row({ effectiveTo: '2025-01-01' }), second({ effectiveFrom: '2024-06-01' })]))).toEqual([overlap()]);
    expect(check(doc([key()], [row({ effectiveFrom: '2024-06-01' }), second({ effectiveTo: '2025-01-01' })]))).toEqual([overlap()]);
    const declared = key({ predicates: { licenceForm: ['FORM_25'] } });
    const form25 = { predicate: { licenceForm: 'FORM_25' } };
    expect(check(doc([declared], [row(form25), second({ ...form25, effectiveFrom: '2025-06-01' })]))).toEqual([overlap('{"licenceForm":"FORM_25"}')]);
  });

  it('[IN-52] windows that only touch do not overlap: the end date is exclusive', () => {
    expect(check(doc([key()], [row({ effectiveTo: '2025-01-01' }), second({ effectiveFrom: '2025-01-01' })]))).toEqual([]);
    expect(check(doc([key()], [row({ effectiveFrom: '2025-01-01' }), second({ effectiveTo: '2025-01-01' })]))).toEqual([]);
  });

  it('[IN-52] overlapping rows are fine when one predicate refines the other or the predicates exclude each other', () => {
    const declared = key({ predicates: { a: ['X', 'Y'], b: [true, false], c: ['P'] } });
    const pair = (p1: Obj, p2: Obj) => check(doc([declared], [row({ predicate: p1 }), second({ predicate: p2 })]));
    expect(pair({ a: 'X' }, { a: 'X', b: true })).toEqual([]);
    expect(pair({ a: 'X', b: true }, { a: 'X' })).toEqual([]);
    expect(pair({ a: 'X' }, { a: 'Y' })).toEqual([]);
    expect(pair({ a: 'X', b: true }, { a: 'Y', c: 'P' })).toEqual([]);
    const ambiguous = problem(
      'EBMR-MKT-025',
      `rows I.IN and I.IN.2: predicates overlap without one refining the other (key ${K}, market IN), so the branch would be ambiguous`,
    );
    expect(pair({ a: 'X' }, { b: true })).toEqual([ambiguous]);
    expect(pair({ a: 'X', b: true }, { a: 'X', c: 'P' })).toEqual([ambiguous]);
  });
});

describe('India governance (INV-28)', () => {
  const eu = (o: Obj = {}): Obj => row({ ref: 'I.EU', market: 'EU', value: '20', ...o });

  it('[IN-52][INV-28] a key India governs needs an India row', () => {
    expect(check(doc([key()], [eu()]))).toEqual([NO_INDIA_ROW]);
  });

  it('[IN-52][INV-28] India rows must cover the whole period in which the key\'s rows are in force', () => {
    expect(check(doc([key()], [row({ effectiveTo: '2025-01-01' }), row({ ref: 'I.IN.2', effectiveFrom: '2025-03-01' })]))).toEqual([INDIA_GAP]);
    // A later India window listed first does not hide a gap after the earlier one.
    expect(check(doc([key()], [row({ ref: 'I.IN.2', effectiveFrom: '2024-06-01' }), row({ effectiveTo: '2024-03-01' })]))).toEqual([INDIA_GAP]);
    // Another market in force after India's last row (without end, or until a later date).
    expect(check(doc([key()], [eu(), row({ effectiveTo: '2025-01-01' })]))).toEqual([INDIA_GAP]);
    expect(check(doc([key()], [row({ effectiveTo: '2025-01-01' }), eu({ effectiveTo: '2026-01-01' })]))).toEqual([INDIA_GAP]);
    // Every row ends, and India leaves a gap before the end.
    expect(
      check(doc([key()], [row({ effectiveTo: '2024-06-01' }), row({ ref: 'I.IN.2', effectiveFrom: '2024-07-01', effectiveTo: '2025-01-01' }), eu({ effectiveTo: '2025-01-01' })])),
    ).toEqual([INDIA_GAP]);
  });

  it('[IN-52][INV-28] India coverage may end when every row of the key ends, and may be made of chained or overlapping windows', () => {
    expect(check(doc([key()], [row({ effectiveTo: '2025-01-01' }), eu({ effectiveTo: '2025-01-01' })]))).toEqual([]);
    expect(check(doc([key()], [row({ effectiveTo: '2025-01-01' }), eu({ effectiveTo: '2024-06-01' })]))).toEqual([]);
    const declared = key({ predicates: { licenceForm: ['FORM_28'] } });
    const rows = [
      row({ effectiveTo: '2025-01-01' }),
      row({ ref: 'I.IN.f28', predicate: { licenceForm: 'FORM_28' }, effectiveFrom: '2024-06-01', effectiveTo: '2026-01-01' }),
      row({ ref: 'I.IN.2', effectiveFrom: '2026-01-01' }),
      eu(),
    ];
    expect(check(doc([declared], rows))).toEqual([]);
  });

  it('[IN-52][INV-28] a key India does not govern has no India rows', () => {
    expect(check(doc([key({ indiaGoverns: false })], [row(), eu()]))).toEqual([
      problem('EBMR-MKT-027', `key ${K} says India does not govern it but has India (IN) rows`),
    ]);
    expect(check(doc([key({ indiaGoverns: false })], [eu()]))).toEqual([]);
  });
});

describe('ALL_APPLY criteria across rows', () => {
  const criteriaKey = (name = C): Obj => key({ key: name, title: 'Acceptance criteria', method: 'ALL_APPLY', valueType: 'CRITERIA', unit: 'criteria' });
  const criteriaRow = (ref: string, market: string, value: unknown, o: Obj = {}): Obj => row({ ref, key: C, market, unit: 'criteria', value, ...o });
  const differs = (id: string) => problem('EBMR-MKT-028', `key ${C}: criterion ${id} is defined differently in different rows`);

  it('[IN-52][INV-28] a criterion keeps one definition in every row and hard floor of its key', () => {
    const rows = [
      // Criterion ids are compared as given, also ids that read like JavaScript words.
      criteriaRow('C.IN', 'IN', [{ id: 'C1', limit: '5' }, { id: 'undefined', note: 'x' }]),
      criteriaRow('C.EU', 'EU', [{ id: 'C1', limit: '5' }, { id: 'C2', limit: '1' }], { floor: 'DESIGN', hardFloor: [{ id: 'C1', limit: '5' }] }),
    ];
    expect(check(doc([key(), criteriaKey()], [row(), ...rows]))).toEqual([]);
  });

  it('[IN-52][INV-28] a criterion defined differently in two rows is refused', () => {
    const rows = [criteriaRow('C.IN', 'IN', [{ id: 'C1', limit: '5' }]), criteriaRow('C.EU', 'EU', [{ id: 'C1', limit: '6' }])];
    expect(check(doc([key(), criteriaKey()], [row(), ...rows]))).toEqual([differs('C1')]);
  });

  it('[IN-52][INV-28] every differing criterion is reported once, in order of key and criterion id', () => {
    const rows = [
      criteriaRow('C.IN', 'IN', [{ id: 'C2', limit: '1' }, { id: 'C1', limit: '1' }, { id: 'C3', limit: '1' }]),
      criteriaRow('C.EU', 'EU', [{ id: 'C2', limit: '2' }, { id: 'C1', limit: '2' }, { id: 'C3', limit: '1' }]),
      criteriaRow('C.US', 'US', [{ id: 'C2', limit: '3' }]),
    ];
    expect(check(doc([key(), criteriaKey()], [row(), ...rows]))).toEqual([differs('C1'), differs('C2')]);
  });

  it('[IN-52][INV-28] criteria of different keys are independent, even with the same id', () => {
    const second = 'kernel.t.criteria2';
    const rows = [
      criteriaRow('C.IN', 'IN', [{ id: 'C1', limit: '5' }]),
      row({ ref: 'C2.IN', key: second, unit: 'criteria', value: [{ id: 'C1', limit: '9' }] }),
    ];
    expect(check(doc([key(), criteriaKey(), criteriaKey(second)], [row(), ...rows]))).toEqual([]);
  });
});
