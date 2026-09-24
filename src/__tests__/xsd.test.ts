import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  fromXsd,
  jsonSchemaToXsd,
  materialize,
  toJsonSchema,
  toXsd,
  verifyXsdChecksum,
  xsdToJsonSchema,
  type SchemaDocument,
} from '../index.js';
import { BY_NAME, BY_TAX_ID, LEGACY_ANNOTATIONS, SEARCH } from './fixtures/legacyXsd.js';
import { REGISTRATION } from './fixtures/registration.js';
import { codes, domParser, ok } from './helpers.js';

const stripXmlHints = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value), (key, entry) =>
    (key === 'x-xml' && entry && !('rootElement' in entry)) || key === 'checksum'
      ? undefined
      : entry,
  );

describe('toXsd', () => {
  const xsd = ok(toXsd(REGISTRATION));

  it('declares XSD 1.1 and parses as well-formed XML', () => {
    expect(xsd).toContain('vc:minVersion="1.1"');
    expect(xsd).toContain('xpathDefaultNamespace="##targetNamespace"');
    expect(() => domParser().parseFromString(xsd, 'application/xml')).not.toThrow();
  });

  it('turns conditions into assertions and keeps them readable as annotations', () => {
    expect(xsd).toContain('<xs:assert test="(taxMode = 5) or empty(patentKinds)"/>');
    expect(xsd).toContain('<xs:assert test="not(taxMode = 5) or exists(patentKinds)"/>');
    expect(xsd).toContain('<xs:assert test="not(taxMode = (1, 2)) or exists(employees)"/>');
    expect(xsd).toContain('<xs:assert test="(isResident = false()) or empty(passport)"/>');
    expect(xsd).toContain(
      '<sk:visible-if><sk:equals ref="taxMode" value="5" type="number"/></sk:visible-if>',
    );
  });

  it('anchors patterns the XSD way and keeps the ECMA original', () => {
    expect(xsd).toContain('<xs:pattern value="[0-9]{14}"/>');
    expect(xsd).toContain('<sk:ecma-pattern>^\\d{14}$</sk:ecma-pattern>');
  });

  it('writes a choice, a wrapper, named definitions and exact built-ins', () => {
    expect(xsd).toMatch(/<xs:choice>\s*<xs:annotation><xs:appinfo><sk:choice id="identity"\/>/);
    expect(xsd).toContain('<xs:element name="body" type="BodyType">');
    expect(xsd).toContain('<xs:simpleType name="TaxIdentificationNumber">');
    expect(xsd).toContain('<xs:complexType name="Address">');
    expect(xsd).toContain('<xs:restriction base="xs:int">');
    expect(xsd).toContain('<xs:element name="consent" type="xs:boolean" fixed="true">');
  });

  it('stamps a checksum that detects a hand edit', () => {
    expect(verifyXsdChecksum(xsd)).toBe(true);
    expect(verifyXsdChecksum(xsd.replace('maxLength value="150"', 'maxLength value="15"'))).toBe(
      false,
    );
  });

  it('reports what XSD cannot express', () => {
    const list: SchemaDocument = {
      xml: { rootElement: 'r', targetNamespace: 'urn:x' },
      root: { kind: 'array', items: { kind: 'object', properties: [] } },
    };
    expect(codes(toXsd(list))).toContain('listBodyInXsd');
    expect(codes(toXsd({ root: { kind: 'object', properties: [] } }))).toContain(
      'xmlSettingsMissing',
    );
    const lazy: SchemaDocument = {
      xml: { rootElement: 'r', targetNamespace: 'urn:x' },
      root: {
        kind: 'object',
        properties: [{ name: 'a', node: { kind: 'string', pattern: 'a+?' } }],
      },
    };
    expect(codes(toXsd(lazy))).toContain('patternNotTranslatable');
  });
});

