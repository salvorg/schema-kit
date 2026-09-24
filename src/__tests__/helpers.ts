import { DOMParser } from '@xmldom/xmldom';
import Ajv2020 from 'ajv/dist/2020.js';
import { ANNOTATIONS, unwrap, type Result } from '../index.js';
import type { DomParserFactory } from '../xml/dom.js';

export const domParser: DomParserFactory = () =>
  new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') throw new Error(message);
    },
  }) as never;

/** Ajv in strict mode that knows only the approved annotations: any other keyword fails compile. */
export const strictAjv = () => {
  const ajv = new Ajv2020.default({ strict: true, allErrors: true, strictRequired: false });
  for (const spec of ANNOTATIONS) ajv.addKeyword({ keyword: spec.key });
  ajv.addFormat('tel', /^\+?[0-9 ()-]+$/);
  ajv.addFormat('email', /^[^@\s]+@[^@\s]+$/);
  ajv.addFormat('date', /^\d{4}-\d{2}-\d{2}$/);
  ajv.addFormat('uuid', /^[0-9a-f-]{36}$/i);
  return ajv;
};

export const ok = <T>(result: Result<T>): T => unwrap(result);

export const codes = (result: Result<unknown>, severity?: string): string[] =>
  result.issues
    .filter((issue) => severity === undefined || issue.severity === severity)
    .map((issue) => issue.code);
