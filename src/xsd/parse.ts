import { Issues, type Result } from '../issues.js';
import type { Condition, Scalar } from '../model/condition.js';
import { compactText } from '../model/localized.js';
import {
  CONTROLS,
  LOCALE_PATTERN,
  STRING_FORMATS,
  XSD_BUILTINS,
  type ArrayNode,
  type Binding,
  type Choice,
  type Control,
  type InlineOption,
  type LocalizedText,
  type ObjectNode,
  type OptionGroup,
  type Property,
  type ScalarNode,
  type SchemaDocument,
  type SchemaNode,
  type ServiceOptions,
  type StringFormat,
  type WrapperLevel,
  type XmlHint,
  type XsdBuiltin,
} from '../model/types.js';
import { validateDocument } from '../model/validate.js';
import { defined } from '../util/object.js';
import {
  childElements,
  langOf,
  parseXml,
  SK,
  textOf,
  xsChildren,
  XS,
  type DomParserFactory,
  type XmlElement,
} from '../xml/dom.js';
import { parseValue, wrappedConditionFromXml } from './appinfo.js';
import { xsdToEcmaPattern } from './regex.js';

export interface FromXsdOptions {
  /** Required outside browsers: a factory returning a W3C `DOMParser`. */
  readonly domParser?: DomParserFactory;
  /** Global element to read when the schema declares several. */
  readonly rootElement?: string;
  /**
   * `'marked'` (default) unwraps only envelopes marked `sk:wrapper`; `'heuristic'` also unwraps
   * every single required non-repeating complex child.
   */
  readonly unwrap?: 'marked' | 'heuristic';
  /** Same meaning as in `fromJsonSchema`: an unsupported facet is an error unless `false`. */
  readonly strict?: boolean;
  /** Extra namespaces whose appinfo elements are read with the same vocabulary as `sk:*`. */
  readonly annotationNamespaces?: readonly string[];
}

type Category = 'string' | 'integer' | 'number' | 'boolean';

