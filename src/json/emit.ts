import { DIALECT_VERSION, JSON_SCHEMA_DIALECT } from '../annotations.js';
import { Issues, type Result } from '../issues.js';
import { conditionToSubschema } from '../model/condition.js';
import { compactText, pickText } from '../model/localized.js';
import {
  defaultLocaleOf,
  localesOf,
  type ArrayNode,
  type LocalizedText,
  type ObjectNode,
  type OptionsSource,
  type Property,
  type ScalarNode,
  type SchemaDocument,
  type SchemaNode,
  type XmlHint,
} from '../model/types.js';
import { validateDocument } from '../model/validate.js';
import { checksumOf } from '../util/canonical.js';
import { defined, nonEmpty, nonEmptyRecord, type JsonObject } from '../util/object.js';
import { GENERATOR } from '../version.js';

export type JsonSchema = JsonObject;

export interface JsonSchemaOptions {
  /** `additionalProperties: false` on every object. Default `true`. */
  readonly closed?: boolean;
  /** Also write standard `title` / `description` in the default locale. Default `true`. */
  readonly plainText?: boolean;
}

interface Context {
  readonly closed: boolean;
  readonly plainText: boolean;
  readonly locale: string;
  readonly locales: readonly string[];
}

const xmlHint = (hint: XmlHint | undefined): JsonObject | undefined =>
  hint && (hint.type !== undefined || hint.base !== undefined) ? defined({ ...hint }) : undefined;

const optionsKey = (options: OptionsSource | undefined): JsonObject | undefined => {
  if (!options) return undefined;
  if (options.kind === 'service') {
    return defined({
      kind: 'service',
      serviceId: options.serviceId,
      itemsPointer: options.itemsPointer,
      valuePointer: options.valuePointer,
      labelPointer: options.labelPointer,
      fill: nonEmptyRecord(options.fill),
      params: nonEmptyRecord(options.params),
      filterBy: options.filterBy,
    });
  }
  const decorated = options.options.some(
    (option) => compactText(option.label) !== undefined || option.image !== undefined,
  );
  if (!decorated) return undefined;
  return {
    kind: 'inline',
    options: options.options.map((option) =>
      defined({
        value: option.value,
        'x-i18n-label': compactText(option.label),
        image: option.image,
      }),
    ),
  };
};

const scalarSchema = (node: ScalarNode): JsonObject => {
  const inline =
    node.options?.kind === 'inline'
      ? node.options.options.map((option) => option.value)
      : undefined;
  const common = {
    enum: inline,
    const: node.const,
    default: node.default,
    'x-options': optionsKey(node.options),
    'x-xml': xmlHint(node.xml),
  };
  switch (node.kind) {
    case 'string':
      return defined({
        type: 'string',
        format: node.format,
        minLength: node.minLength,
        maxLength: node.maxLength,
        pattern: node.pattern,
        ...common,
      });
    case 'integer':
    case 'number':
      return defined({
        type: node.kind,
        minimum: node.minimum,
        maximum: node.maximum,
        exclusiveMinimum: node.exclusiveMinimum,
        exclusiveMaximum: node.exclusiveMaximum,
        ...common,
      });
    case 'boolean':
      return defined({ type: 'boolean', ...common });
  }
};

const arraySchema = (node: ArrayNode, ctx: Context): JsonObject => {
  const groups = nonEmpty(node.optionGroups);
  return defined({
    type: 'array',
    items: nodeSchema(node.items, ctx),
    minItems: node.minItems,
    maxItems: node.maxItems,
    uniqueItems: node.uniqueItems,
    anyOf: groups?.map((group) =>
      defined({
        items: { enum: [...group.values] },
        maxItems: group.select === 'one' ? 1 : undefined,
      }),
    ),
    'x-optionGroups': groups,
  });
};

const derivedRules = (node: ObjectNode): { rules: JsonObject[]; from: string[] } => {
  const rules: JsonObject[] = [];
  const from = new Set<string>();
  for (const property of node.properties) {
    const visible = property.visibleIf ? conditionToSubschema(property.visibleIf) : undefined;
    if (visible) {
      from.add('x-visibleIf');
      rules.push({ if: { not: visible }, then: { not: { required: [property.name] } } });
      if (property.required) rules.push({ if: visible, then: { required: [property.name] } });
    }
    if (property.requiredIf) {
      from.add('x-requiredIf');
      const when = conditionToSubschema(property.requiredIf);
      rules.push({
        if: visible ? { allOf: [visible, when] } : when,
        then: { required: [property.name] },
      });
    }
  }
  for (const choice of node.choices ?? []) {
    from.add('x-choices');
    if (choice.required) {
      rules.push({ oneOf: choice.members.map((member) => ({ required: [member] })) });
    } else {
      const pairs = choice.members.flatMap((left, index) =>
        choice.members.slice(index + 1).map((right) => ({ required: [left, right] })),
      );
      rules.push({ not: { anyOf: pairs } });
    }
  }
  return { rules, from: [...from] };
};

