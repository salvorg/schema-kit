import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  defineSchema,
  fromJsonSchema,
  JSON_SCHEMA_DIALECT,
  materialize,
  toJsonSchema,
  verifyChecksum,
  type SchemaDocument,
} from '../index.js';
import { REGISTRATION } from './fixtures/registration.js';
import { codes, ok, strictAjv } from './helpers.js';

const validBody = {
  tin: '21505200250230',
  fullName: 'Асанов Асан',
  taxMode: 1,
  activityCode: '47.11',
  employees: 3,
  consent: true,
  legalAddress: { region: 'Чуй' },
  passportNumber: 'AN1234567',
};

describe('toJsonSchema', () => {
  const schema = ok(toJsonSchema(REGISTRATION));

  it('declares the 2020-12 dialect and uses only approved annotations', () => {
    expect(schema['$schema']).toBe(JSON_SCHEMA_DIALECT);
    const ajv = strictAjv();
    expect(() => ajv.compile(schema)).not.toThrow();
  });

  it('keeps every type a single string', () => {
    const types: unknown[] = [];
    JSON.stringify(schema, (key, value) => {
      if (key === 'type') types.push(value);
      return value;
    });
    expect(types.every((type) => typeof type === 'string')).toBe(true);
  });

  it('accepts a valid body and rejects each rule broken on its own', () => {
    const validate = strictAjv().compile(schema);
    expect(validate(validBody), JSON.stringify(validate.errors)).toBe(true);

    const cases: Record<string, unknown>[] = [
      { ...validBody, tin: '123' },
      { ...validBody, taxMode: 3 },
      { ...validBody, consent: false },
      { ...validBody, unknownKey: 1 },
      { ...validBody, patentKinds: ['TRADE'] },
      { ...validBody, taxMode: 5 },
      { ...validBody, taxMode: 5, patentKinds: ['VAT_A', 'VAT_B'] },
      { ...validBody, employees: undefined },
      { ...validBody, idCardNumber: 'ID1' },
      { ...validBody, passportNumber: undefined },
      { ...validBody, founders: [{ founderTin: '21505200250230', isResident: false }] },
      { ...validBody, legalAddress: undefined, actualAddress: { region: 'Ош' } },
    ];
    for (const body of cases) {
      expect(validate(JSON.parse(JSON.stringify(body))), JSON.stringify(body)).toBe(false);
    }

    expect(
      validate({
        ...validBody,
        taxMode: 5,
        employees: undefined,
        patentKinds: ['TRADE', 'SERVICE'],
      }),
    ).toBe(true);
    expect(
      validate({
        ...validBody,
        founders: [{ founderTin: '21505200250230', isResident: false, passport: 'AN1234567' }],
      }),
    ).toBe(true);
  });

  it('writes conditions in the renderer vocabulary and marks derived rules', () => {
    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['patentKinds']!['x-visibleIf']).toEqual({
      properties: { taxMode: { const: 5 } },
      required: ['taxMode'],
    });
    expect(properties['patentKinds']!['x-requiredIf']).toEqual(
      properties['patentKinds']!['x-visibleIf'],
    );
    expect(schema['x-derived']).toMatchObject({
      from: ['x-visibleIf', 'x-requiredIf', 'x-choices'],
    });
    expect(properties['taxMode']!['x-options']).toMatchObject({ kind: 'inline' });
    expect(properties['taxMode']!['enum']).toEqual([1, 2, 5]);
  });

  it('stamps a checksum that detects a hand edit', () => {
    expect(verifyChecksum(schema)).toBe(true);
    const edited = JSON.parse(JSON.stringify(schema));
    edited.properties.fullName.maxLength = 10;
    expect(verifyChecksum(edited)).toBe(false);
  });

  it('refuses an invalid model instead of emitting it', () => {
    const broken: SchemaDocument = {
      root: {
        kind: 'object',
        properties: [
          { name: 'a', node: { kind: 'string' }, visibleIf: { op: 'equals', ref: 'b', value: 1 } },
          { name: 'b', node: { kind: 'string' }, visibleIf: { op: 'filled', ref: 'a' } },
        ],
      },
    };
    const result = toJsonSchema(broken);
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(expect.arrayContaining(['conditionValueType', 'conditionCycle']));
  });
});

describe('defineSchema', () => {
  it('defaults to English when no locales are given', () => {
    const doc = ok(defineSchema({ root: { kind: 'object', properties: [] } }));
    expect(doc.locales).toEqual(['en']);
    expect(doc.defaultLocale).toBe('en');
    const parsed = ok(fromJsonSchema({ type: 'object', title: 'Order', properties: {} }));
    expect(parsed.title).toEqual({ en: 'Order' });
  });
});

