import { Issues, pointer, type Issue, type Result } from './issues.js';
import { toJsonSchema, type JsonSchema, type JsonSchemaOptions } from './json/emit.js';
import { fromJsonSchema, type FromJsonSchemaOptions } from './json/parse.js';
import {
  localRefName,
  type ObjectNode,
  type Property,
  type SchemaDocument,
  type SchemaNode,
  type XmlSettings,
} from './model/types.js';
import { defineSchema, validateDocument } from './model/validate.js';
import { checksumOf } from './util/canonical.js';
import { toXsd } from './xsd/emit.js';

/**
 * Supplies an external `$ref` target: a whole document (its root is used, or the `#/$defs/<name>`
 * fragment of the ref) or a single node. `undefined` means the reference is unknown.
 */
export type RefResolver = (
  ref: string,
) => SchemaDocument | SchemaNode | undefined | Promise<SchemaDocument | SchemaNode | undefined>;

export interface MaterializeOptions {
  readonly resolve?: RefResolver;
}

const isDocument = (value: SchemaDocument | SchemaNode): value is SchemaDocument =>
  'root' in value && !('kind' in value);

const splitRef = (ref: string): { base: string; fragment?: string } => {
  const hash = ref.indexOf('#');
  return hash < 0 ? { base: ref } : { base: ref.slice(0, hash), fragment: ref.slice(hash) };
};

/**
 * Resolves every `$ref` (local definitions and external models) into inline nodes. The result has
 * no `definitions`, and definition names survive as `xml.type` hints so XSD keeps its type names.
 */
export const materialize = async (
  doc: SchemaDocument,
  options: MaterializeOptions = {},
): Promise<Result<SchemaDocument>> => {
  const issues = validateDocument(doc);
  if (issues.failed) return issues.fail();

  const external = new Map<string, SchemaDocument | SchemaNode | undefined>();

  const fetchExternal = async (base: string): Promise<SchemaDocument | SchemaNode | undefined> => {
    if (!external.has(base))
      external.set(base, options.resolve ? await options.resolve(base) : undefined);
    return external.get(base);
  };

  const withHint = (node: SchemaNode, name: string): SchemaNode => {
    if (node.kind === 'object')
      return node.xml?.type ? node : { ...node, xml: { ...node.xml, type: name } };
    if (
      node.kind === 'string' ||
      node.kind === 'integer' ||
      node.kind === 'number' ||
      node.kind === 'boolean'
    ) {
      return node.xml?.type ? node : { ...node, xml: { ...node.xml, type: name } };
    }
    return node;
  };

  const resolveRef = async (
    ref: string,
    scope: SchemaDocument,
    stack: readonly string[],
    path: string,
  ): Promise<SchemaNode | undefined> => {
    const localName = localRefName(ref);
    const key = localName !== undefined ? `${scope.id ?? ''}${ref}` : ref;
    if (stack.includes(key)) {
      issues.error('recursiveReference', path, `reference cycle: ${[...stack, key].join(' → ')}`);
      return undefined;
    }
    if (localName !== undefined) {
      const target = scope.definitions?.[localName];
      if (!target) {
        issues.error('danglingRef', path, `definition "${localName}" does not exist`);
        return undefined;
      }
      const resolved = await walkNode(target, scope, [...stack, key], path);
      return resolved && withHint(resolved, localName);
    }

    const { base, fragment } = splitRef(ref);
    const loaded = await fetchExternal(base);
    if (!loaded) {
      issues.error(
        'unresolvedRef',
        path,
        `"${ref}" could not be resolved${options.resolve ? '' : '; pass options.resolve'}`,
      );
      return undefined;
    }
    if (!isDocument(loaded)) {
      if (fragment)
        issues.warn(
          'fragmentIgnored',
          path,
          `resolver returned a node; fragment "${fragment}" ignored`,
        );
      return walkNode(loaded, scope, [...stack, key], path);
    }
    const externalIssues = validateDocument(loaded);
    if (externalIssues.failed) {
      issues.push(externalIssues.list.map((issue) => ({ ...issue, path: `${ref}${issue.path}` })));
      return undefined;
    }
    if (fragment === undefined || fragment === '#' || fragment === '') {
      return walkNode(loaded.root, loaded, [...stack, key], path);
    }
    const name = localRefName(fragment);
    if (name === undefined) {
      issues.error('unsupportedFragment', path, `fragment "${fragment}" is not #/$defs/<name>`);
      return undefined;
    }
    return resolveRef(fragment, loaded, [...stack, key], path);
  };

  const walkProperties = async (
    node: ObjectNode,
    scope: SchemaDocument,
    stack: readonly string[],
    path: string,
  ): Promise<ObjectNode> => {
    const properties: Property[] = [];
    for (const [index, property] of node.properties.entries()) {
      const resolved = await walkNode(
        property.node,
        scope,
        stack,
        pointer(path, 'properties', index, 'node'),
      );
      if (resolved) properties.push({ ...property, node: resolved });
    }
    return { ...node, properties };
  };

  const walkNode = async (
    node: SchemaNode,
    scope: SchemaDocument,
    stack: readonly string[],
    path: string,
  ): Promise<SchemaNode | undefined> => {
    switch (node.kind) {
      case 'ref':
        return resolveRef(node.ref, scope, stack, path);
      case 'object':
        return walkProperties(node, scope, stack, path);
      case 'array': {
        const items = await walkNode(node.items, scope, stack, pointer(path, 'items'));
        return items ? { ...node, items } : undefined;
      }
      default:
        return node;
    }
  };

  const root = await walkNode(doc.root, doc, [], '/root');
  if (!root || issues.failed) return issues.fail();
  if (root.kind !== 'object' && root.kind !== 'array') {
    issues.error('unsupportedRoot', '/root', 'the root resolved to a scalar');
    return issues.fail();
  }
  const { definitions: _definitions, ...rest } = doc;
  const materialized: SchemaDocument = { ...rest, root };
  issues.push(validateDocument(materialized).list.filter((issue) => issue.severity === 'error'));
  return issues.result(materialized);
};

