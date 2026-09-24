import { Issues, pointer, type Result } from '../issues.js';
import { canonicalJson } from '../util/canonical.js';
import {
  conditionRefs,
  conditionValues,
  scalarKind,
  type Condition,
  type ConditionValueKind,
  type Scalar,
} from './condition.js';
import {
  defaultLocaleOf,
  isScalarNode,
  localesOf,
  localRefName,
  schemaDocumentSchema,
  type ObjectNode,
  type Property,
  type SchemaDocument,
  type SchemaNode,
} from './types.js';

export const isSafeImagePath = (value: string): boolean =>
  /^\/[A-Za-z0-9._~\-/]*$/.test(value) && !value.startsWith('//') && !value.includes('..');

const kindOfValue = (node: SchemaNode): ConditionValueKind | 'array' | 'object' | 'ref' => {
  switch (node.kind) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return node.kind;
  }
};

const valueFits = (node: SchemaNode, value: Scalar): boolean => {
  const kind = kindOfValue(node);
  if (kind !== scalarKind(value)) return false;
  return node.kind !== 'integer' || Number.isInteger(value);
};

const compiles = (pattern: string): boolean => {
  try {
    new RegExp(pattern, 'u');
    return true;
  } catch {
    return false;
  }
};

/**
 * Structural (zod) and semantic checks of a model. Everything an emitter relies on is enforced
 * here, so emitters never have to guess.
 */
