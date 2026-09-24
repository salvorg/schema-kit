import { describe, expect, it } from 'vitest';
import {
  buildSchemas,
  canonicalJson,
  checksumOf,
  ecmaToXsdPattern,
  fromJsonSchema,
  materializeJsonSchema,
  toJsonSchema,
  xsdToEcmaPattern,
  type SchemaDocument,
} from '../index.js';
import { sha256Hex } from '../util/canonical.js';
import {
  DOCUMENT_BATCH,
  HAND_WRITTEN_RULES,
  INVOICE_WITH_LINES,
  PAYMENT_LIST,
} from './fixtures/legacyJson.js';
import { REGISTRATION } from './fixtures/registration.js';
import { codes, ok } from './helpers.js';

const roundTrip = (pattern: string): RegExp => {
  const xsd = ecmaToXsdPattern(pattern);
  if (!xsd.ok) throw new Error(xsd.reason);
  const back = xsdToEcmaPattern(xsd.pattern);
  if (!back.ok) throw new Error(back.reason);
  return new RegExp(back.pattern, 'u');
};

describe('pattern translation', () => {
  const samples = [
    '',
    'a',
    'abc',
    '12345678901234',
    'x12345678901234',
    '12345678901234x',
    'AN1234567',
    'an1234567',
    '+996555123456',
    'a.b',
    'a\nb',
    'foo-bar',
    '(x)',
  ];

  it.each([
    '^\\d{14}$',
    '\\d{14}',
    '^[A-Z]{2}\\d{7}$',
    '^\\+996\\d{9}$',
    'foo|^bar',
    '^(?:a|b)c$',
    '^[\\w-]+$',
    '\\(x\\)',
    '^a\\.b$',
  ])('%s accepts the same strings after ECMA → XSD → ECMA', (pattern) => {
    const original = new RegExp(pattern, 'u');
    const translated = roundTrip(pattern);
    for (const sample of samples) {
      expect(translated.test(sample), `${pattern} on ${JSON.stringify(sample)}`).toBe(
        original.test(sample),
      );
    }
  });

  it('anchors XSD patterns and escapes XSD literals', () => {
    expect(xsdToEcmaPattern('\\d{14}')).toEqual({ ok: true, pattern: '^(?:\\p{Nd}{14})$' });
    expect(xsdToEcmaPattern('a$b^')).toEqual({ ok: true, pattern: '^(?:a\\$b\\^)$' });
    expect(xsdToEcmaPattern('.*[^\\s].*')).toEqual({
      ok: true,
      pattern: '^(?:[^\\n\\r]*[^ \\t\\n\\r][^\\n\\r]*)$',
    });
  });

  it('refuses constructs one side cannot express', () => {
    for (const pattern of ['a+?', '(?=a)b', '(a)\\1', '\\bword', 'a$b']) {
      expect(ecmaToXsdPattern(pattern).ok, pattern).toBe(false);
    }
    for (const pattern of ['\\i\\c*', '[a-z-[aeiou]]', '\\p{IsBasicLatin}']) {
      expect(xsdToEcmaPattern(pattern).ok, pattern).toBe(false);
    }
  });
});

describe('canonical form and checksum', () => {
  it('computes SHA-256 over UTF-8', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('ИНН')).toBe(
      '4597fa4840d470d0ff4acc356bcb794c0a9dd76c7d39a10b04c06c45f883492d',
    );
    expect(sha256Hex('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    );
  });

  it('serializes keys in a stable order regardless of input order', () => {
    expect(canonicalJson({ b: 1, a: [true, { d: null, c: 'x' }] })).toBe(
      '{"a":[true,{"c":"x","d":null}],"b":1}',
    );
    expect(checksumOf({ a: 1, b: 2 })).toBe(checksumOf({ b: 2, a: 1 }));
  });
});

describe('schemas written without the library', () => {
  it('reads nested lines and a uuid list', () => {
    expect(codes(fromJsonSchema(INVOICE_WITH_LINES), 'error')).toEqual([]);
    const batch = ok(fromJsonSchema(DOCUMENT_BATCH));
    const root = batch.root as Extract<SchemaDocument['root'], { kind: 'object' }>;
    expect(root.properties.find((property) => property.name === 'documentIds')!.node).toEqual({
      kind: 'array',
      minItems: 1,
      items: { kind: 'string', format: 'uuid' },
    });
  });

  it('reads a list body with dictionaries and a transient field', () => {
    const doc = ok(fromJsonSchema(PAYMENT_LIST));
    expect(doc.root.kind).toBe('array');
    const schema = ok(toJsonSchema(doc));
    const items = (schema['items'] as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(items['taxId']!['x-transient']).toBe(true);
    expect(items['classificationCode']!['x-options']).toMatchObject({
      kind: 'service',
      filterBy: { field: 'taxCode', pointer: '/taxCode' },
    });
  });

  it('refuses a hand-written allOf, and reads it leniently with a warning', () => {
    const strict = fromJsonSchema(HAND_WRITTEN_RULES);
    expect(strict.ok).toBe(false);
    expect(strict.issues.find((issue) => issue.code === 'unsupportedKeyword')?.path).toBe('/allOf');
    const lenient = fromJsonSchema(HAND_WRITTEN_RULES, { strict: false });
    expect(lenient.ok).toBe(true);
    expect(codes(lenient, 'warning')).toContain('unsupportedKeyword');
  });
});

describe('buildSchemas', () => {
  it('builds both projections from one materialized model with one checksum', async () => {
    const built = ok(await buildSchemas(REGISTRATION));
    expect(built.document.definitions).toBeUndefined();
    expect(JSON.stringify(built.jsonSchema)).not.toContain('$ref');
    expect(built.xsd).toContain('<xs:simpleType name="TaxIdentificationNumber">');
    expect(built.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ok(await buildSchemas(JSON.parse(JSON.stringify(REGISTRATION)))).checksum).toBe(
      built.checksum,
    );
  });

  it('rejects malformed constructor input with paths', async () => {
    const result = await buildSchemas({
      root: { kind: 'object', properties: [{ name: '1bad', node: { kind: 'string' } }] },
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({
      code: 'invalidModel',
      path: '/root/properties/0/name',
    });
  });

  it('materializes a JSON Schema with external references', async () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { person: { $ref: 'urn:example:model:PERSON:2.1.0' } },
    };
    const person: SchemaDocument = {
      root: {
        kind: 'object',
        properties: [{ name: 'tin', node: { kind: 'string' }, required: true }],
      },
    };
    const result = ok(await materializeJsonSchema(schema, { resolve: () => person }));
    expect((result['properties'] as Record<string, unknown>)['person']).toMatchObject({
      type: 'object',
      properties: { tin: { type: 'string' } },
      required: ['tin'],
    });
  });
});
