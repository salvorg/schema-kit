import type { Issue, Result } from './issues.js';
import { toJsonSchema, type JsonSchema, type JsonSchemaOptions } from './json/emit.js';
import { fromJsonSchema, type FromJsonSchemaOptions } from './json/parse.js';
import type { XmlSettings } from './model/types.js';
import { toXsd } from './xsd/emit.js';
import { fromXsd, type FromXsdOptions } from './xsd/parse.js';

const chain = <A, B>(first: Result<A>, next: (value: A) => Result<B>): Result<B> => {
  if (!first.ok) return first;
  const second = next(first.value);
  const issues: Issue[] = [...first.issues, ...second.issues];
  return second.ok ? { ok: true, value: second.value, issues } : { ok: false, issues };
};

/**
 * JSON Schema → XSD 1.1 through the model. External `$ref`s must be materialized first; XML
 * settings come from `x-xml` or from `options.xml`.
 */
export const jsonSchemaToXsd = (
  schema: unknown,
  options: FromJsonSchemaOptions & { readonly xml?: XmlSettings } = {},
): Result<string> =>
  chain(fromJsonSchema(schema, options), (doc) =>
    toXsd(doc, options.xml ? { xml: options.xml } : {}),
  );

/** XSD → JSON Schema 2020-12 through the model; the XML projection is kept in `x-xml`. */
export const xsdToJsonSchema = (
  xsd: string,
  options: FromXsdOptions & { readonly json?: JsonSchemaOptions } = {},
): Result<JsonSchema> => chain(fromXsd(xsd, options), (doc) => toJsonSchema(doc, options.json));