export interface BuildOptions extends MaterializeOptions {
  readonly json?: JsonSchemaOptions;
  /** XML settings when the model has none; without either, only JSON Schema is built. */
  readonly xml?: XmlSettings;
}

export interface BuildArtifacts {
  /** Self-contained model: validated, every reference inlined. */
  readonly document: SchemaDocument;
  readonly jsonSchema: JsonSchema;
  /** `undefined` when no XML settings are known. */
  readonly xsd?: string;
  /** Checksum of the materialized model, identical for both projections. */
  readonly checksum: string;
}

/**
 * The materialized build: validates constructor input, resolves references and emits both
 * canonical projections from the same model.
 */
export const buildSchemas = async (
  input: unknown,
  options: BuildOptions = {},
): Promise<Result<BuildArtifacts>> => {
  const issues = new Issues();
  const defined = defineSchema(input);
  issues.push(defined.issues);
  if (!defined.ok) return issues.fail();

  const materialized = await materialize(defined.value, options);
  issues.push(materialized.issues.filter((issue) => !defined.issues.includes(issue)));
  if (!materialized.ok) return issues.fail();
  const document = materialized.value;

  const json = toJsonSchema(document, options.json);
  if (!json.ok) {
    issues.push(json.issues);
    return issues.fail();
  }

  let xsd: string | undefined;
  if (options.xml ?? document.xml) {
    const xml = toXsd(document, options.xml ? { xml: options.xml } : {});
    if (!xml.ok) {
      issues.push(xml.issues);
      return issues.fail();
    }
    xsd = xml.value;
  }
  return issues.result({ document, jsonSchema: json.value, xsd, checksum: checksumOf(document) });
};

/** JSON Schema in, self-contained canonical JSON Schema out. */
export const materializeJsonSchema = async (
  schema: unknown,
  options: MaterializeOptions & {
    readonly parse?: FromJsonSchemaOptions;
    readonly json?: JsonSchemaOptions;
  } = {},
): Promise<Result<JsonSchema>> => {
  const collected: Issue[] = [];
  const parsed = fromJsonSchema(schema, options.parse);
  collected.push(...parsed.issues);
  if (!parsed.ok) return { ok: false, issues: collected };
  const materialized = await materialize(parsed.value, options);
  collected.push(...materialized.issues.filter((issue) => !parsed.issues.includes(issue)));
  if (!materialized.ok) return { ok: false, issues: collected };
  const json = toJsonSchema(materialized.value, options.json);
  collected.push(...json.issues);
  return json.ok
    ? { ok: true, value: json.value, issues: collected }
    : { ok: false, issues: collected };
};
