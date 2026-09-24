import { DIALECT_VERSION } from '../annotations.js';
import { Issues, pointer, type Result } from '../issues.js';
import { conditionToXPath, type Condition } from '../model/condition.js';
import { compactText } from '../model/localized.js';
import {
  defaultLocaleOf,
  localesOf,
  localRefName,
  type ObjectNode,
  type Property,
  type ScalarNode,
  type SchemaDocument,
  type SchemaNode,
  type StringFormat,
  type XmlSettings,
  type XsdBuiltin,
} from '../model/types.js';
import { validateDocument } from '../model/validate.js';
import { sha256Hex } from '../util/canonical.js';
import { GENERATOR } from '../version.js';
import { attrs, escapeText } from '../xml/escape.js';
import { SK, VC, XS } from '../xml/dom.js';
import { conditionXml, i18nXml, optionGroupsXml, serviceOptionsXml } from './appinfo.js';
import { ecmaToXsdPattern } from './regex.js';

export interface XsdOptions {
  /** Overrides (or supplies) `doc.xml`. */
  readonly xml?: XmlSettings;
}

const CHECKSUM_PLACEHOLDER = 'sha256:' + '0'.repeat(64);

type Category = 'string' | 'integer' | 'number' | 'boolean';

const BUILTIN_CATEGORY: Readonly<Record<XsdBuiltin, Category>> = {
  string: 'string',
  normalizedString: 'string',
  token: 'string',
  anyURI: 'string',
  date: 'string',
  dateTime: 'string',
  time: 'string',
  boolean: 'boolean',
  decimal: 'number',
  double: 'number',
  float: 'number',
  integer: 'integer',
  long: 'integer',
  int: 'integer',
  short: 'integer',
  byte: 'integer',
  nonNegativeInteger: 'integer',
  positiveInteger: 'integer',
  nonPositiveInteger: 'integer',
  negativeInteger: 'integer',
  unsignedLong: 'integer',
  unsignedInt: 'integer',
  unsignedShort: 'integer',
  unsignedByte: 'integer',
};

const FORMAT_BUILTIN: Partial<Record<StringFormat, XsdBuiltin>> = {
  date: 'date',
  'date-time': 'dateTime',
  time: 'time',
  uri: 'anyURI',
};

export const builtinFor = (node: ScalarNode): XsdBuiltin => {
  if (node.xml?.base) return node.xml.base;
  switch (node.kind) {
    case 'string':
      return (node.format && FORMAT_BUILTIN[node.format]) ?? 'string';
    case 'integer':
      return 'integer';
    case 'number':
      return 'decimal';
    case 'boolean':
      return 'boolean';
  }
};

const pascal = (name: string): string =>
  name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');

const indent = (lines: readonly string[], depth = 1): string[] =>
  lines.map((line) => '  '.repeat(depth) + line);

const lexical = (value: string | number | boolean): string => String(value);

