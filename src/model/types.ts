import { z } from 'zod';
import {
  conditionSchema,
  nameSchema,
  scalarSchema,
  type Condition,
  type Scalar,
} from './condition.js';

export type LocalizedText = Readonly<Record<string, string>>;

export const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;
export const DEFAULT_LOCALES = ['ru', 'ky', 'en'] as const;

export const localizedTextSchema = z.record(z.string().regex(LOCALE_PATTERN), z.string());

export const STRING_FORMATS = ['date', 'date-time', 'time', 'email', 'uri', 'uuid', 'tel'] as const;
export type StringFormat = (typeof STRING_FORMATS)[number];

export const CONTROLS = [
  'text',
  'textarea',
  'number',
  'checkbox',
  'date',
  'datetime',
  'time',
  'select',
  'radio',
  'multiselect',
] as const;
export type Control = (typeof CONTROLS)[number];

export const XSD_BUILTINS = [
  'string',
  'normalizedString',
  'token',
  'anyURI',
  'boolean',
  'date',
  'dateTime',
  'time',
  'decimal',
  'double',
  'float',
  'integer',
  'long',
  'int',
  'short',
  'byte',
  'nonNegativeInteger',
  'positiveInteger',
  'nonPositiveInteger',
  'negativeInteger',
  'unsignedLong',
  'unsignedInt',
  'unsignedShort',
  'unsignedByte',
] as const;
export type XsdBuiltin = (typeof XSD_BUILTINS)[number];

/** XML-side hints that let a model round-trip through XSD without renaming its types. */
export interface XmlHint {
  /** Name of the named `xs:simpleType` / `xs:complexType` that carries this node. */
  readonly type?: string;
  /** Exact XSD built-in to use where the kind alone would pick a wider one (`int` vs `integer`). */
  readonly base?: XsdBuiltin;
}

export interface InlineOption {
  readonly value: Scalar;
  readonly label?: LocalizedText;
  /** Same-origin absolute path to a picture shown with the option. */
  readonly image?: string;
}

export interface InlineOptions {
  readonly kind: 'inline';
  readonly options: readonly InlineOption[];
}

/** Values come from another registry service at run time; the schema carries no `enum`. */
export interface ServiceOptions {
  readonly kind: 'service';
  readonly serviceId: string;
  readonly itemsPointer?: string;
  readonly valuePointer: string;
  readonly labelPointer: string;
  /** Sibling property → pointer in the chosen record whose value is copied into it. */
  readonly fill?: Readonly<Record<string, string>>;
  /** Request body key → sibling property whose value is sent. */
  readonly params?: Readonly<Record<string, string>>;
  readonly filterBy?: { readonly field: string; readonly pointer: string };
}

export type OptionsSource = InlineOptions | ServiceOptions;

export interface OptionGroup {
  readonly values: readonly Scalar[];
  readonly select: 'one' | 'many';
}

interface ScalarBase<V> {
  readonly options?: OptionsSource;
  readonly const?: V;
  readonly default?: V;
  readonly xml?: XmlHint;
}

export interface StringNode extends ScalarBase<string> {
  readonly kind: 'string';
  readonly format?: StringFormat;
  readonly minLength?: number;
  readonly maxLength?: number;
  /** ECMA-262 regular expression, as JSON Schema defines `pattern` (unanchored). */
  readonly pattern?: string;
}

export interface NumericNode extends ScalarBase<number> {
  readonly kind: 'integer' | 'number';
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
}

export interface BooleanNode extends ScalarBase<boolean> {
  readonly kind: 'boolean';
}

export interface ArrayNode {
  readonly kind: 'array';
  readonly items: SchemaNode;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  /** Partition of the item options into groups chosen from exclusively. */
  readonly optionGroups?: readonly OptionGroup[];
}

/** At most one member present; with `required`, exactly one. Members are sibling properties. */
export interface Choice {
  readonly id: string;
  readonly required?: boolean;
  readonly members: readonly string[];
}

