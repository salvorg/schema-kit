import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fromXsd, materialize, toXsd } from '../../index.js';
import { LEGACY_ANNOTATIONS, SEARCH } from '../fixtures/legacyXsd.js';
import { REGISTRATION } from '../fixtures/registration.js';
import { domParser, ok } from '../helpers.js';

const root = resolve(import.meta.dirname, '../../..');
const jars = join(root, '.tools/xerces');
const validator = join(root, 'scripts/xsd11/Validate.java');

if (!existsSync(jars) || readdirSync(jars).filter((file) => file.endsWith('.jar')).length < 5) {
  throw new Error('XSD 1.1 processor missing: run scripts/fetch-xsd11.sh');
}

const classpath = readdirSync(jars)
  .filter((file) => file.endsWith('.jar'))
  .map((file) => join(jars, file))
  .join(':');

const run = (xsd: string, instances: Record<string, string>): Record<string, string> => {
  const dir = mkdtempSync(join(tmpdir(), 'schema-kit-xsd11-'));
  writeFileSync(join(dir, 'schema.xsd'), xsd);
  const files = Object.entries(instances).map(([name, body]) => {
    const file = join(dir, `${name}.xml`);
    writeFileSync(file, body);
    return file;
  });
  let output: string;
  try {
    output = execFileSync(
      'java',
      ['-cp', classpath, validator, join(dir, 'schema.xsd'), ...files],
      { encoding: 'utf8' },
    );
  } catch (error) {
    output = String((error as { stdout?: string }).stdout ?? error);
  }
  const verdicts: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const [verdict, file, message] = line.split('\t');
    if (verdict === 'SCHEMA-INVALID') throw new Error(`schema rejected: ${file}`);
    if (!file) continue;
    const name = file.slice(dir.length + 1, -'.xml'.length);
    verdicts[name] = verdict === 'VALID' ? 'VALID' : `INVALID: ${message}`;
  }
  return verdicts;
};

const NS = 'urn:example:sole-proprietor';

const body = (fields: Record<string, string | undefined>, extra = ''): string => {
  const order = [
    'tin',
    'fullName',
    'birthDate',
    'taxMode',
    'patentKinds',
    'activityCode',
    'activityName',
    'employees',
    'phone',
    'email',
    'consent',
    'captcha',
    'legalAddress',
    'actualAddress',
    'founders',
    'identity',
  ];
  const parts = order
    .map((name) => fields[name])
    .filter((part): part is string => part !== undefined);
  return `<?xml version="1.0" encoding="UTF-8"?><registerRequest xmlns="${NS}"><body>${parts.join('')}${extra}</body></registerRequest>`;
};

const valid = {
  tin: '<tin>21505200250230</tin>',
  fullName: '<fullName>Асанов Асан</fullName>',
  taxMode: '<taxMode>1</taxMode>',
  activityCode: '<activityCode>47.11</activityCode>',
  employees: '<employees>3</employees>',
  consent: '<consent>true</consent>',
  legalAddress: '<legalAddress><region>Чуй</region></legalAddress>',
  identity: '<passportNumber>AN1234567</passportNumber>',
};

describe('generated XSD under a real XSD 1.1 processor (Xerces-J 2.12.2)', async () => {
  const xsd = ok(toXsd(ok(await materialize(REGISTRATION))));

  it('is a valid schema that accepts a valid instance and rejects each broken rule', () => {
    const verdicts = run(xsd, {
      valid: body(valid),
      patentShown: body({
        ...valid,
        taxMode: '<taxMode>5</taxMode>',
        employees: undefined,
        patentKinds: '<patentKinds>TRADE</patentKinds><patentKinds>SERVICE</patentKinds>',
      }),
      founderResident: body({
        ...valid,
        founders:
          '<founders><founderTin>21505200250230</founderTin><isResident>true</isResident></founders>',
      }),
      badTin: body({ ...valid, tin: '<tin>123</tin>' }),
      badEnum: body({ ...valid, taxMode: '<taxMode>3</taxMode>' }),
      consentFalse: body({ ...valid, consent: '<consent>false</consent>' }),
      hiddenPresent: body({ ...valid, patentKinds: '<patentKinds>TRADE</patentKinds>' }),
      visibleMissing: body({ ...valid, taxMode: '<taxMode>5</taxMode>', employees: undefined }),
      requiredIfMissing: body({ ...valid, employees: undefined }),
      bothChoices: body({
        ...valid,
        identity: '<passportNumber>AN1</passportNumber><idCardNumber>ID1</idCardNumber>',
      }),
      noChoice: body({ ...valid, identity: undefined }),
      founderNoPassport: body({
        ...valid,
        founders:
          '<founders><founderTin>21505200250230</founderTin><isResident>false</isResident></founders>',
      }),
      tooManyFounders: body({
        ...valid,
        founders: '<founders><founderTin>21505200250230</founderTin></founders>'.repeat(6),
      }),
      unknownElement: body(valid, '<extra>1</extra>'),
    });
    if (process.env['XSD11_VERBOSE']) console.log(verdicts);
    expect(verdicts['valid']).toBe('VALID');
    expect(verdicts['patentShown']).toBe('VALID');
    expect(verdicts['founderResident']).toBe('VALID');
    for (const name of [
      'badTin',
      'badEnum',
      'consentFalse',
      'hiddenPresent',
      'visibleMissing',
      'requiredIfMissing',
      'bothChoices',
      'noChoice',
      'founderNoPassport',
      'tooManyFounders',
      'unknownElement',
    ]) {
      expect(verdicts[name], name).toMatch(/^INVALID/);
    }
  });

  it('keeps a hand-written XSD valid after a round trip', () => {
    const regenerated = ok(
      toXsd(ok(fromXsd(SEARCH, { domParser, annotationNamespaces: [LEGACY_ANNOTATIONS] }))),
    );
    const verdicts = run(regenerated, {
      valid:
        '<searchCompaniesRequest xmlns="urn:example:registry"><query>Acme</query><type>NAME</type></searchCompaniesRequest>',
      blank:
        '<searchCompaniesRequest xmlns="urn:example:registry"><query>   </query><type>NAME</type></searchCompaniesRequest>',
    });
    expect(verdicts).toEqual({ valid: 'VALID', blank: expect.stringMatching(/^INVALID/) });
  });
});