const objectSchema = (node: ObjectNode, ctx: Context): JsonObject => {
  const required = node.properties
    .filter((property) => property.required && !property.visibleIf)
    .map((property) => property.name);
  const { rules, from } = derivedRules(node);
  return defined({
    type: 'object',
    properties: Object.fromEntries(
      node.properties.map((property) => [property.name, propertySchema(property, ctx)]),
    ),
    required: nonEmpty(required),
    additionalProperties: ctx.closed ? false : undefined,
    'x-choices': nonEmpty(node.choices)?.map((choice) =>
      defined({
        id: choice.id,
        required: choice.required ? true : undefined,
        members: [...choice.members],
      }),
    ),
    'x-xml': node.xml?.type !== undefined ? { type: node.xml.type } : undefined,
    allOf: nonEmpty(rules),
    'x-derived': rules.length > 0 ? { from, checksum: checksumOf(rules) } : undefined,
  });
};

const nodeSchema = (node: SchemaNode, ctx: Context): JsonObject => {
  switch (node.kind) {
    case 'string':
    case 'integer':
    case 'number':
    case 'boolean':
      return scalarSchema(node);
    case 'array':
      return arraySchema(node, ctx);
    case 'object':
      return objectSchema(node, ctx);
    case 'ref':
      return { $ref: node.ref };
  }
};

const plain = (text: LocalizedText | undefined, ctx: Context): string | undefined =>
  ctx.plainText ? pickText(text, ctx.locale, ctx.locales) : undefined;

const propertySchema = (property: Property, ctx: Context): JsonObject => {
  const { type, $ref, ...constraints } = nodeSchema(property.node, ctx);
  const visible = property.visibleIf ? conditionToSubschema(property.visibleIf) : undefined;
  const requiredWhen = property.requiredIf
    ? conditionToSubschema(property.requiredIf)
    : property.required && visible
      ? visible
      : undefined;
  return defined({
    $ref,
    title: plain(property.title, ctx),
    description: plain(property.description, ctx),
    type,
    ...constraints,
    'x-i18n-title': compactText(property.title),
    'x-i18n-description': compactText(property.description),
    'x-i18n-placeholder': compactText(property.placeholder),
    'x-control': property.control,
    'x-visibleIf': visible,
    'x-requiredIf': requiredWhen,
    'x-transient': property.transient ? true : undefined,
    'x-binding': property.binding,
    'x-data-class': property.dataClass,
  });
};

/**
 * Canonical JSON Schema 2020-12 of a model. Local definitions stay as `$defs`/`$ref`; use
 * {@link materialize} first for a self-contained document.
 */
export const toJsonSchema = (
  doc: SchemaDocument,
  options: JsonSchemaOptions = {},
): Result<JsonSchema> => {
  const issues = validateDocument(doc);
  if (issues.failed) return issues.fail();

  const ctx: Context = {
    closed: options.closed ?? true,
    plainText: options.plainText ?? true,
    locale: defaultLocaleOf(doc),
    locales: localesOf(doc),
  };

  const definitions = Object.entries(doc.definitions ?? {});
  const xml = doc.xml
    ? defined({
        rootElement: doc.xml.rootElement,
        targetNamespace: doc.xml.targetNamespace,
        rootType: doc.xml.rootType,
        wrapper: nonEmpty(doc.xml.wrapper)?.map((level) =>
          defined({
            name: level.name,
            typeName: level.typeName,
            'x-i18n-title': compactText(level.title),
          }),
        ),
      })
    : undefined;

  const body = defined({
    $schema: JSON_SCHEMA_DIALECT,
    $id: doc.id,
    title: plain(doc.title, ctx),
    description: plain(doc.description, ctx),
    'x-i18n-title': compactText(doc.title),
    'x-i18n-description': compactText(doc.description),
    'x-model': doc.model,
    'x-xml': xml,
    ...nodeSchema(doc.root, ctx),
    $defs:
      definitions.length > 0
        ? Object.fromEntries(definitions.map(([name, node]) => [name, nodeSchema(node, ctx)]))
        : undefined,
  });

  const schema: JsonSchema = {
    ...body,
    'x-canonical': {
      dialect: DIALECT_VERSION,
      generator: GENERATOR,
      locales: [...ctx.locales],
      defaultLocale: ctx.locale,
      checksum: checksumOf(body),
    },
  };
  return new Issues().result(schema);
};

/** Recomputes the checksum of a canonical document and compares it with `x-canonical.checksum`. */
export const verifyChecksum = (schema: JsonSchema): boolean => {
  const { 'x-canonical': canonical, ...body } = schema;
  const recorded = (canonical as JsonObject | undefined)?.['checksum'];
  return typeof recorded === 'string' && recorded === checksumOf(body);
};