export interface ObjectNode {
  readonly kind: 'object';
  readonly properties: readonly Property[];
  readonly choices?: readonly Choice[];
  readonly xml?: Pick<XmlHint, 'type'>;
}

/** `#/$defs/<name>` for a definition of this document, or any other URI for an external model. */
export interface RefNode {
  readonly kind: 'ref';
  readonly ref: string;
}

export type ScalarNode = StringNode | NumericNode | BooleanNode;
export type SchemaNode = ScalarNode | ArrayNode | ObjectNode | RefNode;

/** Canonical-model attribute this property carries, addressed by model coordinate and pointer. */
export interface Binding {
  readonly model: string;
  readonly version: string;
  readonly pointer: string;
}

export interface Property {
  readonly name: string;
  readonly node: SchemaNode;
  /** Unconditionally required; with `visibleIf`, required whenever visible. */
  readonly required?: boolean;
  readonly title?: LocalizedText;
  readonly description?: LocalizedText;
  readonly placeholder?: LocalizedText;
  readonly control?: Control;
  readonly visibleIf?: Condition;
  /** Required only while the condition holds. Mutually exclusive with `required`. */
  readonly requiredIf?: Condition;
  /** Asked on the form, kept out of the submitted body. */
  readonly transient?: boolean;
  readonly binding?: Binding;
  readonly dataClass?: string;
}

export interface WrapperLevel {
  readonly name: string;
  readonly typeName?: string;
  readonly title?: LocalizedText;
}

export interface XmlSettings {
  readonly rootElement: string;
  readonly targetNamespace: string;
  /** Envelope elements between the root element and the body, outermost first. */
  readonly wrapper?: readonly WrapperLevel[];
  readonly rootType?: string;
}

export interface ModelRef {
  readonly code: string;
  readonly version: string;
}

export interface SchemaDocument {
  /** `$id` of the JSON Schema. */
  readonly id?: string;
  readonly title?: LocalizedText;
  readonly description?: LocalizedText;
  /** Defaults to `ru`, `ky`, `en`. */
  readonly locales?: readonly string[];
  /** Defaults to the first locale. */
  readonly defaultLocale?: string;
  /** An object, or an array of objects for a list body. */
  readonly root: ObjectNode | ArrayNode;
  readonly definitions?: Readonly<Record<string, SchemaNode>>;
  readonly xml?: XmlSettings;
  readonly model?: ModelRef;
}

const nonNegative = z.number().int().nonnegative();
const finite = z.number().finite();

export const xmlHintSchema = z.strictObject({
  type: nameSchema.optional(),
  base: z.enum(XSD_BUILTINS).optional(),
});

export const optionsSourceSchema: z.ZodType<OptionsSource> = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('inline'),
    options: z
      .array(
        z.strictObject({
          value: scalarSchema,
          label: localizedTextSchema.optional(),
          image: z.string().optional(),
        }),
      )
      .min(1),
  }),
  z.strictObject({
    kind: z.literal('service'),
    serviceId: z.string().min(1),
    itemsPointer: z.string().optional(),
    valuePointer: z.string(),
    labelPointer: z.string(),
    fill: z.record(nameSchema, z.string()).optional(),
    params: z.record(z.string(), nameSchema).optional(),
    filterBy: z.strictObject({ field: nameSchema, pointer: z.string() }).optional(),
  }),
]);

const scalarBase = {
  options: optionsSourceSchema.optional(),
  xml: xmlHintSchema.optional(),
};

const objectNodeShape = () =>
  z.strictObject({
    kind: z.literal('object'),
    properties: z.array(propertySchema),
    choices: z
      .array(
        z.strictObject({
          id: nameSchema,
          required: z.boolean().optional(),
          members: z.array(nameSchema).min(2),
        }),
      )
      .optional(),
    xml: z.strictObject({ type: nameSchema.optional() }).optional(),
  });