export const validateDocument = (doc: SchemaDocument): Issues => {
  const issues = new Issues();
  const locales = localesOf(doc);
  const defaultLocale = defaultLocaleOf(doc);
  if (!locales.includes(defaultLocale)) {
    issues.error(
      'defaultLocaleUndeclared',
      '/defaultLocale',
      `"${defaultLocale}" is not in locales`,
    );
  }

  const definitions = doc.definitions ?? {};

  const checkNode = (node: SchemaNode, path: string): void => {
    switch (node.kind) {
      case 'string':
      case 'integer':
      case 'number':
      case 'boolean':
        checkScalar(node, path);
        return;
      case 'array':
        if (node.items.kind === 'array') {
          issues.warn('nestedArray', pointer(path, 'items'), 'array of arrays has no XSD form');
        }
        if (
          node.minItems !== undefined &&
          node.maxItems !== undefined &&
          node.minItems > node.maxItems
        ) {
          issues.error('rangeInverted', path, 'minItems is greater than maxItems');
        }
        checkNode(node.items, pointer(path, 'items'));
        if (node.optionGroups) checkGroups(node, path);
        return;
      case 'object':
        checkObject(node, path);
        return;
      case 'ref': {
        const name = localRefName(node.ref);
        if (name !== undefined && !(name in definitions)) {
          issues.error('danglingRef', path, `definition "${name}" does not exist`);
        }
        return;
      }
    }
  };

  const checkScalar = (
    node: Extract<SchemaNode, { kind: 'string' | 'integer' | 'number' | 'boolean' }>,
    path: string,
  ): void => {
    if (node.const !== undefined && !valueFits(node, node.const)) {
      issues.error('valueTypeMismatch', pointer(path, 'const'), `const does not fit ${node.kind}`);
    }
    if (node.default !== undefined && !valueFits(node, node.default)) {
      issues.error(
        'valueTypeMismatch',
        pointer(path, 'default'),
        `default does not fit ${node.kind}`,
      );
    }
    if (node.kind === 'string') {
      if (node.pattern !== undefined && !compiles(node.pattern)) {
        issues.error('invalidPattern', pointer(path, 'pattern'), 'not a valid ECMA-262 (u) regex');
      }
      if (
        node.minLength !== undefined &&
        node.maxLength !== undefined &&
        node.minLength > node.maxLength
      ) {
        issues.error('rangeInverted', path, 'minLength is greater than maxLength');
      }
    }
    if (node.kind === 'integer' || node.kind === 'number') {
      const low = node.minimum ?? node.exclusiveMinimum;
      const high = node.maximum ?? node.exclusiveMaximum;
      if (low !== undefined && high !== undefined && low > high) {
        issues.error('rangeInverted', path, 'lower bound is greater than upper bound');
      }
    }
    const options = node.options;
    if (!options) return;
    if (options.kind === 'service') {
      if (node.kind !== 'string' && node.kind !== 'integer' && node.kind !== 'number') {
        issues.error(
          'serviceOptionsType',
          pointer(path, 'options'),
          'dictionary values must be strings or numbers',
        );
      }
      return;
    }
    const seen = new Set<string>();
    options.options.forEach((option, index) => {
      const at = pointer(path, 'options', 'options', index);
      if (!valueFits(node, option.value)) {
        issues.error(
          'valueTypeMismatch',
          pointer(at, 'value'),
          `option value does not fit ${node.kind}`,
        );
      }
      const key = canonicalJson(option.value);
      if (seen.has(key))
        issues.error('duplicateOption', pointer(at, 'value'), `duplicate value ${key}`);
      seen.add(key);
      if (option.image !== undefined && !isSafeImagePath(option.image)) {
        issues.error(
          'unsafeImagePath',
          pointer(at, 'image'),
          'image must be a same-origin absolute path',
        );
      }
    });
  };

  const checkGroups = (node: Extract<SchemaNode, { kind: 'array' }>, path: string): void => {
    const at = pointer(path, 'optionGroups');
    const items = node.items;
    if (!isScalarNode(items) || items.options?.kind !== 'inline') {
      issues.error('optionGroupsWithoutOptions', at, 'option groups need inline options on items');
      return;
    }
    const all = items.options.options.map((option) => canonicalJson(option.value));
    const grouped = node.optionGroups!.flatMap((group) =>
      group.values.map((value) => canonicalJson(value)),
    );
    const sameSet =
      grouped.length === all.length &&
      new Set(grouped).size === grouped.length &&
      grouped.every((value) => all.includes(value));
    if (!sameSet)
      issues.error('optionGroupsNotPartition', at, 'groups must partition the options exactly');
  };

  const checkCondition = (
    condition: Condition,
    siblings: ReadonlyMap<string, Property>,
    self: string,
    path: string,
  ): void => {
    for (const ref of conditionRefs(condition)) {
      const target = siblings.get(ref);
      if (!target) {
        issues.error('danglingConditionRef', path, `"${ref}" is not a sibling property`);
        continue;
      }
      if (ref === self)
        issues.error('selfCondition', path, 'a condition may not read its own property');
      const kind = kindOfValue(target.node);
      if (kind === 'object' || kind === 'array' || kind === 'ref') {
        const onlyFilled = conditionValues(condition).every((entry) => entry.ref !== ref);
        if (!onlyFilled) {
          issues.error(
            'conditionOnComposite',
            path,
            `"${ref}" is ${kind}; only "filled" may test it`,
          );
        }
      }
    }
    for (const { ref, value } of conditionValues(condition)) {
      const target = siblings.get(ref);
      if (target && isScalarNode(target.node) && !valueFits(target.node, value)) {
        issues.error(
          'conditionValueType',
          path,
          `value ${JSON.stringify(value)} does not fit "${ref}" (${target.node.kind})`,
        );
      }
    }
  };

  const checkObject = (node: ObjectNode, path: string): void => {
    const siblings = new Map<string, Property>();
    node.properties.forEach((property, index) => {
      if (siblings.has(property.name)) {
        issues.error(
          'duplicateName',
          pointer(path, 'properties', index, 'name'),
          `"${property.name}" is declared twice`,
        );
      }
      siblings.set(property.name, property);
    });

    node.properties.forEach((property, index) => {
      const at = pointer(path, 'properties', index);
      if (property.required && property.requiredIf) {
        issues.error(
          'requiredAndRequiredIf',
          at,
          'use required (with visibleIf) or requiredIf, not both',
        );
      }
      if (property.visibleIf)
        checkCondition(property.visibleIf, siblings, property.name, pointer(at, 'visibleIf'));
      if (property.requiredIf)
        checkCondition(property.requiredIf, siblings, property.name, pointer(at, 'requiredIf'));
      if (property.title && property.title[defaultLocale] === undefined) {
        issues.warn('missingDefaultTitle', pointer(at, 'title'), `no "${defaultLocale}" title`);
      }
      const options = isScalarNode(property.node)
        ? property.node.options
        : property.node.kind === 'array' && isScalarNode(property.node.items)
          ? property.node.items.options
          : undefined;
      if (options?.kind === 'service') {
        for (const target of Object.keys(options.fill ?? {})) {
          if (!siblings.has(target))
            issues.error(
              'danglingFill',
              pointer(at, 'node', 'options', 'fill', target),
              `"${target}" is not a sibling`,
            );
        }
        for (const [key, source] of Object.entries(options.params ?? {})) {
          if (!siblings.has(source))
            issues.error(
              'danglingParam',
              pointer(at, 'node', 'options', 'params', key),
              `"${source}" is not a sibling`,
            );
        }
        if (options.filterBy && !siblings.has(options.filterBy.field)) {
          issues.error(
            'danglingFilter',
            pointer(at, 'node', 'options', 'filterBy'),
            `"${options.filterBy.field}" is not a sibling`,
          );
        }
      }
      checkNode(property.node, pointer(at, 'node'));
    });

    const visibilityCycle = findCycle(node.properties);
    if (visibilityCycle) {
      issues.error(
        'conditionCycle',
        path,
        `visibility depends on itself: ${visibilityCycle.join(' → ')}`,
      );
    }

    const inChoice = new Map<string, string>();
    node.choices?.forEach((choice, index) => {
      const at = pointer(path, 'choices', index);
      for (const member of choice.members) {
        const property = siblings.get(member);
        if (!property) {
          issues.error('danglingChoiceMember', at, `"${member}" is not a sibling property`);
          continue;
        }
        if (property.required || property.requiredIf) {
          issues.error(
            'requiredChoiceMember',
            at,
            `"${member}" is a choice member and cannot be required on its own`,
          );
        }
        const other = inChoice.get(member);
        if (other)
          issues.error('memberInTwoChoices', at, `"${member}" is already in choice "${other}"`);
        inChoice.set(member, choice.id);
      }
    });
  };

  const findCycle = (properties: readonly Property[]): string[] | undefined => {
    const edges = new Map(
      properties.map((property) => [
        property.name,
        property.visibleIf ? conditionRefs(property.visibleIf) : [],
      ]),
    );
    const state = new Map<string, 'open' | 'done'>();
    const stack: string[] = [];
    const visit = (name: string): string[] | undefined => {
      if (state.get(name) === 'done') return undefined;
      if (state.get(name) === 'open') return [...stack.slice(stack.indexOf(name)), name];
      state.set(name, 'open');
      stack.push(name);
      for (const next of edges.get(name) ?? []) {
        if (!edges.has(next)) continue;
        const cycle = visit(next);
        if (cycle) return cycle;
      }
      stack.pop();
      state.set(name, 'done');
      return undefined;
    };
    for (const name of edges.keys()) {
      const cycle = visit(name);
      if (cycle) return cycle;
    }
    return undefined;
  };

  const root = doc.root;
  if (root.kind === 'array') {
    if (root.items.kind !== 'object' && root.items.kind !== 'ref') {
      issues.error('listRootItems', '/root/items', 'a list body must be an array of objects');
    }
    checkNode(root, '/root');
  } else {
    checkObject(root, '/root');
  }
  for (const [name, node] of Object.entries(definitions))
    checkNode(node, pointer('/definitions', name));

  return issues;
};

/**
 * Entry point for constructors: validates the constructor's output against the model and returns
 * the typed document, or the reasons it cannot be emitted.
 */
export const defineSchema = (input: unknown): Result<SchemaDocument> => {
  const parsed = schemaDocumentSchema.safeParse(input);
  if (!parsed.success) {
    const issues = new Issues();
    for (const problem of parsed.error.issues) {
      issues.error(
        'invalidModel',
        pointer('', ...problem.path.map((segment) => String(segment))),
        problem.message,
      );
    }
    return issues.fail();
  }
  const doc: SchemaDocument = {
    ...parsed.data,
    locales: [...localesOf(parsed.data)],
    defaultLocale: defaultLocaleOf(parsed.data),
  };
  return validateDocument(doc).result(doc);
};
