import { isApprovedAnnotation, JSON_SCHEMA_DIALECT } from '../annotations.js';
import { Issues, pointer, type Result } from '../issues.js';
import {
  conditionFromSubschema,
  scalarKind,
  type Condition,
  type Scalar,
} from '../model/condition.js';
import { compactText } from '../model/localized.js';
import {
  CONTROLS,
  DEFAULT_LOCALES,
  LOCAL_REF_PREFIX,
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
  type OptionsSource,
  type Property,
  type SchemaDocument,
  type SchemaNode,
  type StringFormat,
  type WrapperLevel,
  type XmlHint,
  type XmlSettings,
  type XsdBuiltin,
} from '../model/types.js';
import { validateDocument } from '../model/validate.js';
import { canonicalEquals, canonicalJson } from '../util/canonical.js';
import { asRecord, defined, type JsonObject } from '../util/object.js';
import { verifyChecksum } from './emit.js';

export interface FromJsonSchemaOptions {
  /**
   * `true` (default): a validation keyword the model cannot carry is an error, because dropping
   * it would change which data the schema accepts. `false` reports it as a warning and drops it.
   */
  readonly strict?: boolean;
}

const ANNOTATION_KEYWORDS = new Set([
  '$comment',
  'examples',
  'readOnly',
  'writeOnly',
  'deprecated',
  'contentMediaType',
  'contentEncoding',
  '$anchor',
  '$dynamicAnchor',
  'nullable',
]);

const TYPES = new Set(['string', 'integer', 'number', 'boolean', 'object', 'array']);

const isScalar = (value: unknown): value is Scalar =>
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));

class Cursor {
  private readonly used = new Set<string>();
  readonly raw: JsonObject;
  readonly path: string;

  constructor(raw: JsonObject, path: string) {
    this.raw = raw;
    this.path = path;
  }

  has(key: string): boolean {
    return this.raw[key] !== undefined;
  }

  take(key: string): unknown {
    this.used.add(key);
    return this.raw[key];
  }

  skip(...keys: string[]): void {
    keys.forEach((key) => this.used.add(key));
  }

  rest(): string[] {
    return Object.keys(this.raw).filter((key) => !this.used.has(key));
  }
}