const CATEGORY: Readonly<Record<string, Category>> = {
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

const NARROWED_TO_STRING = new Set([
  'gYear',
  'gYearMonth',
  'gMonth',
  'gMonthDay',
  'gDay',
  'duration',
  'base64Binary',
  'hexBinary',
  'language',
  'Name',
  'NCName',
  'NMTOKEN',
  'ID',
  'IDREF',
  'ENTITY',
  'QName',
]);

const DEFAULT_BASE: Readonly<Record<Category, XsdBuiltin>> = {
  string: 'string',
  integer: 'integer',
  number: 'decimal',
  boolean: 'boolean',
};

const FORMAT_OF_BASE: Partial<Record<XsdBuiltin, StringFormat>> = {
  date: 'date',
  dateTime: 'date-time',
  time: 'time',
  anyURI: 'uri',
};

const pascal = (name: string): string =>
  name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');

interface Facets {
  minLength?: number;
  maxLength?: number;
  patterns: string[][];
  ecmaPattern?: string;
  minimum?: string;
  maximum?: string;
  exclusiveMinimum?: string;
  exclusiveMaximum?: string;
  enumeration?: { value: string; label?: LocalizedText; image?: string }[];
}

interface ResolvedSimple {
  base: XsdBuiltin;
  facets: Facets;
  name?: string;
}

export const fromXsd = (text: string, options: FromXsdOptions = {}): Result<SchemaDocument> => {
  const issues = new Issues();
  const strict = options.strict ?? true;
  const unwrapMode = options.unwrap ?? 'marked';
  const annotationNamespaces = new Set<string | null>([
    SK,
    ...(options.annotationNamespaces ?? []),
  ]);
  const isAnnotation = (element: XmlElement): boolean =>
    annotationNamespaces.has(element.namespaceURI);

  const parsed = parseXml(text, options.domParser);
  if (!parsed.ok) {
    issues.error('notXml', '', parsed.reason);
    return issues.fail();
  }
  const schema = parsed.document.documentElement!;
  if (schema.namespaceURI !== XS || schema.localName !== 'schema') {
    issues.error('notXsd', '', 'the document element is not xs:schema');
    return issues.fail();
  }

  const targetNamespace = schema.getAttribute('targetNamespace') ?? '';
  if (schema.getAttribute('elementFormDefault') !== 'qualified') {
    issues.warn(
      'unqualifiedElements',
      '/xs:schema',
      'local elements are unqualified; regenerated XSD qualifies them',
    );
  }

  const unsupported = (path: string, what: string): void => {
    if (strict)
      issues.error('unsupportedXsdConstruct', path, `${what} is not supported by the model`);
    else
      issues.warn(
        'unsupportedXsdConstruct',
        path,
        `${what} is not supported by the model; dropped`,
      );
  };

  const simpleTypes = new Map<string, XmlElement>();
  const complexTypes = new Map<string, XmlElement>();
  const globals = new Map<string, XmlElement>();
  for (const child of childElements(schema)) {
    const name = child.getAttribute('name') ?? '';
    if (child.namespaceURI !== XS) continue;
    switch (child.localName) {
      case 'annotation':
        break;
      case 'simpleType':
        simpleTypes.set(name, child);
        break;
      case 'complexType':
        complexTypes.set(name, child);
        break;
      case 'element':
        globals.set(name, child);
        break;
      default:
        issues.error(
          'unsupportedXsdConstruct',
          `/xs:schema/xs:${child.localName}`,
          `top-level xs:${child.localName} is not supported`,
        );
    }
  }
  if (issues.failed) return issues.fail();

  const qname = (value: string, context: XmlElement): { ns: string; local: string } => {
    const colon = value.indexOf(':');
    const prefix = colon < 0 ? null : value.slice(0, colon);
    const local = colon < 0 ? value : value.slice(colon + 1);
    return {
      ns: context.lookupNamespaceURI(prefix) ?? context.lookupNamespaceURI(prefix ?? '') ?? '',
      local,
    };
  };

  const isOwn = (ns: string): boolean => ns === targetNamespace;

  const appinfoChildren = (element: XmlElement): XmlElement[] =>
    xsChildren(element, 'annotation').flatMap((annotation) =>
      xsChildren(annotation, 'appinfo').flatMap((appinfo) =>
        childElements(appinfo).filter(isAnnotation),
      ),
    );

  const documentation = (element: XmlElement): LocalizedText | undefined => {
    const entries = xsChildren(element, 'annotation')
      .flatMap((annotation) => xsChildren(annotation, 'documentation'))
      .map((doc) => [langOf(doc) ?? '', textOf(doc).trim()] as const)
      .filter(([, value]) => value !== '');
    if (entries.length === 0) return undefined;
    return compactText(
      Object.fromEntries(
        entries.map(([lang, value]) => [lang && LOCALE_PATTERN.test(lang) ? lang : 'ru', value]),
      ),
    );
  };

  const i18n = (sk: XmlElement[], tag: string): LocalizedText | undefined => {
    const entries = sk
      .filter((element) => element.localName === tag)
      .map((element) => [langOf(element) ?? '', textOf(element)] as const)
      .filter(([lang]) => LOCALE_PATTERN.test(lang));
    return entries.length > 0 ? compactText(Object.fromEntries(entries)) : undefined;
  };

  const first = (sk: XmlElement[], tag: string): XmlElement | undefined =>
    sk.find((element) => element.localName === tag);

  const occurs = (element: XmlElement, attr: 'minOccurs' | 'maxOccurs'): number => {
    const raw = element.getAttribute(attr);
    if (raw === null || raw === '') return 1;
    if (raw === 'unbounded') return Infinity;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : 1;
  };

  const resolveSimple = (
    element: XmlElement,
    path: string,
    seen: Set<string>,
  ): ResolvedSimple | undefined => {
    if (xsChildren(element, 'list').length > 0 || xsChildren(element, 'union').length > 0) {
      issues.error('unsupportedXsdConstruct', path, 'xs:list and xs:union are not supported');
      return undefined;
    }
    const restriction = xsChildren(element, 'restriction')[0];
    if (!restriction) {
      issues.error('invalidSimpleType', path, 'simpleType without restriction');
      return undefined;
    }
    const baseAttr = restriction.getAttribute('base');
    let resolved: ResolvedSimple | undefined;
    if (baseAttr) {
      resolved = builtinOrNamed(baseAttr, restriction, path, seen);
    } else {
      const inline = xsChildren(restriction, 'simpleType')[0];
      resolved = inline ? resolveSimple(inline, `${path}/xs:simpleType`, seen) : undefined;
    }
    if (!resolved) return undefined;

    const facets: Facets = { ...resolved.facets, patterns: [...resolved.facets.patterns] };
    const levelPatterns: string[] = [];
    let levelEnum: Facets['enumeration'];
    for (const facet of xsChildren(restriction)) {
      const value = facet.getAttribute('value') ?? '';
      const at = `${path}/xs:${facet.localName}`;
      switch (facet.localName) {
        case 'length':
          facets.minLength = Number(value);
          facets.maxLength = Number(value);
          break;
        case 'minLength':
          facets.minLength = Number(value);
          break;
        case 'maxLength':
          facets.maxLength = Number(value);
          break;
        case 'pattern':
          levelPatterns.push(value);
          break;
        case 'minInclusive':
          facets.minimum = value;
          break;
        case 'maxInclusive':
          facets.maximum = value;
          break;
        case 'minExclusive':
          facets.exclusiveMinimum = value;
          break;
        case 'maxExclusive':
          facets.exclusiveMaximum = value;
          break;
        case 'enumeration': {
          const sk = appinfoChildren(facet);
          const image = first(sk, 'image');
          (levelEnum ??= []).push(
            defined({
              value,
              label: i18n(sk, 'i18n-label') ?? documentation(facet),
              image: image ? textOf(image) : undefined,
            }) as { value: string },
          );
          break;
        }
        case 'whiteSpace':
        case 'annotation':
        case 'simpleType':
          break;
        case 'assertion':
        case 'totalDigits':
        case 'fractionDigits':
        case 'explicitTimezone':
          unsupported(at, `xs:${facet.localName}`);
          break;
        default:
          unsupported(at, `xs:${facet.localName}`);
      }
    }
    if (levelPatterns.length > 0) facets.patterns.push(levelPatterns);
    if (levelEnum) facets.enumeration = levelEnum;
    const ecma = first(appinfoChildren(element), 'ecma-pattern');
    if (ecma) facets.ecmaPattern = textOf(ecma);
    return { base: resolved.base, facets, name: element.getAttribute('name') ?? undefined };
  };

  const builtinOrNamed = (
    value: string,
    context: XmlElement,
    path: string,
    seen: Set<string>,
  ): ResolvedSimple | undefined => {
    const { ns, local } = qname(value, context);
    if (ns === XS) {
      if ((XSD_BUILTINS as readonly string[]).includes(local))
        return { base: local as XsdBuiltin, facets: { patterns: [] } };
      if (NARROWED_TO_STRING.has(local)) {
        issues.warn('narrowedType', path, `xs:${local} read as xs:string`);
        return { base: 'string', facets: { patterns: [] } };
      }
      issues.error('unsupportedType', path, `xs:${local} has no model`);
      return undefined;
    }
    const named = isOwn(ns) ? simpleTypes.get(local) : undefined;
    if (!named) {
      issues.error('unknownType', path, `type "${value}" is not declared in this schema`);
      return undefined;
    }
    if (seen.has(local)) {
      issues.error('recursiveType', path, `type "${local}" derives from itself`);
      return undefined;
    }
    return resolveSimple(named, `/xs:simpleType[@name='${local}']`, new Set([...seen, local]));
  };

  const typed = (raw: string, category: Category): Scalar | undefined => {
    switch (category) {
      case 'string':
        return raw;
      case 'boolean':
        return raw === 'true' || raw === '1'
          ? true
          : raw === 'false' || raw === '0'
            ? false
            : undefined;
      case 'integer': {
        const value = Number(raw.trim());
        return raw.trim() !== '' && Number.isInteger(value) ? value : undefined;
      }
      case 'number': {
        const value = Number(raw.trim());
        return raw.trim() !== '' && Number.isFinite(value) ? value : undefined;
      }
    }
  };

  const scalarFrom = (
    resolved: ResolvedSimple,
    element: XmlElement,
    sk: XmlElement[],
    path: string,
  ): ScalarNode | undefined => {
    const category = CATEGORY[resolved.base]!;
    const { facets } = resolved;
    const hint: XmlHint = defined({
      type: resolved.name,
      base:
        resolved.base !== DEFAULT_BASE[category] &&
        !(category === 'string' && FORMAT_OF_BASE[resolved.base])
          ? resolved.base
          : undefined,
    });

    let pattern: string | undefined = facets.ecmaPattern;
    if (pattern === undefined && facets.patterns.length > 0) {
      if (facets.patterns.length > 1) {
        unsupported(path, 'patterns on several derivation steps');
      } else {
        const parts = facets.patterns[0]!.map((value) => xsdToEcmaPattern(value));
        const failed = parts.find((part) => !part.ok);
        if (failed && !failed.ok) issues.error('patternNotTranslatable', path, failed.reason);
        else pattern = parts.map((part) => (part.ok ? part.pattern : '')).join('|');
      }
    }

    const formatSk = first(sk, 'format');
    const format =
      formatSk && (STRING_FORMATS as readonly string[]).includes(textOf(formatSk))
        ? (textOf(formatSk) as StringFormat)
        : FORMAT_OF_BASE[resolved.base];

    const serviceSk = first(sk, 'options');
    let options: ScalarNode['options'];
    if (facets.enumeration) {
      const list: InlineOption[] = [];
      for (const entry of facets.enumeration) {
        const value = typed(entry.value, category);
        if (value === undefined) {
          issues.error(
            'enumTypeMismatch',
            path,
            `enumeration "${entry.value}" does not fit xs:${resolved.base}`,
          );
          continue;
        }
        list.push(
          defined({ value, label: entry.label, image: entry.image }) as unknown as InlineOption,
        );
      }
      options = { kind: 'inline', options: list };
    } else if (serviceSk && serviceSk.getAttribute('kind') === 'service') {
      options = serviceFrom(serviceSk);
    }

    const number = (raw: string | undefined): number | undefined => {
      if (raw === undefined) return undefined;
      const value = Number(raw);
      if (Number.isFinite(value) && raw.trim() !== '') return value;
      unsupported(path, `bound "${raw}" on xs:${resolved.base}`);
      return undefined;
    };
    const fixed = element.getAttribute('fixed');
    const defaultValue = element.getAttribute('default');
    const common = defined({
      options,
      const: fixed !== null ? typed(fixed, category) : undefined,
      default: defaultValue !== null ? typed(defaultValue, category) : undefined,
      xml: Object.keys(hint).length > 0 ? hint : undefined,
    });

    switch (category) {
      case 'string':
        return defined({
          kind: 'string',
          format,
          minLength: facets.minLength,
          maxLength: facets.maxLength,
          pattern,
          ...common,
        }) as unknown as ScalarNode;
      case 'boolean':
        return { kind: 'boolean', ...common } as ScalarNode;
      default:
        return defined({
          kind: category,
          minimum: number(facets.minimum),
          maximum: number(facets.maximum),
          exclusiveMinimum: number(facets.exclusiveMinimum),
          exclusiveMaximum: number(facets.exclusiveMaximum),
          ...common,
        }) as unknown as ScalarNode;
    }
  };

  const serviceFrom = (element: XmlElement): ServiceOptions => {
    const kids = childElements(element).filter(isAnnotation);
    const fill = Object.fromEntries(
      kids
        .filter((kid) => kid.localName === 'fill')
        .map((kid) => [kid.getAttribute('property') ?? '', kid.getAttribute('pointer') ?? '']),
    );
    const params = Object.fromEntries(
      kids
        .filter((kid) => kid.localName === 'param')
        .map((kid) => [kid.getAttribute('key') ?? '', kid.getAttribute('field') ?? '']),
    );
    const filter = kids.find((kid) => kid.localName === 'filter-by');
    return defined({
      kind: 'service',
      serviceId: element.getAttribute('serviceId') ?? '',
      itemsPointer: element.getAttribute('itemsPointer') ?? undefined,
      valuePointer: element.getAttribute('valuePointer') ?? '',
      labelPointer: element.getAttribute('labelPointer') ?? '',
      fill: Object.keys(fill).length > 0 ? fill : undefined,
      params: Object.keys(params).length > 0 ? params : undefined,
      filterBy: filter
        ? {
            field: filter.getAttribute('field') ?? '',
            pointer: filter.getAttribute('pointer') ?? '',
          }
        : undefined,
    }) as unknown as ServiceOptions;
  };

  const complexSeen = new Set<string>();

  const complexFrom = (element: XmlElement, path: string): ObjectNode | undefined => {
    const name = element.getAttribute('name');
    if (name) {
      if (complexSeen.has(name)) {
        issues.error('recursiveType', path, `complexType "${name}" contains itself`);
        return undefined;
      }
      complexSeen.add(name);
    }
    if (element.getAttribute('mixed') === 'true') unsupported(path, 'mixed content');

    const properties: Property[] = [];
    const choices: Choice[] = [];
    let asserts = 0;

    const particle = (
      child: XmlElement,
      at: string,
      choice?: { id: string; members: string[] },
    ): void => {
      switch (child.localName) {
        case 'element': {
          const property = propertyFrom(
            child,
            `${at}/xs:element[@name='${child.getAttribute('name') ?? child.getAttribute('ref')}']`,
            choice !== undefined,
          );
          if (property) {
            properties.push(property);
            choice?.members.push(property.name);
          }
          break;
        }
        case 'sequence':
        case 'all':
          if (choice) {
            unsupported(at, 'a sequence inside xs:choice');
            break;
          }
          if (occurs(child, 'minOccurs') !== 1 || occurs(child, 'maxOccurs') !== 1) {
            unsupported(at, 'a repeating or optional sequence');
            break;
          }
          xsChildren(child).forEach((inner) => particle(inner, `${at}/xs:${inner.localName}`));
          break;
        case 'choice': {
          if (choice) {
            unsupported(at, 'nested xs:choice');
            break;
          }
          if (occurs(child, 'maxOccurs') !== 1) {
            unsupported(at, 'a repeating xs:choice');
            break;
          }
          const marker = first(appinfoChildren(child), 'choice');
          const group = {
            id: marker?.getAttribute('id') ?? `choice${choices.length + 1}`,
            members: [] as string[],
          };
          xsChildren(child).forEach((inner) =>
            particle(inner, `${at}/xs:${inner.localName}`, group),
          );
          if (group.members.length >= 2) {
            choices.push(
              defined({
                id: group.id,
                required: occurs(child, 'minOccurs') >= 1 ? true : undefined,
                members: group.members,
              }) as unknown as Choice,
            );
          } else if (group.members.length === 1) {
            issues.warn(
              'singleBranchChoice',
              at,
              'xs:choice with one branch read as an optional element',
            );
          }
          break;
        }
        case 'annotation':
          break;
        default:
          unsupported(at, `xs:${child.localName}`);
      }
    };

    for (const child of xsChildren(element)) {
      const at = `${path}/xs:${child.localName}`;
      switch (child.localName) {
        case 'annotation':
          break;
        case 'sequence':
        case 'all':
        case 'choice':
          particle(child, path);
          break;
        case 'assert':
          asserts++;
          break;
        default:
          unsupported(at, `xs:${child.localName}`);
      }
    }
    if (name) complexSeen.delete(name);

    const derivedFromAnnotations =
      properties.some((property) => property.visibleIf || property.requiredIf) ||
      properties.some(
        (property) => property.node.kind === 'array' && property.node.minItems !== undefined,
      );
    if (asserts > 0 && !derivedFromAnnotations) {
      issues.warn(
        'assertDropped',
        path,
        `${asserts} xs:assert without schema-kit annotations; not carried into the model`,
      );
    }

    return defined({
      kind: 'object',
      properties,
      choices: choices.length > 0 ? choices : undefined,
      xml: name ? { type: name } : undefined,
    }) as unknown as ObjectNode;
  };

  const valueOf = (
    declaration: XmlElement,
    sk: XmlElement[],
    path: string,
  ): SchemaNode | undefined => {
    const typeAttr = declaration.getAttribute('type');
    if (typeAttr) {
      const { ns, local } = qname(typeAttr, declaration);
      if (isOwn(ns) && complexTypes.has(local))
        return complexFrom(complexTypes.get(local)!, `/xs:complexType[@name='${local}']`);
      const resolved = builtinOrNamed(typeAttr, declaration, path, new Set());
      return resolved ? scalarFrom(resolved, declaration, sk, path) : undefined;
    }
    const inlineComplex = xsChildren(declaration, 'complexType')[0];
    if (inlineComplex) return complexFrom(inlineComplex, `${path}/xs:complexType`);
    const inlineSimple = xsChildren(declaration, 'simpleType')[0];
    if (inlineSimple) {
      const resolved = resolveSimple(inlineSimple, `${path}/xs:simpleType`, new Set());
      return resolved ? scalarFrom(resolved, declaration, sk, path) : undefined;
    }
    unsupported(path, 'an element without a type (xs:anyType)');
    return undefined;
  };

  const propertyFrom = (
    local: XmlElement,
    path: string,
    inChoice: boolean,
  ): Property | undefined => {
    let declaration = local;
    const refAttr = local.getAttribute('ref');
    if (refAttr) {
      const { ns, local: refName } = qname(refAttr, local);
      const global = isOwn(ns) ? globals.get(refName) : undefined;
      if (!global) {
        issues.error('unknownElement', path, `element ref "${refAttr}" is not declared`);
        return undefined;
      }
      declaration = global;
    }
    const name = declaration.getAttribute('name') ?? '';
    if (declaration.getAttribute('nillable') === 'true')
      issues.warn(
        'nillableDropped',
        path,
        'nillable is not carried; absence expresses an empty value',
      );

    const sk = [
      ...appinfoChildren(declaration),
      ...(declaration === local ? [] : appinfoChildren(local)),
    ];
    const node = valueOf(declaration, sk, path);
    if (!node) return undefined;

    const min = occurs(local, 'minOccurs');
    const max = occurs(local, 'maxOccurs');
    const isArray = max !== 1 || first(sk, 'array') !== undefined;
    let valueNode: SchemaNode = node;
    if (isArray) {
      const minItemsSk = first(sk, 'min-items');
      const groups = sk
        .filter((element) => element.localName === 'option-group')
        .map((element) => {
          const values = childElements(element)
            .filter((child) => isAnnotation(child) && child.localName === 'value')
            .map((child) => parseValue(textOf(child), child.getAttribute('type')))
            .filter((value): value is Scalar => value !== undefined);
          return {
            values,
            select: element.getAttribute('select') === 'one' ? 'one' : 'many',
          } as OptionGroup;
        });
      valueNode = defined({
        kind: 'array',
        items: node,
        minItems: minItemsSk ? Number(textOf(minItemsSk)) : min > 1 ? min : undefined,
        maxItems: Number.isFinite(max) ? max : undefined,
        uniqueItems: first(sk, 'unique-items') ? true : undefined,
        optionGroups: groups.length > 0 ? groups : undefined,
      }) as unknown as ArrayNode;
    }

    const condition = (tag: string): Condition | undefined => {
      const element = first(sk, tag);
      if (!element) return undefined;
      const parsedCondition = wrappedConditionFromXml(element);
      if (!parsedCondition)
        issues.error('unsupportedCondition', path, `sk:${tag} is not a valid condition`);
      return parsedCondition;
    };

    const controlSk = first(sk, 'control');
    const control =
      controlSk && (CONTROLS as readonly string[]).includes(textOf(controlSk))
        ? (textOf(controlSk) as Control)
        : undefined;
    if (controlSk && !control)
      issues.warn(
        'unsupportedControl',
        path,
        `control "${textOf(controlSk)}" is not approved; dropped`,
      );
    const bindingSk = first(sk, 'binding');
    const binding: Binding | undefined = bindingSk
      ? {
          model: bindingSk.getAttribute('model') ?? '',
          version: bindingSk.getAttribute('version') ?? '',
          pointer: bindingSk.getAttribute('pointer') ?? '',
        }
      : undefined;
    const dataClass = first(sk, 'data-class');
    const visibleIf = condition('visible-if');
    const required = !inChoice && (first(sk, 'required') !== undefined || (min >= 1 && !visibleIf));

    return defined({
      name,
      node: valueNode,
      required: required ? true : undefined,
      title: i18n(sk, 'i18n-title'),
      description: i18n(sk, 'i18n-description') ?? documentation(declaration),
      placeholder: i18n(sk, 'i18n-placeholder'),
      control,
      visibleIf,
      requiredIf: condition('required-if'),
      transient: first(sk, 'transient') ? true : undefined,
      binding,
      dataClass: dataClass ? textOf(dataClass) : undefined,
    }) as unknown as Property;
  };

  let rootName = options.rootElement;
  if (rootName === undefined) {
    if (globals.size === 1) rootName = [...globals.keys()][0]!;
    else {
      const requests = [...globals.keys()].filter((name) => name.endsWith('Request'));
      if (requests.length === 1) rootName = requests[0]!;
    }
  }
  const rootElement = rootName !== undefined ? globals.get(rootName) : undefined;
  if (!rootElement || rootName === undefined) {
    issues.error(
      'ambiguousRoot',
      '/xs:schema',
      `cannot choose the root among: ${[...globals.keys()].join(', ') || 'no global elements'}`,
    );
    return issues.fail();
  }

  const typeElementOf = (declaration: XmlElement): XmlElement | undefined => {
    const typeAttr = declaration.getAttribute('type');
    if (typeAttr) {
      const { ns, local } = qname(typeAttr, declaration);
      return isOwn(ns) ? complexTypes.get(local) : undefined;
    }
    return xsChildren(declaration, 'complexType')[0];
  };

  let currentType = typeElementOf(rootElement);
  if (!currentType) {
    issues.error(
      'rootNotComplex',
      '/xs:schema',
      `root element "${rootName}" must have a complex type`,
    );
    return issues.fail();
  }
  const rootTypeName = currentType.getAttribute('name') ?? undefined;
  const wrapper: WrapperLevel[] = [];
  const typeNames: (string | undefined)[] = [rootTypeName];

  for (;;) {
    const sequences = xsChildren(currentType).filter((child) => child.localName !== 'annotation');
    const sequence =
      sequences.length === 1 && sequences[0]!.localName === 'sequence' ? sequences[0]! : undefined;
    const children = sequence
      ? xsChildren(sequence).filter((child) => child.localName !== 'annotation')
      : [];
    const only =
      children.length === 1 && children[0]!.localName === 'element' ? children[0]! : undefined;
    if (!only || occurs(only, 'minOccurs') !== 1 || occurs(only, 'maxOccurs') !== 1) break;
    const innerType = typeElementOf(only);
    if (!innerType) break;
    const sk = appinfoChildren(only);
    const marked = first(sk, 'wrapper') !== undefined;
    if (!marked && unwrapMode !== 'heuristic') break;
    wrapper.push(
      defined({
        name: only.getAttribute('name') ?? '',
        title: i18n(sk, 'i18n-title'),
      }) as unknown as WrapperLevel,
    );
    typeNames.push(innerType.getAttribute('name') ?? undefined);
    currentType = innerType;
  }

  const body = complexFrom(
    currentType,
    rootTypeName ? `/xs:complexType[@name='${rootTypeName}']` : '/xs:element/xs:complexType',
  );
  if (!body) return issues.fail();

  const wrapperWithTypes = wrapper.map((level, index) => {
    const actual = typeNames[index + 1];
    return actual && actual !== `${pascal(level.name)}Type`
      ? { ...level, typeName: actual }
      : level;
  });
  const bodyHint =
    wrapper.length === 0 && rootTypeName !== undefined && rootTypeName !== rootName
      ? rootTypeName
      : undefined;
  const root = defined({
    ...body,
    xml: bodyHint ? { type: bodyHint } : undefined,
  }) as unknown as ObjectNode;
  const rootType =
    wrapper.length > 0 && rootTypeName !== undefined && rootTypeName !== rootName
      ? rootTypeName
      : undefined;

  const schemaSk = appinfoChildren(schema);
  const canonical = first(schemaSk, 'canonical');
  const localesAttr = canonical
    ?.getAttribute('locales')
    ?.split(/\s+/)
    .filter((locale) => LOCALE_PATTERN.test(locale));
  const idSk = first(schemaSk, 'id');
  const modelSk = first(schemaSk, 'model');

  const doc = defined({
    id: idSk ? textOf(idSk) : undefined,
    title: i18n(schemaSk, 'i18n-title'),
    description: i18n(schemaSk, 'i18n-description') ?? documentation(schema),
    locales: localesAttr && localesAttr.length > 0 ? localesAttr : undefined,
    defaultLocale: canonical?.getAttribute('defaultLocale') ?? undefined,
    root,
    xml: defined({
      rootElement: rootName,
      targetNamespace,
      wrapper: wrapperWithTypes.length > 0 ? wrapperWithTypes : undefined,
      rootType,
    }),
    model: modelSk
      ? { code: modelSk.getAttribute('code') ?? '', version: modelSk.getAttribute('version') ?? '' }
      : undefined,
  }) as unknown as SchemaDocument;

  if (issues.failed) return issues.fail();
  issues.push(validateDocument(doc).list);
  return issues.result(doc);
};