export const schemaNodeSchema = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('string'),
      ...scalarBase,
      const: z.string().optional(),
      default: z.string().optional(),
      format: z.enum(STRING_FORMATS).optional(),
      minLength: nonNegative.optional(),
      maxLength: nonNegative.optional(),
      pattern: z.string().optional(),
    }),
    z.strictObject({
      kind: z.enum(['integer', 'number']),
      ...scalarBase,
      const: finite.optional(),
      default: finite.optional(),
      minimum: finite.optional(),
      maximum: finite.optional(),
      exclusiveMinimum: finite.optional(),
      exclusiveMaximum: finite.optional(),
    }),
    z.strictObject({
      kind: z.literal('boolean'),
      ...scalarBase,
      const: z.boolean().optional(),
      default: z.boolean().optional(),
    }),
    z.strictObject({
      kind: z.literal('array'),
      items: schemaNodeSchema,
      minItems: nonNegative.optional(),
      maxItems: nonNegative.optional(),
      uniqueItems: z.boolean().optional(),
      optionGroups: z
        .array(
          z.strictObject({
            values: z.array(scalarSchema).min(1),
            select: z.enum(['one', 'many']),
          }),
        )
        .optional(),
    }),
    objectNodeShape(),
    z.strictObject({ kind: z.literal('ref'), ref: z.string().min(1) }),
  ]),
) as unknown as z.ZodType<SchemaNode>;

export const propertySchema: z.ZodType<Property> = z.lazy(() =>
  z.strictObject({
    name: nameSchema,
    node: schemaNodeSchema,
    required: z.boolean().optional(),
    title: localizedTextSchema.optional(),
    description: localizedTextSchema.optional(),
    placeholder: localizedTextSchema.optional(),
    control: z.enum(CONTROLS).optional(),
    visibleIf: conditionSchema.optional(),
    requiredIf: conditionSchema.optional(),
    transient: z.boolean().optional(),
    binding: z
      .strictObject({ model: z.string().min(1), version: z.string().min(1), pointer: z.string() })
      .optional(),
    dataClass: z.string().min(1).optional(),
  }),
);

export const objectNodeSchema = z.lazy(objectNodeShape) as unknown as z.ZodType<ObjectNode>;

export const schemaDocumentSchema: z.ZodType<SchemaDocument> = z.strictObject({
  id: z.string().min(1).optional(),
  title: localizedTextSchema.optional(),
  description: localizedTextSchema.optional(),
  locales: z.array(z.string().regex(LOCALE_PATTERN)).min(1).optional(),
  defaultLocale: z.string().regex(LOCALE_PATTERN).optional(),
  root: schemaNodeSchema.refine((node) => node.kind === 'object' || node.kind === 'array', {
    message: 'the root must be an object or an array of objects',
  }) as unknown as z.ZodType<ObjectNode | ArrayNode>,
  definitions: z.record(nameSchema, schemaNodeSchema).optional(),
  xml: z
    .strictObject({
      rootElement: nameSchema,
      targetNamespace: z.string().min(1),
      wrapper: z
        .array(
          z.strictObject({
            name: nameSchema,
            typeName: nameSchema.optional(),
            title: localizedTextSchema.optional(),
          }),
        )
        .optional(),
      rootType: nameSchema.optional(),
    })
    .optional(),
  model: z.strictObject({ code: z.string().min(1), version: z.string().min(1) }).optional(),
});

export const localesOf = (doc: SchemaDocument): readonly string[] =>
  doc.locales && doc.locales.length > 0 ? doc.locales : DEFAULT_LOCALES;

export const defaultLocaleOf = (doc: SchemaDocument): string =>
  doc.defaultLocale ?? localesOf(doc)[0]!;

export const isScalarNode = (node: SchemaNode): node is ScalarNode =>
  node.kind === 'string' ||
  node.kind === 'integer' ||
  node.kind === 'number' ||
  node.kind === 'boolean';

export const LOCAL_REF_PREFIX = '#/$defs/';

export const localRefName = (ref: string): string | undefined =>
  ref.startsWith(LOCAL_REF_PREFIX) ? ref.slice(LOCAL_REF_PREFIX.length) : undefined;