export const fromJsonSchema = (
  input: unknown,
  options: FromJsonSchemaOptions = {},
): Result<SchemaDocument> => {
  const issues = new Issues();
  const strict = options.strict ?? true;

  let source = input;
  if (typeof input === 'string') {
    try {
      source = JSON.parse(input);
    } catch (error) {
      issues.error('notJson', '', (error as Error).message);
      return issues.fail();
    }
  }
  const rootRaw = asRecord(source);
  if (!rootRaw) {
    issues.error('notSchemaObject', '', 'a schema document must be a JSON object');
    return issues.fail();
  }

  const canonical = asRecord(rootRaw['x-canonical']);
  const localesRaw = canonical?.['locales'];
  const locales =
    Array.isArray(localesRaw) &&
    localesRaw.length > 0 &&
    localesRaw.every((locale) => typeof locale === 'string' && LOCALE_PATTERN.test(locale))
      ? (localesRaw as string[])
      : undefined;
  const defaultLocale =
    typeof canonical?.['defaultLocale'] === 'string'
      ? canonical['defaultLocale']
      : (locales ?? DEFAULT_LOCALES)[0]!;

  const unsupported = (
    path: string,
    key: string,
    detail = 'is not supported by the model',
  ): void => {
    const message = `"${key}" ${detail}`;
    if (strict) issues.error('unsupportedKeyword', path, message);
    else issues.warn('unsupportedKeyword', path, `${message}; dropped`);
  };

  const reportRest = (cursor: Cursor): void => {
    for (const key of cursor.rest()) {
      const at = pointer(cursor.path, key);
      if (key.startsWith('x-')) {
        if (isApprovedAnnotation(key))
          issues.warn('misplacedAnnotation', at, `"${key}" is not valid here; dropped`);
        else
          issues.warn(
            'unapprovedAnnotation',
            at,
            `"${key}" is not an approved annotation; dropped`,
          );
      } else if (ANNOTATION_KEYWORDS.has(key)) {
        issues.info('annotationDropped', at, `"${key}" carries no validation; dropped`);
      } else {
        unsupported(at, key);
      }
    }
  };

  const text = (value: unknown, path: string): LocalizedText | undefined => {
    if (value === undefined) return undefined;
    const record = asRecord(value);
    if (
      !record ||
      !Object.entries(record).every(
        ([key, entry]) => LOCALE_PATTERN.test(key) && typeof entry === 'string',
      )
    ) {
      issues.warn('invalidLocalizedText', path, 'expected {locale: text}; dropped');
      return undefined;
    }
    return compactText(record as LocalizedText);
  };

  const localized = (
    cursor: Cursor,
    name: 'title' | 'description' | 'placeholder',
  ): LocalizedText | undefined => {
    const key = `x-i18n-${name}`;
    const fromKey = text(cursor.take(key), pointer(cursor.path, key));
    const legacy = asRecord(cursor.raw['x-i18n']);
    const fromLegacy = legacy
      ? text(legacy[name], pointer(cursor.path, 'x-i18n', name))
      : undefined;
    const plainValue = name === 'placeholder' ? undefined : cursor.take(name);
    const fromPlain =
      typeof plainValue === 'string' && plainValue.trim() !== ''
        ? { [defaultLocale]: plainValue }
        : undefined;
    return fromKey ?? fromLegacy ?? fromPlain;
  };

  const legacyBundle = (cursor: Cursor): void => {
    if (cursor.has('x-i18n')) {
      cursor.take('x-i18n');
      issues.warn(
        'legacyAnnotation',
        pointer(cursor.path, 'x-i18n'),
        'x-i18n bundle read as x-i18n-title/description/placeholder',
      );
    }
  };

  const condition = (cursor: Cursor, key: string): Condition | undefined => {
    const raw = cursor.take(key);
    if (raw === undefined) return undefined;
    const parsed = conditionFromSubschema(raw);
    if (!parsed)
      issues.error(
        'unsupportedCondition',
        pointer(cursor.path, key),
        'condition is outside the supported vocabulary',
      );
    return parsed;
  };

  const xmlHintOf = (cursor: Cursor): XmlHint | undefined => {
    const raw = cursor.take('x-xml');
    if (raw === undefined) return undefined;
    const record = asRecord(raw);
    const type = record?.['type'];
    const base = record?.['base'];
    const hint = defined({
      type: typeof type === 'string' ? type : undefined,
      base:
        typeof base === 'string' && (XSD_BUILTINS as readonly string[]).includes(base)
          ? (base as XsdBuiltin)
          : undefined,
    }) as XmlHint;
    return Object.keys(hint).length > 0 ? hint : undefined;
  };

  const resolveType = (cursor: Cursor): string | undefined => {
    const raw = cursor.take('type');
    if (typeof raw === 'string') {
      if (!TYPES.has(raw)) {
        if (raw !== 'null')
          issues.error('unsupportedType', pointer(cursor.path, 'type'), `type "${raw}"`);
        else
          issues.error(
            'unsupportedType',
            pointer(cursor.path, 'type'),
            'a null-only type has no model',
          );
        return undefined;
      }
      return raw;
    }
    if (Array.isArray(raw)) {
      const types = raw.filter((entry) => entry !== 'null');
      if (types.length === 1 && typeof types[0] === 'string' && TYPES.has(types[0])) {
        issues.warn(
          'nullableType',
          pointer(cursor.path, 'type'),
          'null dropped; absence expresses an empty value',
        );
        return types[0];
      }
      issues.error(
        'unsupportedTypeUnion',
        pointer(cursor.path, 'type'),
        `type union ${JSON.stringify(raw)}`,
      );
      return undefined;
    }
    if (raw !== undefined) {
      issues.error('unsupportedType', pointer(cursor.path, 'type'), 'type must be a string');
      return undefined;
    }
    const probe =
      cursor.raw['const'] ??
      (Array.isArray(cursor.raw['enum']) ? (cursor.raw['enum'] as unknown[])[0] : undefined);
    if (isScalar(probe)) {
      const kind = scalarKind(probe);
      return kind === 'number' ? (Number.isInteger(probe) ? 'integer' : 'number') : kind;
    }
    if (cursor.has('properties')) return 'object';
    if (cursor.has('items')) return 'array';
    issues.error('missingType', cursor.path, 'type cannot be determined');
    return undefined;
  };

  const fits = (type: string, value: unknown): value is Scalar => {
    if (!isScalar(value)) return false;
    switch (type) {
      case 'string':
        return typeof value === 'string';
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value);
      case 'number':
        return typeof value === 'number';
      case 'boolean':
        return typeof value === 'boolean';
      default:
        return false;
    }
  };

  const optionsOf = (cursor: Cursor, type: string): OptionsSource | undefined => {
    const enumRaw = cursor.take('enum');
    const xOptions = asRecord(cursor.take('x-options'));
    const at = pointer(cursor.path, 'x-options');

    if (xOptions?.['kind'] === 'service') {
      const serviceId = xOptions['serviceId'];
      const valuePointer = xOptions['valuePointer'];
      const labelPointer = xOptions['labelPointer'];
      if (
        typeof serviceId !== 'string' ||
        typeof valuePointer !== 'string' ||
        typeof labelPointer !== 'string'
      ) {
        issues.error(
          'invalidServiceOptions',
          at,
          'serviceId, valuePointer and labelPointer are required',
        );
        return undefined;
      }
      if (enumRaw !== undefined)
        issues.warn(
          'enumWithService',
          pointer(cursor.path, 'enum'),
          'enum next to a dictionary; dropped',
        );
      const filterBy = asRecord(xOptions['filterBy']);
      return defined({
        kind: 'service',
        serviceId,
        itemsPointer:
          typeof xOptions['itemsPointer'] === 'string' ? xOptions['itemsPointer'] : undefined,
        valuePointer,
        labelPointer,
        fill: asRecord(xOptions['fill']) as Record<string, string> | undefined,
        params: asRecord(xOptions['params']) as Record<string, string> | undefined,
        filterBy:
          filterBy &&
          typeof filterBy['field'] === 'string' &&
          typeof filterBy['pointer'] === 'string'
            ? { field: filterBy['field'], pointer: filterBy['pointer'] }
            : undefined,
      }) as unknown as OptionsSource;
    }

    if (xOptions && xOptions['kind'] !== 'inline') {
      issues.warn(
        'unsupportedOptions',
        at,
        'x-options without kind "inline" or "service"; dropped',
      );
    }

    const decorations = new Map<string, InlineOption>();
    const decorated =
      xOptions?.['kind'] === 'inline' && Array.isArray(xOptions['options'])
        ? (xOptions['options'] as unknown[])
        : [];
    decorated.forEach((entry, index) => {
      const record = asRecord(entry);
      if (!record || !isScalar(record['value'])) {
        issues.warn(
          'invalidOption',
          pointer(at, 'options', index),
          'option without a scalar value; dropped',
        );
        return;
      }
      decorations.set(
        canonicalJson(record['value']),
        defined({
          value: record['value'],
          label: text(record['x-i18n-label'], pointer(at, 'options', index, 'x-i18n-label')),
          image: typeof record['image'] === 'string' ? record['image'] : undefined,
        }) as unknown as InlineOption,
      );
    });

    let values: Scalar[] | undefined;
    if (enumRaw !== undefined) {
      if (!Array.isArray(enumRaw) || enumRaw.length === 0) {
        issues.error('invalidEnum', pointer(cursor.path, 'enum'), 'enum must be a non-empty array');
        return undefined;
      }
      const withoutNull = enumRaw.filter((value) => value !== null);
      if (withoutNull.length !== enumRaw.length) {
        issues.warn('nullableType', pointer(cursor.path, 'enum'), 'null dropped from enum');
      }
      const misfit = withoutNull.find((value) => !fits(type, value));
      if (misfit !== undefined) {
        issues.error(
          'enumTypeMismatch',
          pointer(cursor.path, 'enum'),
          `${JSON.stringify(misfit)} does not fit type "${type}"`,
        );
        return undefined;
      }
      values = withoutNull as Scalar[];
    } else if (decorations.size > 0) {
      issues.warn(
        'optionsWithoutEnum',
        at,
        'inline options without enum; values taken from x-options',
      );
      values = [...decorations.values()]
        .map((option) => option.value)
        .filter((value) => fits(type, value));
    }
    if (!values) return undefined;

    for (const key of decorations.keys()) {
      if (!values.some((value) => canonicalJson(value) === key)) {
        issues.warn('orphanOptionLabel', at, `label for ${key} which enum does not list; dropped`);
      }
    }
    return {
      kind: 'inline',
      options: values.map((value) => decorations.get(canonicalJson(value)) ?? { value }),
    };
  };

  const scalarOf = (
    cursor: Cursor,
    type: 'string' | 'integer' | 'number' | 'boolean',
  ): SchemaNode => {
    const number = (key: string): number | undefined => {
      const value = cursor.take(key);
      if (value === undefined) return undefined;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'boolean') {
        unsupported(pointer(cursor.path, key), key, 'as a boolean (draft-04) is not supported');
      } else issues.error('invalidKeyword', pointer(cursor.path, key), `"${key}" must be a number`);
      return undefined;
    };
    const typed = (key: string): Scalar | undefined => {
      const value = cursor.take(key);
      if (value === undefined) return undefined;
      if (fits(type, value)) return value;
      issues.error(
        'valueTypeMismatch',
        pointer(cursor.path, key),
        `"${key}" does not fit type "${type}"`,
      );
      return undefined;
    };
    const common = defined({
      options: optionsOf(cursor, type),
      const: typed('const'),
      default: typed('default'),
      xml: xmlHintOf(cursor),
    });

    if (type === 'string') {
      const formatRaw = cursor.take('format');
      let format: StringFormat | undefined;
      if (typeof formatRaw === 'string') {
        if ((STRING_FORMATS as readonly string[]).includes(formatRaw))
          format = formatRaw as StringFormat;
        else
          issues.warn(
            'unsupportedFormat',
            pointer(cursor.path, 'format'),
            `format "${formatRaw}" is not in the model; dropped`,
          );
      }
      const pattern = cursor.take('pattern');
      return defined({
        kind: 'string',
        format,
        minLength: number('minLength'),
        maxLength: number('maxLength'),
        pattern: typeof pattern === 'string' ? pattern : undefined,
        ...common,
      }) as unknown as SchemaNode;
    }
    if (type === 'boolean') return { kind: 'boolean', ...common } as SchemaNode;
    return defined({
      kind: type,
      minimum: number('minimum'),
      maximum: number('maximum'),
      exclusiveMinimum: number('exclusiveMinimum'),
      exclusiveMaximum: number('exclusiveMaximum'),
      ...common,
    }) as unknown as SchemaNode;
  };

  const arrayOf = (cursor: Cursor): ArrayNode | undefined => {
    const itemsRaw = asRecord(cursor.take('items'));
    if (!itemsRaw) {
      issues.error('missingItems', cursor.path, 'array needs an items schema');
      return undefined;
    }
    const items = nodeOf(new Cursor(itemsRaw, pointer(cursor.path, 'items')));
    if (!items) return undefined;
    const groupsRaw = cursor.take('x-optionGroups');
    let optionGroups: OptionGroup[] | undefined;
    if (groupsRaw !== undefined) {
      cursor.take('anyOf');
      if (
        Array.isArray(groupsRaw) &&
        groupsRaw.every((group) => {
          const record = asRecord(group);
          return (
            record &&
            Array.isArray(record['values']) &&
            (record['select'] === 'one' || record['select'] === 'many')
          );
        })
      ) {
        optionGroups = groupsRaw as OptionGroup[];
      } else
        issues.error(
          'invalidOptionGroups',
          pointer(cursor.path, 'x-optionGroups'),
          'expected [{values, select}]',
        );
    }
    const count = (key: string): number | undefined => {
      const value = cursor.take(key);
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
    };
    const unique = cursor.take('uniqueItems');
    return defined({
      kind: 'array',
      items,
      minItems: count('minItems'),
      maxItems: count('maxItems'),
      uniqueItems: unique === true ? true : undefined,
      optionGroups,
    }) as unknown as ArrayNode;
  };

  const objectOf = (cursor: Cursor): ObjectNode | undefined => {
    const propertiesRaw = cursor.take('properties');
    const properties = propertiesRaw === undefined ? {} : asRecord(propertiesRaw);
    if (!properties) {
      issues.error(
        'invalidProperties',
        pointer(cursor.path, 'properties'),
        'properties must be an object',
      );
      return undefined;
    }
    const requiredRaw = cursor.take('required');
    const required = new Set(
      Array.isArray(requiredRaw)
        ? requiredRaw.filter((entry): entry is string => typeof entry === 'string')
        : [],
    );
    for (const name of required) {
      if (!(name in properties))
        issues.warn(
          'requiredNotDeclared',
          pointer(cursor.path, 'required'),
          `"${name}" is required but not declared; dropped`,
        );
    }
    const additional = cursor.take('additionalProperties');
    if (additional !== undefined && typeof additional !== 'boolean') {
      unsupported(
        pointer(cursor.path, 'additionalProperties'),
        'additionalProperties',
        'as a schema is not supported',
      );
    }
    if (cursor.has('x-derived')) {
      cursor.skip('x-derived', 'allOf');
    }

    const choicesRaw = cursor.take('x-choices');
    let choices: Choice[] | undefined;
    if (choicesRaw !== undefined) {
      if (
        Array.isArray(choicesRaw) &&
        choicesRaw.every((choice) => {
          const record = asRecord(choice);
          return record && typeof record['id'] === 'string' && Array.isArray(record['members']);
        })
      ) {
        choices = (choicesRaw as JsonObject[]).map((choice) =>
          defined({
            id: choice['id'],
            required: choice['required'] === true ? true : undefined,
            members: choice['members'],
          }),
        ) as unknown as Choice[];
      } else
        issues.error(
          'invalidChoices',
          pointer(cursor.path, 'x-choices'),
          'expected [{id, required?, members}]',
        );
    }

    const xml = cursor.take('x-xml');
    const typeName = asRecord(xml)?.['type'];

    const list: Property[] = [];
    for (const [name, raw] of Object.entries(properties)) {
      const property = propertyOf(
        name,
        raw,
        pointer(cursor.path, 'properties', name),
        required.has(name),
      );
      if (property) list.push(property);
    }
    return defined({
      kind: 'object',
      properties: list,
      choices,
      xml: typeof typeName === 'string' ? { type: typeName } : undefined,
    }) as unknown as ObjectNode;
  };

  const nodeOf = (cursor: Cursor): SchemaNode | undefined => {
    const ref = cursor.take('$ref');
    let node: SchemaNode | undefined;
    if (ref !== undefined) {
      if (typeof ref !== 'string') {
        issues.error('invalidRef', pointer(cursor.path, '$ref'), '$ref must be a string');
        return undefined;
      }
      const normalized = ref.startsWith('#/definitions/')
        ? `${LOCAL_REF_PREFIX}${ref.slice('#/definitions/'.length)}`
        : ref;
      node = { kind: 'ref', ref: normalized };
    } else {
      const type = resolveType(cursor);
      if (type === undefined) return undefined;
      node =
        type === 'object'
          ? objectOf(cursor)
          : type === 'array'
            ? arrayOf(cursor)
            : scalarOf(cursor, type as 'string' | 'integer' | 'number' | 'boolean');
    }
    reportRest(cursor);
    return node;
  };

  const propertyOf = (
    name: string,
    raw: unknown,
    path: string,
    required: boolean,
  ): Property | undefined => {
    const record = asRecord(raw);
    if (!record) {
      if (raw === true || raw === false)
        unsupported(path, name, 'as a boolean schema is not supported');
      else issues.error('invalidProperty', path, 'property schema must be an object');
      return undefined;
    }
    const cursor = new Cursor(record, path);
    const title = localized(cursor, 'title');
    const description = localized(cursor, 'description');
    const placeholder = localized(cursor, 'placeholder');
    legacyBundle(cursor);

    const controlRaw = cursor.take('x-control');
    let control: Control | undefined;
    if (typeof controlRaw === 'string') {
      if ((CONTROLS as readonly string[]).includes(controlRaw)) control = controlRaw as Control;
      else
        issues.warn(
          'unsupportedControl',
          pointer(path, 'x-control'),
          `control "${controlRaw}" is not approved; dropped`,
        );
    }
    const visibleIf = condition(cursor, 'x-visibleIf');
    let requiredIf = condition(cursor, 'x-requiredIf');
    let isRequired = required;
    if (!isRequired && visibleIf && requiredIf && canonicalEquals(visibleIf, requiredIf)) {
      isRequired = true;
      requiredIf = undefined;
    }
    if (isRequired && requiredIf) {
      issues.warn('requiredAndRequiredIf', path, 'required unconditionally; x-requiredIf dropped');
      requiredIf = undefined;
    }
    const transient = cursor.take('x-transient') === true ? true : undefined;
    const bindingRaw = asRecord(cursor.take('x-binding'));
    let binding: Binding | undefined;
    if (bindingRaw) {
      const { model, version, pointer: at } = bindingRaw;
      if (typeof model === 'string' && typeof version === 'string' && typeof at === 'string')
        binding = { model, version, pointer: at };
      else
        issues.warn(
          'invalidBinding',
          pointer(path, 'x-binding'),
          'expected {model, version, pointer}; dropped',
        );
    }
    const dataClass = cursor.take('x-data-class');

    const node = nodeOf(cursor);
    if (!node) return undefined;
    return defined({
      name,
      node,
      required: isRequired ? true : undefined,
      title,
      description,
      placeholder,
      control,
      visibleIf,
      requiredIf,
      transient,
      binding,
      dataClass: typeof dataClass === 'string' ? dataClass : undefined,
    }) as unknown as Property;
  };

  const rootCursor = new Cursor(rootRaw, '');
  const dialect = rootCursor.take('$schema');
  if (dialect === undefined)
    issues.info('dialectMissing', '/$schema', `assumed ${JSON_SCHEMA_DIALECT}`);
  else if (dialect !== JSON_SCHEMA_DIALECT)
    issues.warn('dialectMismatch', '/$schema', `"${String(dialect)}" read as 2020-12`);

  rootCursor.take('x-canonical');
  if (canonical && !verifyChecksum(rootRaw)) {
    issues.warn(
      'checksumMismatch',
      '/x-canonical/checksum',
      'the document was changed after it was generated',
    );
  }

  const id = rootCursor.take('$id');
  const title = localized(rootCursor, 'title');
  const description = localized(rootCursor, 'description');
  legacyBundle(rootCursor);

  const modelRaw = asRecord(rootCursor.take('x-model'));
  const model =
    modelRaw && typeof modelRaw['code'] === 'string' && typeof modelRaw['version'] === 'string'
      ? { code: modelRaw['code'], version: modelRaw['version'] }
      : undefined;

  const xmlRaw = asRecord(rootRaw['x-xml']);
  let xml: XmlSettings | undefined;
  if (xmlRaw && typeof xmlRaw['rootElement'] === 'string') {
    rootCursor.take('x-xml');
    if (typeof xmlRaw['targetNamespace'] !== 'string') {
      issues.warn('invalidXmlSettings', '/x-xml', 'targetNamespace missing; x-xml dropped');
    } else {
      const wrapper = Array.isArray(xmlRaw['wrapper'])
        ? (xmlRaw['wrapper'] as unknown[]).flatMap((level, index): WrapperLevel[] => {
            const record = asRecord(level);
            if (!record || typeof record['name'] !== 'string') return [];
            return [
              defined({
                name: record['name'],
                typeName: typeof record['typeName'] === 'string' ? record['typeName'] : undefined,
                title: text(
                  record['x-i18n-title'],
                  pointer('/x-xml/wrapper', index, 'x-i18n-title'),
                ),
              }) as unknown as WrapperLevel,
            ];
          })
        : undefined;
      xml = defined({
        rootElement: xmlRaw['rootElement'],
        targetNamespace: xmlRaw['targetNamespace'],
        rootType: typeof xmlRaw['rootType'] === 'string' ? xmlRaw['rootType'] : undefined,
        wrapper: wrapper && wrapper.length > 0 ? wrapper : undefined,
      }) as unknown as XmlSettings;
    }
  }

  const defsRaw = rootCursor.take('$defs') ?? rootCursor.take('definitions');
  if (rootRaw['definitions'] !== undefined) {
    rootCursor.take('definitions');
    issues.warn('legacyDefinitions', '/definitions', 'read as $defs');
  }
  const definitions: Record<string, SchemaNode> = {};
  for (const [name, raw] of Object.entries(asRecord(defsRaw) ?? {})) {
    const record = asRecord(raw);
    const node = record ? nodeOf(new Cursor(record, pointer('/$defs', name))) : undefined;
    if (node) definitions[name] = node;
  }

  const root = nodeOf(rootCursor);
  if (!root) return issues.fail();
  if (root.kind !== 'object' && root.kind !== 'array') {
    issues.error('unsupportedRoot', '/type', 'the root must be an object or an array of objects');
    return issues.fail();
  }

  const doc = defined({
    id: typeof id === 'string' ? id : undefined,
    title,
    description,
    locales,
    defaultLocale: typeof canonical?.['defaultLocale'] === 'string' ? defaultLocale : undefined,
    root,
    definitions: Object.keys(definitions).length > 0 ? definitions : undefined,
    xml,
    model,
  }) as unknown as SchemaDocument;

  if (issues.failed) return issues.fail();
  issues.push(validateDocument(doc).list);
  return issues.result(doc);
};