export const toXsd = (doc: SchemaDocument, options: XsdOptions = {}): Result<string> => {
  const issues = validateDocument(doc);
  if (issues.failed) return issues.fail();

  const settings = options.xml ?? doc.xml;
  if (!settings) {
    issues.error(
      'xmlSettingsMissing',
      '/xml',
      'rootElement and targetNamespace are required for XSD',
    );
    return issues.fail();
  }
  if (doc.root.kind !== 'object') {
    issues.error('listBodyInXsd', '/root', 'a list body has no XSD form; wrap it in an object');
    return issues.fail();
  }

  const locales = localesOf(doc);
  const definitions = doc.definitions ?? {};
  const types = new Map<string, string>();
  const typeOrder: string[] = [];

  const register = (name: string, lines: string[], path: string, hinted: boolean): string => {
    const content = lines.join('\n');
    let candidate = name;
    for (let suffix = 2; ; suffix++) {
      const existing = types.get(candidate);
      if (existing === undefined) {
        types.set(candidate, content.replace(`name="${name}"`, `name="${candidate}"`));
        typeOrder.push(candidate);
        return candidate;
      }
      if (existing === content.replace(`name="${name}"`, `name="${candidate}"`)) return candidate;
      if (hinted) {
        issues.error(
          'typeNameCollision',
          path,
          `type "${name}" is already defined with different content`,
        );
        return candidate;
      }
      candidate = `${name}${suffix}`;
    }
  };

  const checkBase = (node: ScalarNode, path: string): void => {
    const base = builtinFor(node);
    if (BUILTIN_CATEGORY[base] !== node.kind) {
      issues.error(
        'xmlBaseMismatch',
        pointer(path, 'xml', 'base'),
        `xs:${base} cannot carry a ${node.kind}`,
      );
    }
  };

  const needsSimpleType = (node: ScalarNode): boolean => {
    if (node.xml?.type) return true;
    if (node.options?.kind === 'inline') return true;
    if (node.kind === 'string')
      return (
        node.minLength !== undefined || node.maxLength !== undefined || node.pattern !== undefined
      );
    if (node.kind === 'integer' || node.kind === 'number') {
      return [node.minimum, node.maximum, node.exclusiveMinimum, node.exclusiveMaximum].some(
        (value) => value !== undefined,
      );
    }
    return false;
  };

  const simpleType = (node: ScalarNode, name: string, path: string, hinted: boolean): string => {
    checkBase(node, path);
    const facets: string[] = [];
    const appinfo: string[] = [];
    if (node.kind === 'string') {
      if (node.minLength !== undefined) facets.push(`<xs:minLength value="${node.minLength}"/>`);
      if (node.maxLength !== undefined) facets.push(`<xs:maxLength value="${node.maxLength}"/>`);
      if (node.pattern !== undefined) {
        const translated = ecmaToXsdPattern(node.pattern);
        if (!translated.ok) {
          issues.error('patternNotTranslatable', pointer(path, 'pattern'), translated.reason);
        } else {
          facets.push(`<xs:pattern${attrs({ value: translated.pattern })}/>`);
          appinfo.push(`<sk:ecma-pattern>${escapeText(node.pattern)}</sk:ecma-pattern>`);
        }
      }
    }
    if (node.kind === 'integer' || node.kind === 'number') {
      if (node.minimum !== undefined) facets.push(`<xs:minInclusive value="${node.minimum}"/>`);
      if (node.exclusiveMinimum !== undefined)
        facets.push(`<xs:minExclusive value="${node.exclusiveMinimum}"/>`);
      if (node.maximum !== undefined) facets.push(`<xs:maxInclusive value="${node.maximum}"/>`);
      if (node.exclusiveMaximum !== undefined)
        facets.push(`<xs:maxExclusive value="${node.exclusiveMaximum}"/>`);
    }
    if (node.options?.kind === 'inline') {
      for (const option of node.options.options) {
        const inner = [...i18nXml('i18n-label', compactText(option.label))];
        if (option.image !== undefined)
          inner.push(`<sk:image>${escapeText(option.image)}</sk:image>`);
        facets.push(
          inner.length === 0
            ? `<xs:enumeration${attrs({ value: lexical(option.value) })}/>`
            : [
                `<xs:enumeration${attrs({ value: lexical(option.value) })}>`,
                `  <xs:annotation><xs:appinfo>${inner.join('')}</xs:appinfo></xs:annotation>`,
                `</xs:enumeration>`,
              ].join('\n'),
        );
      }
    }
    const lines = [
      `<xs:simpleType${attrs({ name })}>`,
      ...(appinfo.length > 0
        ? indent([`<xs:annotation><xs:appinfo>${appinfo.join('')}</xs:appinfo></xs:annotation>`])
        : []),
      ...indent(
        facets.length > 0
          ? [
              `<xs:restriction base="xs:${builtinFor(node)}">`,
              ...indent(facets.flatMap((facet) => facet.split('\n'))),
              `</xs:restriction>`,
            ]
          : [`<xs:restriction base="xs:${builtinFor(node)}"/>`],
      ),
      `</xs:simpleType>`,
    ];
    return register(name, lines, path, hinted);
  };

  const definitionTypes = new Map<string, string>();
  const definitionType = (name: string, path: string): string | undefined => {
    const cached = definitionTypes.get(name);
    if (cached) return cached;
    const node = definitions[name];
    if (!node) return undefined;
    if (node.kind === 'array') {
      issues.error(
        'arrayDefinitionInXsd',
        path,
        `definition "${name}" is an array; XSD expresses arrays as occurrences`,
      );
      return undefined;
    }
    if (node.kind === 'ref') return typeRef(node, path);
    const typeName = node.xml?.type ?? name;
    definitionTypes.set(name, typeName);
    const registered =
      node.kind === 'object'
        ? complexType(node, typeName, pointer('/definitions', name), true)
        : simpleType(node, typeName, pointer('/definitions', name), true);
    definitionTypes.set(name, registered);
    return registered;
  };

  const typeRef = (node: SchemaNode, path: string, autoName?: string): string | undefined => {
    switch (node.kind) {
      case 'string':
      case 'integer':
      case 'number':
      case 'boolean':
        if (needsSimpleType(node))
          return simpleType(
            node,
            node.xml?.type ?? autoName ?? 'ValueType',
            path,
            node.xml?.type !== undefined,
          );
        checkBase(node, path);
        return `xs:${builtinFor(node)}`;
      case 'object':
        return complexType(
          node,
          node.xml?.type ?? autoName ?? 'ObjectType',
          path,
          node.xml?.type !== undefined,
        );
      case 'ref': {
        const name = localRefName(node.ref);
        if (name === undefined) {
          issues.error(
            'externalRefInXsd',
            path,
            `"${node.ref}" is external; materialize the document first`,
          );
          return undefined;
        }
        return definitionType(name, path);
      }
      case 'array':
        issues.error('nestedArrayInXsd', path, 'an array of arrays has no XSD form');
        return undefined;
    }
  };

  const resolveNode = (node: SchemaNode): SchemaNode => {
    let current = node;
    const seen = new Set<string>();
    while (current.kind === 'ref') {
      const name = localRefName(current.ref);
      if (name === undefined || seen.has(name) || !definitions[name]) return current;
      seen.add(name);
      current = definitions[name]!;
    }
    return current;
  };

  const effectiveRequired = (property: Property): boolean =>
    property.required === true && !property.visibleIf && !property.requiredIf;

  const propertyAppinfo = (property: Property, extras: string[]): string[] => {
    const scalar =
      property.node.kind === 'array'
        ? resolveNode(property.node.items)
        : resolveNode(property.node);
    const out = [
      ...i18nXml('i18n-title', compactText(property.title)),
      ...i18nXml('i18n-description', compactText(property.description)),
      ...i18nXml('i18n-placeholder', compactText(property.placeholder)),
    ];
    if (property.control) out.push(`<sk:control>${property.control}</sk:control>`);
    if (property.required && property.visibleIf) out.push('<sk:required/>');
    if (property.transient) out.push('<sk:transient/>');
    if (property.visibleIf)
      out.push(`<sk:visible-if>${conditionXml(property.visibleIf)}</sk:visible-if>`);
    if (property.requiredIf)
      out.push(`<sk:required-if>${conditionXml(property.requiredIf)}</sk:required-if>`);
    if (property.binding) out.push(`<sk:binding${attrs({ ...property.binding })}/>`);
    if (property.dataClass)
      out.push(`<sk:data-class>${escapeText(property.dataClass)}</sk:data-class>`);
    if (
      scalar.kind === 'string' &&
      scalar.format &&
      FORMAT_BUILTIN[scalar.format] !== builtinFor(scalar)
    ) {
      out.push(`<sk:format>${scalar.format}</sk:format>`);
    }
    if (
      (scalar.kind === 'string' || scalar.kind === 'integer' || scalar.kind === 'number') &&
      scalar.options?.kind === 'service'
    ) {
      out.push(serviceOptionsXml(scalar.options));
    }
    if (property.node.kind === 'array' && property.node.optionGroups)
      out.push(...optionGroupsXml(property.node.optionGroups));
    if (property.node.kind === 'array' && property.node.uniqueItems) out.push('<sk:unique-items/>');
    out.push(...extras);
    return out;
  };

  const element = (
    property: Property,
    path: string,
    typePrefix: string,
    inChoice: boolean,
    asserts: string[],
  ): string[] => {
    const node = property.node;
    const extras: string[] = [];
    let occurs: Record<string, string | undefined> = {};
    let valueNode: SchemaNode = node;

    if (node.kind === 'array') {
      valueNode = node.items;
      const required = effectiveRequired(property) || inChoice;
      const min = required ? Math.max(1, node.minItems ?? 1) : 0;
      occurs = {
        minOccurs: min === 1 ? undefined : String(min),
        maxOccurs: node.maxItems === undefined ? 'unbounded' : String(node.maxItems),
      };
      if (node.maxItems !== undefined && node.maxItems <= 1) extras.push('<sk:array/>');
      if (node.minItems !== undefined) extras.push(`<sk:min-items>${node.minItems}</sk:min-items>`);
      if (!required && node.minItems !== undefined && node.minItems > 0) {
        asserts.push(
          `count(${property.name}) = 0 or count(${property.name}) &gt;= ${node.minItems}`,
        );
      }
      if (
        node.minItems !== undefined &&
        node.maxItems !== undefined &&
        node.minItems > node.maxItems
      ) {
        issues.error('rangeInverted', path, 'minItems is greater than maxItems');
      }
    } else if (!inChoice && !effectiveRequired(property)) {
      occurs = { minOccurs: '0' };
    }

    const autoName = `${typePrefix}${pascal(property.name)}Type`;
    const type = typeRef(valueNode, pointer(path, 'node'), autoName);
    const resolved = resolveNode(valueNode);
    const scalar =
      resolved.kind !== 'object' && resolved.kind !== 'array' && resolved.kind !== 'ref'
        ? resolved
        : undefined;
    const appinfo = propertyAppinfo(property, extras);
    const head = `<xs:element${attrs({
      name: property.name,
      type,
      ...occurs,
      fixed: scalar?.const !== undefined ? lexical(scalar.const) : undefined,
      default:
        scalar?.default !== undefined && scalar.const === undefined
          ? lexical(scalar.default)
          : undefined,
    })}`;
    return appinfo.length === 0
      ? [`${head}/>`]
      : [
          `${head}>`,
          `  <xs:annotation>`,
          `    <xs:appinfo>`,
          ...indent(appinfo, 3),
          `    </xs:appinfo>`,
          `  </xs:annotation>`,
          `</xs:element>`,
        ];
  };

  const assertFor = (condition: Condition): string => escapeText(conditionToXPath(condition));

  const complexType = (node: ObjectNode, name: string, path: string, hinted: boolean): string => {
    const typePrefix = name.endsWith('Type') ? name.slice(0, -4) : name;
    const asserts: string[] = [];
    const particles: string[] = [];
    const choiceOf = new Map<string, NonNullable<ObjectNode['choices']>[number]>();
    node.choices?.forEach((choice) =>
      choice.members.forEach((member) => choiceOf.set(member, choice)),
    );
    const emittedChoices = new Set<string>();

    node.properties.forEach((property, index) => {
      const at = pointer(path, 'properties', index);
      const choice = choiceOf.get(property.name);
      if (choice) {
        if (emittedChoices.has(choice.id)) return;
        emittedChoices.add(choice.id);
        const members = choice.members.map((member) =>
          node.properties.findIndex((candidate) => candidate.name === member),
        );
        particles.push(
          `<xs:choice${attrs({ minOccurs: choice.required ? undefined : '0' })}>`,
          ...indent(
            [
              `<xs:annotation><xs:appinfo><sk:choice${attrs({ id: choice.id })}/></xs:appinfo></xs:annotation>`,
            ].concat(
              members.flatMap((memberIndex) =>
                element(
                  node.properties[memberIndex]!,
                  pointer(path, 'properties', memberIndex),
                  typePrefix,
                  true,
                  asserts,
                ),
              ),
            ),
          ),
          `</xs:choice>`,
        );
      } else {
        particles.push(...element(property, at, typePrefix, false, asserts));
      }

      const visible = property.visibleIf;
      if (visible) {
        asserts.push(`(${assertFor(visible)}) or empty(${property.name})`);
        if (property.required)
          asserts.push(`not(${assertFor(visible)}) or exists(${property.name})`);
      }
      if (property.requiredIf) {
        const when = visible
          ? `(${assertFor(visible)}) and (${assertFor(property.requiredIf)})`
          : assertFor(property.requiredIf);
        asserts.push(`not(${when}) or exists(${property.name})`);
      }
    });

    const lines = [
      `<xs:complexType${attrs({ name })}>`,
      ...indent(
        particles.length > 0
          ? ['<xs:sequence>', ...indent(particles), '</xs:sequence>']
          : ['<xs:sequence/>'],
      ),
      ...indent(asserts.map((test) => `<xs:assert test="${test.replace(/"/g, '&quot;')}"/>`)),
      `</xs:complexType>`,
    ];
    return register(name, lines, path, hinted);
  };

  const wrapper = settings.wrapper ?? [];
  const levelType = (index: number): string =>
    wrapper[index]!.typeName ?? `${pascal(wrapper[index]!.name)}Type`;
  const containerName = (index: number): string =>
    index === 0 ? (settings.rootType ?? settings.rootElement) : levelType(index - 1);
  const bodyName =
    doc.root.xml?.type ??
    (wrapper.length > 0
      ? levelType(wrapper.length - 1)
      : (settings.rootType ?? settings.rootElement));
  let innerType = complexType(doc.root, bodyName, '/root', doc.root.xml?.type !== undefined);

  for (let level = wrapper.length - 1; level >= 0; level--) {
    const wrap = wrapper[level]!;
    const name = containerName(level);
    const appinfo = ['<sk:wrapper/>', ...i18nXml('i18n-title', compactText(wrap.title))];
    innerType = register(
      name,
      [
        `<xs:complexType${attrs({ name })}>`,
        `  <xs:sequence>`,
        `    <xs:element${attrs({ name: wrap.name, type: innerType })}>`,
        `      <xs:annotation><xs:appinfo>${appinfo.join('')}</xs:appinfo></xs:annotation>`,
        `    </xs:element>`,
        `  </xs:sequence>`,
        `</xs:complexType>`,
      ],
      pointer('/xml/wrapper', level),
      true,
    );
  }

  for (const name of Object.keys(definitions)) {
    if (!definitionTypes.has(name) && definitions[name]!.kind !== 'array')
      definitionType(name, pointer('/definitions', name));
  }
  if (issues.failed) return issues.fail();

  const schemaInfo = [
    ...i18nXml('i18n-title', compactText(doc.title)),
    ...i18nXml('i18n-description', compactText(doc.description)),
    ...(doc.id ? [`<sk:id>${escapeText(doc.id)}</sk:id>`] : []),
    ...(doc.model ? [`<sk:model${attrs({ ...doc.model })}/>`] : []),
    `<sk:canonical${attrs({
      dialect: DIALECT_VERSION,
      generator: GENERATOR,
      locales: locales.join(' '),
      defaultLocale: defaultLocaleOf(doc),
      checksum: CHECKSUM_PLACEHOLDER,
    })}/>`,
  ];

  const text = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<xs:schema${attrs({
      'xmlns:xs': XS,
      'xmlns:vc': VC,
      'xmlns:sk': SK,
      xmlns: settings.targetNamespace,
      targetNamespace: settings.targetNamespace,
      elementFormDefault: 'qualified',
      xpathDefaultNamespace: '##targetNamespace',
      'vc:minVersion': '1.1',
    })}>`,
    '  <xs:annotation>',
    '    <xs:appinfo>',
    ...indent(schemaInfo, 3),
    '    </xs:appinfo>',
    '  </xs:annotation>',
    `  <xs:element${attrs({ name: settings.rootElement, type: innerType })}/>`,
    ...typeOrder.flatMap((name) =>
      indent(
        types
          .get(name)!
          .split('\n')
          .filter((line) => line !== ''),
      ),
    ),
    '</xs:schema>',
    '',
  ].join('\n');

  return issues.result(text.replace(CHECKSUM_PLACEHOLDER, `sha256:${sha256Hex(text)}`));
};

/** Recomputes the checksum of a generated XSD and compares it with `sk:canonical/@checksum`. */
export const verifyXsdChecksum = (xsd: string): boolean => {
  const match = /checksum="(sha256:[0-9a-f]{64})"/.exec(xsd);
  if (!match) return false;
  return `sha256:${sha256Hex(xsd.replace(match[1]!, CHECKSUM_PLACEHOLDER))}` === match[1];
};
