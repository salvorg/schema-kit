export {
  ANNOTATIONS,
  DIALECT_VERSION,
  isApprovedAnnotation,
  JSON_SCHEMA_DIALECT,
  ANNOTATION_NAMESPACE,
} from './annotations.js';
export type { AnnotationKey, AnnotationScope, AnnotationSpec } from './annotations.js';

export { hasErrors, SchemaKitError, unwrap } from './issues.js';
export type { Issue, Result, Severity } from './issues.js';

export {
  all,
  any,
  conditionFromSubschema,
  conditionRefs,
  conditionSchema,
  conditionToSubschema,
  conditionToXPath,
  equals,
  filled,
  notEquals,
  oneOf,
} from './model/condition.js';
export type { Condition, Scalar } from './model/condition.js';

export {
  CONTROLS,
  DEFAULT_LOCALES,
  schemaDocumentSchema,
  STRING_FORMATS,
  XSD_BUILTINS,
} from './model/types.js';
export type {
  ArrayNode,
  Binding,
  BooleanNode,
  Choice,
  Control,
  InlineOption,
  InlineOptions,
  LocalizedText,
  ModelRef,
  NumericNode,
  ObjectNode,
  OptionGroup,
  OptionsSource,
  Property,
  RefNode,
  ScalarNode,
  SchemaDocument,
  SchemaNode,
  ServiceOptions,
  StringFormat,
  StringNode,
  WrapperLevel,
  XmlHint,
  XmlSettings,
  XsdBuiltin,
} from './model/types.js';

export { defineSchema, validateDocument, isSafeImagePath } from './model/validate.js';

export { toJsonSchema, verifyChecksum } from './json/emit.js';
export type { JsonSchema, JsonSchemaOptions } from './json/emit.js';
export { fromJsonSchema } from './json/parse.js';
export type { FromJsonSchemaOptions } from './json/parse.js';

export { toXsd, verifyXsdChecksum } from './xsd/emit.js';
export type { XsdOptions } from './xsd/emit.js';
export { fromXsd } from './xsd/parse.js';
export type { FromXsdOptions } from './xsd/parse.js';
export { ecmaToXsdPattern, xsdToEcmaPattern } from './xsd/regex.js';
export type { DomParserFactory, DomParserLike } from './xml/dom.js';

export { jsonSchemaToXsd, xsdToJsonSchema } from './convert.js';
export { buildSchemas, materialize, materializeJsonSchema } from './build.js';
export type { BuildArtifacts, BuildOptions, MaterializeOptions, RefResolver } from './build.js';

export { canonicalJson, checksumOf } from './util/canonical.js';
export { GENERATOR, PACKAGE_VERSION } from './version.js';
