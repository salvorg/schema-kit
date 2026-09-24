import { z } from 'zod';

export type Scalar = string | number | boolean;

/**
 * When a property is shown or required. Refs name sibling properties of the same object level.
 * The vocabulary is deliberately small so every consumer can evaluate it; nothing richer is accepted.
 */
export type Condition =
  | { readonly op: 'equals'; readonly ref: string; readonly value: Scalar }
  | { readonly op: 'notEquals'; readonly ref: string; readonly value: Scalar }
  | { readonly op: 'oneOf'; readonly ref: string; readonly values: readonly Scalar[] }
  | { readonly op: 'filled'; readonly ref: string }
  | { readonly op: 'all'; readonly of: readonly Condition[] }
  | { readonly op: 'any'; readonly of: readonly Condition[] };

export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export const nameSchema = z.string().regex(NAME_PATTERN, 'must be an XML NCName without colons');
export const scalarSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z.strictObject({ op: z.literal('equals'), ref: nameSchema, value: scalarSchema }),
    z.strictObject({ op: z.literal('notEquals'), ref: nameSchema, value: scalarSchema }),
    z.strictObject({
      op: z.literal('oneOf'),
      ref: nameSchema,
      values: z.array(scalarSchema).min(1),
    }),
    z.strictObject({ op: z.literal('filled'), ref: nameSchema }),
    z.strictObject({ op: z.literal('all'), of: z.array(conditionSchema).min(1) }),
    z.strictObject({ op: z.literal('any'), of: z.array(conditionSchema).min(1) }),
  ]),
);

export const equals = (ref: string, value: Scalar): Condition => ({ op: 'equals', ref, value });
export const notEquals = (ref: string, value: Scalar): Condition => ({
  op: 'notEquals',
  ref,
  value,
});
export const oneOf = (ref: string, values: readonly Scalar[]): Condition => ({
  op: 'oneOf',
  ref,
  values,
});
export const filled = (ref: string): Condition => ({ op: 'filled', ref });
export const all = (...of: Condition[]): Condition => ({ op: 'all', of });
export const any = (...of: Condition[]): Condition => ({ op: 'any', of });

export const conditionRefs = (condition: Condition): string[] => {
  const found = new Set<string>();
  const walk = (node: Condition): void => {
    if (node.op === 'all' || node.op === 'any') node.of.forEach(walk);
    else found.add(node.ref);
  };
  walk(condition);
  return [...found];
};

export const conditionValues = (condition: Condition): { ref: string; value: Scalar }[] => {
  switch (condition.op) {
    case 'equals':
    case 'notEquals':
      return [{ ref: condition.ref, value: condition.value }];
    case 'oneOf':
      return condition.values.map((value) => ({ ref: condition.ref, value }));
    case 'filled':
      return [];
    case 'all':
    case 'any':
      return condition.of.flatMap(conditionValues);
  }
};

export const conditionToSubschema = (condition: Condition): Record<string, unknown> => {
  switch (condition.op) {
    case 'equals':
      return {
        properties: { [condition.ref]: { const: condition.value } },
        required: [condition.ref],
      };
    case 'notEquals':
      return {
        not: {
          properties: { [condition.ref]: { const: condition.value } },
          required: [condition.ref],
        },
      };
    case 'oneOf':
      return {
        properties: { [condition.ref]: { enum: [...condition.values] } },
        required: [condition.ref],
      };
    case 'filled':
      return { required: [condition.ref] };
    case 'all':
      return { allOf: condition.of.map(conditionToSubschema) };
    case 'any':
      return { anyOf: condition.of.map(conditionToSubschema) };
  }
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const isScalar = (value: unknown): value is Scalar =>
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));

/** Inverse of {@link conditionToSubschema}; `undefined` for any shape outside the vocabulary. */
export const conditionFromSubschema = (value: unknown): Condition | undefined => {
  const node = asRecord(value);
  if (!node) return undefined;
  const keys = Object.keys(node);

  if (keys.length === 1 && (Array.isArray(node['allOf']) || Array.isArray(node['anyOf']))) {
    const list = (node['allOf'] ?? node['anyOf']) as unknown[];
    const parts = list.map(conditionFromSubschema);
    if (parts.length === 0 || parts.some((part) => part === undefined)) return undefined;
    return { op: node['allOf'] ? 'all' : 'any', of: parts as Condition[] };
  }

  if (keys.length === 1 && node['not'] !== undefined) {
    const inner = conditionFromSubschema(node['not']);
    return inner?.op === 'equals'
      ? { op: 'notEquals', ref: inner.ref, value: inner.value }
      : undefined;
  }

  const required = node['required'];
  const ref =
    Array.isArray(required) && required.length === 1 && typeof required[0] === 'string'
      ? required[0]
      : undefined;
  if (ref === undefined) return undefined;

  const properties = asRecord(node['properties']);
  if (!properties) return keys.length === 1 ? { op: 'filled', ref } : undefined;
  if (keys.length !== 2 || Object.keys(properties).length !== 1) return undefined;

  const predicate = asRecord(properties[ref]);
  if (!predicate || Object.keys(predicate).length !== 1) return undefined;
  if (isScalar(predicate['const'])) return { op: 'equals', ref, value: predicate['const'] };
  const list = predicate['enum'];
  if (Array.isArray(list) && list.length > 0 && list.every(isScalar)) {
    return { op: 'oneOf', ref, values: list };
  }
  return undefined;
};

const xpathLiteral = (value: Scalar): string => {
  if (typeof value === 'boolean') return value ? 'true()' : 'false()';
  if (typeof value === 'number') return String(value);
  return `'${value.replace(/'/g, "''")}'`;
};

/** XPath 2.0 predicate for an XSD 1.1 `xs:assert`, evaluated on the parent element. */
export const conditionToXPath = (condition: Condition): string => {
  switch (condition.op) {
    case 'equals':
      return `${condition.ref} = ${xpathLiteral(condition.value)}`;
    case 'notEquals':
      return `not(${condition.ref} = ${xpathLiteral(condition.value)})`;
    case 'oneOf':
      return condition.values.length === 1
        ? `${condition.ref} = ${xpathLiteral(condition.values[0]!)}`
        : `${condition.ref} = (${condition.values.map(xpathLiteral).join(', ')})`;
    case 'filled':
      return `exists(${condition.ref})`;
    case 'all':
      return condition.of.map((part) => `(${conditionToXPath(part)})`).join(' and ');
    case 'any':
      return condition.of.map((part) => `(${conditionToXPath(part)})`).join(' or ');
  }
};

export type ConditionValueKind = 'string' | 'number' | 'boolean';

export const scalarKind = (value: Scalar): ConditionValueKind =>
  typeof value === 'string' ? 'string' : typeof value === 'number' ? 'number' : 'boolean';
