import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const dist = new URL('../dist/', import.meta.url).pathname;

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const bad = walk(dist)
  .filter((file) => file.endsWith('.js'))
  .flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)]
      .map((match) => match[1])
      .filter((specifier) => !specifier.endsWith('.js'))
      .map((specifier) => `${file}: ${specifier}`),
  );
if (bad.length > 0) {
  console.error('relative imports without .js:\n' + bad.join('\n'));
  process.exit(1);
}

const api = await import(pkg.name);
if (api.PACKAGE_VERSION !== pkg.version) {
  console.error(`version constant ${api.PACKAGE_VERSION} != package.json ${pkg.version}`);
  process.exit(1);
}

const doc = {
  xml: { rootElement: 'request', targetNamespace: 'urn:smoke' },
  root: { kind: 'object', properties: [{ name: 'a', node: { kind: 'string' }, required: true }] },
};
const built = await api.buildSchemas(doc);
if (!built.ok || !built.value.xsd || built.value.jsonSchema.$schema !== api.JSON_SCHEMA_DIALECT) {
  console.error('buildSchemas failed', JSON.stringify(built.issues));
  process.exit(1);
}
console.log(`smoke ok: ${pkg.name}@${pkg.version}, ${Object.keys(api).length} exports`);
