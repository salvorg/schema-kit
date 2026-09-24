export type JsonObject = Record<string, unknown>;

export const defined = (record: JsonObject): JsonObject =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));

export const asRecord = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

export const nonEmpty = <T>(list: readonly T[] | undefined): readonly T[] | undefined =>
  list && list.length > 0 ? list : undefined;

export const nonEmptyRecord = <T>(
  record: Readonly<Record<string, T>> | undefined,
): Readonly<Record<string, T>> | undefined =>
  record && Object.keys(record).length > 0 ? record : undefined;
