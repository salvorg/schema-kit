export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  readonly severity: Severity;
  readonly code: string;
  /** JSON Pointer into the document the operation read (model, JSON Schema or XSD element path). */
  readonly path: string;
  readonly message: string;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T; readonly issues: readonly Issue[] }
  | { readonly ok: false; readonly issues: readonly Issue[] };

export class SchemaKitError extends Error {
  readonly issues: readonly Issue[];

  constructor(issues: readonly Issue[]) {
    const first = issues.find((issue) => issue.severity === 'error') ?? issues[0];
    super(first ? `${first.code} at ${first.path || '/'}: ${first.message}` : 'schema-kit failed');
    this.name = 'SchemaKitError';
    this.issues = issues;
  }
}

export class Issues {
  readonly list: Issue[] = [];

  error(code: string, path: string, message: string): void {
    this.list.push({ severity: 'error', code, path, message });
  }

  warn(code: string, path: string, message: string): void {
    this.list.push({ severity: 'warning', code, path, message });
  }

  info(code: string, path: string, message: string): void {
    this.list.push({ severity: 'info', code, path, message });
  }

  push(issues: readonly Issue[]): void {
    this.list.push(...issues);
  }

  get failed(): boolean {
    return hasErrors(this.list);
  }

  result<T>(value: T): Result<T> {
    return this.failed ? { ok: false, issues: this.list } : { ok: true, value, issues: this.list };
  }

  fail<T>(): Result<T> {
    return { ok: false, issues: this.list };
  }
}

export const hasErrors = (issues: readonly Issue[]): boolean =>
  issues.some((issue) => issue.severity === 'error');

/** Returns the value of a successful result, or throws {@link SchemaKitError} with its issues. */
export const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new SchemaKitError(result.issues);
  return result.value;
};

export const pointer = (base: string, ...segments: readonly (string | number)[]): string =>
  segments.reduce<string>(
    (path, segment) => `${path}/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`,
    base,
  );