describe('fromJsonSchema', () => {
  it('round-trips a canonical document to the same model and the same bytes', () => {
    const schema = ok(toJsonSchema(REGISTRATION));
    const parsed = fromJsonSchema(schema);
    expect(codes(parsed, 'error')).toEqual([]);
    expect(codes(parsed, 'warning')).toEqual([]);
    expect(canonicalJson(ok(parsed))).toBe(canonicalJson(ok(defineSchema(REGISTRATION))));
    expect(canonicalJson(ok(toJsonSchema(ok(parsed))))).toBe(canonicalJson(schema));
  });

  it('keeps "required when visible" through the round trip', () => {
    const doc = ok(fromJsonSchema(ok(toJsonSchema(REGISTRATION))));
    const root = doc.root as Extract<SchemaDocument['root'], { kind: 'object' }>;
    const patent = root.properties.find((property) => property.name === 'patentKinds')!;
    expect(patent.required).toBe(true);
    expect(patent.requiredIf).toBeUndefined();
  });

  it('reports what it drops instead of dropping it silently', () => {
    const result = fromJsonSchema({
      type: 'object',
      properties: {
        a: { type: ['string', 'null'], 'x-label': { ru: 'A' }, examples: ['x'] },
        b: { type: 'string', format: 'ipv4' },
      },
      required: ['a', 'ghost'],
    });
    expect(result.ok).toBe(true);
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        'dialectMissing',
        'nullableType',
        'unapprovedAnnotation',
        'annotationDropped',
        'unsupportedFormat',
        'requiredNotDeclared',
      ]),
    );
  });

  it('refuses validation keywords it cannot carry unless told to be lenient', () => {
    const input = { type: 'object', properties: { a: { type: 'string', not: { const: 'x' } } } };
    expect(fromJsonSchema(input).ok).toBe(false);
    const lenient = fromJsonSchema(input, { strict: false });
    expect(lenient.ok).toBe(true);
    expect(codes(lenient, 'warning')).toContain('unsupportedKeyword');
  });

  it('reads the factory i18n bundle as a legacy annotation', () => {
    const result = fromJsonSchema({
      type: 'object',
      properties: { a: { type: 'string', title: 'А', 'x-i18n': { title: { ru: 'А', en: 'A' } } } },
    });
    const doc = ok(result);
    expect(codes(result)).toContain('legacyAnnotation');
    const root = doc.root as Extract<SchemaDocument['root'], { kind: 'object' }>;
    expect(root.properties[0]!.title).toEqual({ ru: 'А', en: 'A' });
  });
});

describe('materialize', () => {
  it('inlines local definitions and keeps their names as XML hints', async () => {
    const doc = ok(await materialize(REGISTRATION));
    expect(doc.definitions).toBeUndefined();
    const text = JSON.stringify(doc);
    expect(text).not.toContain('"kind":"ref"');
    const schema = ok(toJsonSchema(doc));
    expect(JSON.stringify(schema)).not.toContain('$ref');
    const root = doc.root as Extract<SchemaDocument['root'], { kind: 'object' }>;
    expect(root.properties[0]!.node).toMatchObject({
      kind: 'string',
      xml: { type: 'TaxIdentificationNumber' },
    });
  });

  it('resolves external models through the resolver and detects cycles', async () => {
    const person: SchemaDocument = {
      root: { kind: 'object', properties: [] },
      definitions: { Name: { kind: 'string', maxLength: 100 } },
    };
    const doc: SchemaDocument = {
      root: {
        kind: 'object',
        properties: [
          {
            name: 'name',
            node: { kind: 'ref', ref: 'urn:example:model:PERSON:2.1.0#/$defs/Name' },
          },
        ],
      },
    };
    const resolved = ok(
      await materialize(doc, {
        resolve: (ref) => (ref === 'urn:example:model:PERSON:2.1.0' ? person : undefined),
      }),
    );
    const root = resolved.root as Extract<SchemaDocument['root'], { kind: 'object' }>;
    expect(root.properties[0]!.node).toEqual({
      kind: 'string',
      maxLength: 100,
      xml: { type: 'Name' },
    });

    const unresolved = await materialize(doc);
    expect(codes(unresolved)).toContain('unresolvedRef');

    const cyclic: SchemaDocument = {
      root: {
        kind: 'object',
        properties: [{ name: 'a', node: { kind: 'ref', ref: '#/$defs/A' } }],
      },
      definitions: {
        A: {
          kind: 'object',
          properties: [{ name: 'self', node: { kind: 'ref', ref: '#/$defs/A' } }],
        },
      },
    };
    expect(codes(await materialize(cyclic))).toContain('recursiveReference');
  });
});