describe('fromXsd', () => {
  it('round-trips a generated XSD to the same model and the same bytes', () => {
    const xsd = ok(toXsd(REGISTRATION));
    const parsed = fromXsd(xsd, { domParser });
    expect(codes(parsed, 'error')).toEqual([]);
    expect(codes(parsed, 'warning')).toEqual([]);
    const again = ok(toXsd(ok(parsed)));
    expect(again).toBe(xsd);
  });

  it('carries the same validation meaning as the JSON projection', async () => {
    const materialized = ok(await materialize(REGISTRATION));
    const viaXsd = ok(fromXsd(ok(toXsd(materialized)), { domParser }));
    expect(stripXmlHints(ok(toJsonSchema(viaXsd)))).toEqual(
      stripXmlHints(ok(toJsonSchema(materialized))),
    );
  });

  it('reads hand-written XSDs with unanchored patterns, named types and a foreign annotation namespace', () => {
    const options = { domParser, annotationNamespaces: [LEGACY_ANNOTATIONS] };
    for (const xsd of [BY_TAX_ID, BY_NAME, SEARCH]) {
      expect(codes(fromXsd(xsd, options), 'error')).toEqual([]);
    }
    const doc = ok(fromXsd(BY_TAX_ID, options));
    const root = doc.root as Extract<SchemaDocument['root'], { kind: 'object' }>;
    expect(root.properties[0]).toMatchObject({
      name: 'taxId',
      required: true,
      title: { ru: 'ИНН', ky: 'ИНН', en: 'Tax ID' },
      description: { en: '14 digits' },
      node: {
        kind: 'string',
        pattern: '^(?:\\p{Nd}{14})$',
        xml: { type: 'TaxIdentificationNumber' },
      },
    });
    const search = ok(fromXsd(SEARCH, options));
    const searchRoot = search.root as Extract<SchemaDocument['root'], { kind: 'object' }>;
    expect(searchRoot.properties[1]!.node).toMatchObject({
      kind: 'string',
      options: {
        kind: 'inline',
        options: [
          { value: 'NAME' },
          { value: 'TAX_ID' },
          { value: 'REGISTRY_CODE' },
          { value: 'OWNER' },
        ],
      },
    });
    const pattern = new RegExp((root.properties[0]!.node as { pattern: string }).pattern, 'u');
    expect(pattern.test('12345678901234')).toBe(true);
    expect(pattern.test('x12345678901234')).toBe(false);
  });

  it('ignores appinfo in namespaces it was not given', () => {
    const doc = ok(fromXsd(BY_TAX_ID, { domParser }));
    const root = doc.root as Extract<SchemaDocument['root'], { kind: 'object' }>;
    expect(root.properties[0]!.title).toBeUndefined();
  });

  it('unwraps unmarked envelopes only on request', () => {
    const xsd = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns="urn:x" targetNamespace="urn:x" elementFormDefault="qualified">
      <xs:element name="req"><xs:complexType><xs:sequence>
        <xs:element name="data"><xs:complexType><xs:sequence>
          <xs:element name="a" type="xs:string"/><xs:element name="b" type="xs:long" minOccurs="0" maxOccurs="unbounded"/>
        </xs:sequence></xs:complexType></xs:element>
      </xs:sequence></xs:complexType></xs:element></xs:schema>`;
    const plain = ok(fromXsd(xsd, { domParser }));
    expect((plain.root as { properties: readonly unknown[] }).properties).toHaveLength(1);
    const unwrapped = ok(fromXsd(xsd, { domParser, unwrap: 'heuristic' }));
    expect(unwrapped.xml?.wrapper).toEqual([{ name: 'data' }]);
    expect((unwrapped.root as { properties: readonly unknown[] }).properties).toEqual([
      { name: 'a', node: { kind: 'string' }, required: true },
      { name: 'b', node: { kind: 'array', items: { kind: 'integer', xml: { base: 'long' } } } },
    ]);
  });

  it('refuses constructs the model cannot carry', () => {
    const xsd = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:x" xmlns="urn:x" elementFormDefault="qualified">
      <xs:element name="r"><xs:complexType><xs:sequence><xs:element name="a" type="xs:string"/></xs:sequence><xs:attribute name="id" type="xs:string"/></xs:complexType></xs:element></xs:schema>`;
    expect(codes(fromXsd(xsd, { domParser }))).toContain('unsupportedXsdConstruct');
    expect(codes(fromXsd('<not-xml', { domParser }))).toContain('notXml');
  });
});

describe('conversion', () => {
  it('converts JSON Schema to XSD and back without changing the model', () => {
    const json = ok(toJsonSchema(REGISTRATION));
    const xsd = ok(jsonSchemaToXsd(json));
    const back = ok(xsdToJsonSchema(xsd, { domParser }));
    const materializedJson = ok(xsdToJsonSchema(ok(toXsd(REGISTRATION)), { domParser }));
    expect(canonicalJson(back)).toBe(canonicalJson(materializedJson));
  });

  it('needs XML settings for a JSON-only schema', () => {
    const json = { type: 'object', properties: { a: { type: 'string' } } };
    expect(codes(jsonSchemaToXsd(json))).toContain('xmlSettingsMissing');
    const xsd = ok(
      jsonSchemaToXsd(json, { xml: { rootElement: 'request', targetNamespace: 'urn:x' } }),
    );
    expect(xsd).toContain('<xs:element name="a" type="xs:string" minOccurs="0"/>');
  });
});
