export type AnnotationScope = 'document' | 'object' | 'property' | 'node';

export interface AnnotationSpec {
  readonly key: `x-${string}`;
  readonly scope: readonly AnnotationScope[];
  readonly summary: string;
}

/**
 * The approved `x-*` vocabulary. Emitters write only these keys; parsers report every other
 * `x-*` key as `unapprovedAnnotation` and drop it.
 */
export const ANNOTATIONS = [
  {
    key: 'x-canonical',
    scope: ['document'],
    summary: 'Generator, dialect version and checksum of the document.',
  },
  {
    key: 'x-model',
    scope: ['document'],
    summary: 'Canonical model coordinate {code, version} the schema describes.',
  },
  {
    key: 'x-xml',
    scope: ['document', 'node'],
    summary:
      'XML projection: root element, namespace, wrappers; named type and exact built-in on nodes.',
  },
  {
    key: 'x-i18n-title',
    scope: ['document', 'property'],
    summary: 'Localized title {locale: text}.',
  },
  {
    key: 'x-i18n-description',
    scope: ['document', 'property'],
    summary: 'Localized description {locale: text}.',
  },
  {
    key: 'x-i18n-placeholder',
    scope: ['property'],
    summary: 'Localized input placeholder {locale: text}.',
  },
  {
    key: 'x-control',
    scope: ['property'],
    summary:
      'Presentation hint: text, textarea, number, checkbox, date, datetime, time, select, radio, multiselect.',
  },
  {
    key: 'x-options',
    scope: ['node'],
    summary:
      'Inline option labels/images ({kind:"inline"}) or a dictionary service ({kind:"service"}).',
  },
  {
    key: 'x-optionGroups',
    scope: ['node'],
    summary: 'Partition of array item options into groups chosen exclusively.',
  },
  {
    key: 'x-visibleIf',
    scope: ['property'],
    summary: 'Condition (subschema) under which the property is shown.',
  },
  {
    key: 'x-requiredIf',
    scope: ['property'],
    summary: 'Condition (subschema) under which the property is required.',
  },
  {
    key: 'x-transient',
    scope: ['property'],
    summary: 'Asked on the form, stripped from the submitted body.',
  },
  {
    key: 'x-binding',
    scope: ['property'],
    summary: 'Canonical model attribute {model, version, pointer} the property carries.',
  },
  {
    key: 'x-data-class',
    scope: ['property'],
    summary: 'Data classification of the property value.',
  },
  {
    key: 'x-choices',
    scope: ['object'],
    summary: 'Mutually exclusive property groups [{id, required, members}] (xs:choice).',
  },
  {
    key: 'x-derived',
    scope: ['object'],
    summary:
      'Marks allOf as generated from x-visibleIf/x-requiredIf/x-choices; carries its checksum.',
  },
] as const satisfies readonly AnnotationSpec[];

export type AnnotationKey = (typeof ANNOTATIONS)[number]['key'];

const KEYS = new Set<string>(ANNOTATIONS.map((spec) => spec.key));

export const isApprovedAnnotation = (key: string): key is AnnotationKey => KEYS.has(key);

/** Namespace of the XSD appinfo vocabulary mirroring the `x-*` keys. */
export const ANNOTATION_NAMESPACE = 'urn:schema-kit:annotations';

export const DIALECT_VERSION = '1';
export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
