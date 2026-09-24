# schema-kit

Каноничные схемы из входных данных конструкторов: **JSON Schema 2020-12** и **XSD 1.1** из одной
модели, с утверждённым набором аннотаций `x-*` (в XSD — `sk:*`), конвертацией между форматами и
материализованной сборкой (все `$ref` разрешены, документ самодостаточен).

Библиотека не привязана к конкретному продукту: конструктор переводит своё состояние в модель
`SchemaDocument`, а дальше всё делает библиотека. Единственная runtime-зависимость — `zod`.

## Установка

Пока пакет не опубликован в npm, его ставят из git по тегу. `dist` при установке собирает скрипт
`prepare`:

```sh
npm install github:salvorg/schema-kit#v0.1.0
```

В `package.json` стоит `"private": true`, чтобы пакет нельзя было опубликовать случайно.

## Пайплайн

```
состояние конструктора ──► defineSchema ──► SchemaDocument ──► materialize ──► toJsonSchema ─► JSON Schema 2020-12
                                                   ▲                         └─► toXsd ────────► XSD 1.1
             fromJsonSchema ◄── JSON Schema ───────┤
             fromXsd        ◄── XSD ───────────────┘
```

Каждая функция возвращает `Result<T>`, а не бросает исключение:

```ts
type Result<T> = { ok: true; value: T; issues: Issue[] } | { ok: false; issues: Issue[] };
interface Issue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  path: string;
  message: string;
}
```

`path` — это JSON Pointer в модель или во входной документ. Библиотека не отбрасывает ничего молча:
всё, что она не смогла перенести, возвращается как `issue`. `unwrap(result)` возвращает значение или
бросает `SchemaKitError` со списком проблем.

## API

| Функция                                                                               | Что делает                                                                                                   |
| :------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------- |
| `defineSchema(input)`                                                                 | Точка входа для конструктора: zod-валидация и семантические проверки, нормализация `locales`/`defaultLocale` |
| `validateDocument(doc)`                                                               | Только семантические проверки (ссылки условий, циклы, типы значений, разбиение групп, выбор)                 |
| `toJsonSchema(doc, { closed?, plainText? })`                                          | Каноничная JSON Schema 2020-12; локальные `definitions` остаются как `$defs`/`$ref`                          |
| `toXsd(doc, { xml? })`                                                                | Каноничная XSD 1.1: `vc:minVersion="1.1"`, условия как `xs:assert`, аннотации `sk:*`                         |
| `fromJsonSchema(json, { strict? })`                                                   | JSON Schema → модель                                                                                         |
| `fromXsd(xsd, { domParser?, rootElement?, unwrap?, strict?, annotationNamespaces? })` | XSD → модель                                                                                                 |
| `jsonSchemaToXsd`, `xsdToJsonSchema`                                                  | Конвертация через модель                                                                                     |
| `materialize(doc, { resolve? })`                                                      | Разрешает все `$ref` — локальные и внешние (через `resolve`); имена определений сохраняются как XML-хинты    |
| `materializeJsonSchema(json, opts)`                                                   | JSON Schema на входе, самодостаточная каноничная JSON Schema на выходе                                       |
| `buildSchemas(input, { resolve?, xml?, json? })`                                      | Материализованная сборка: модель, JSON Schema, XSD и контрольная сумма модели за один вызов                  |
| `verifyChecksum(json)`, `verifyXsdChecksum(xsd)`                                      | Проверяют, что документ не правили руками после генерации                                                    |
| `ecmaToXsdPattern`, `xsdToEcmaPattern`                                                | Трансляция регулярных выражений с сохранением языка                                                          |

```ts
import { buildSchemas, equals, unwrap } from 'schema-kit';

const { jsonSchema, xsd, checksum } = unwrap(
  await buildSchemas({
    title: { ru: 'Регистрация ИП' },
    xml: { rootElement: 'registerRequest', targetNamespace: 'urn:example:registration' },
    root: {
      kind: 'object',
      properties: [
        {
          name: 'tin',
          node: { kind: 'string', pattern: '^\\d{14}$' },
          required: true,
          title: { ru: 'ИНН' },
        },
        {
          name: 'taxMode',
          node: {
            kind: 'integer',
            options: {
              kind: 'inline',
              options: [
                { value: 1, label: { ru: 'Общий' } },
                { value: 5, label: { ru: 'Патент' } },
              ],
            },
          },
          required: true,
          control: 'radio',
        },
        {
          name: 'patent',
          node: { kind: 'string' },
          required: true,
          visibleIf: equals('taxMode', 5),
        },
      ],
    },
  }),
);
```

В Node для XSD нужен DOM-парсер. Подойдёт любой W3C-совместимый, например
`fromXsd(text, { domParser: () => new DOMParser() })` из `@xmldom/xmldom`. В браузере используется
глобальный `DOMParser`.

## Модель

`SchemaDocument`: `root` — объект или массив объектов (тело-список), `definitions` для переиспользуемых
узлов, `xml` (корневой элемент, `targetNamespace`, обёртки-конверты), `model` (координата
канонической модели), `locales`/`defaultLocale` (по умолчанию `en`).

Узлы (`kind`): `string` (format, min/maxLength, pattern в ECMA-262), `integer`/`number` (включающие и
исключающие границы), `boolean`, `array` (items, min/maxItems, uniqueItems, optionGroups), `object`
(упорядоченные `properties`, `choices`), `ref` (`#/$defs/<name>` или внешний URI). У скалярных узлов
бывают `options` (inline со значениями, подписями и картинками, либо `service`-справочник), `const`,
`default` и XML-хинт `{ type, base }`.

Свойство: `name`, `node`, `required`, `title`/`description`/`placeholder` (локализованные), `control`,
`visibleIf`, `requiredIf`, `transient`, `binding` (`{ model, version, pointer }`), `dataClass`.

Словарь условий намеренно мал, чтобы любой потребитель мог его вычислить: `equals`, `notEquals`, `oneOf`, `filled`,
`all`, `any`. `ref` условия указывает на соседнее свойство того же уровня объекта.

Правила, которые проверяет `validateDocument` и на которые поэтому могут опираться эмиттеры:

- имена уникальны на своём уровне; это XML NCName без двоеточия;
- `required` и `requiredIf` взаимоисключающие. «Обязательно, когда видно» пишется как
  `required` + `visibleIf`;
- условие ссылается на существующее соседнее свойство, не на само себя, без циклов видимости; тип
  значения совпадает с типом поля; составное поле можно проверять только через `filled`;
- тип значений опций совпадает с `kind`, значения не повторяются, картинка — путь того же источника;
- `optionGroups` разбивают опции элементов массива ровно, без пропусков и пересечений;
- участник `choice` не может быть обязательным сам по себе и не может входить в два выбора;
- у `fill`/`params`/`filterBy` справочника цель — соседнее свойство.

## Утверждённые аннотации

Полный список — в `ANNOTATIONS`. Эмиттеры пишут только эти ключи. Парсеры сообщают о любом другом
`x-*` как `unapprovedAnnotation` и отбрасывают его.

| JSON (`x-*`)                                               | XSD (`sk:*`, ns `urn:schema-kit:annotations`)                              | Где                 | Смысл                                                                |
| :--------------------------------------------------------- | :------------------------------------------------------------------------- | :------------------ | :------------------------------------------------------------------- |
| `x-canonical`                                              | `sk:canonical`                                                             | документ            | диалект, генератор, локали, контрольная сумма                        |
| `x-model`                                                  | `sk:model`                                                                 | документ            | координата канонической модели                                       |
| `x-xml`                                                    | структура схемы                                                            | документ / узел     | корневой элемент, namespace, обёртки; имя типа и точный built-in     |
| `x-i18n-title`, `x-i18n-description`, `x-i18n-placeholder` | `sk:i18n-*` + `xml:lang`                                                   | документ / свойство | локализованные тексты                                                |
| `x-control`                                                | `sk:control`                                                               | свойство            | подсказка представления                                              |
| `x-options`                                                | `xs:enumeration` + `sk:i18n-label`/`sk:image`; `sk:options kind="service"` | узел                | подписи опций или справочник                                         |
| `x-optionGroups`                                           | `sk:option-group`                                                          | массив              | группы опций, выбираемые взаимоисключающе                            |
| `x-visibleIf`, `x-requiredIf`                              | `sk:visible-if`, `sk:required-if` + `xs:assert`                            | свойство            | условия                                                              |
| `x-transient`                                              | `sk:transient`                                                             | свойство            | поле спрашивается на форме, но не уходит в тело                      |
| `x-binding`                                                | `sk:binding`                                                               | свойство            | атрибут канонической модели                                          |
| `x-data-class`                                             | `sk:data-class`                                                            | свойство            | класс данных                                                         |
| `x-choices`                                                | `xs:choice` + `sk:choice`                                                  | объект              | взаимоисключающие свойства                                           |
| `x-derived`                                                | —                                                                          | объект              | помечает `allOf` как сгенерированный; содержит его контрольную сумму |

Сгенерированные правила (`allOf` в JSON, `xs:assert` в XSD) — производные. Парсер их не читает, а
генерирует заново из `x-visibleIf`/`x-requiredIf`/`x-choices`. Рукописный `allOf` без `x-derived`
перенести нельзя, поэтому в `strict`-режиме это ошибка.

## Семантика конвертации

- **Nullability.** Каноничный `type` — всегда одна строка, пустое значение выражается отсутствием
  ключа. При чтении `["T","null"]` сводится к `T` с предупреждением `nullableType`.
- **Регулярные выражения.** В JSON Schema это поиск (без якорей), в XSD — полное совпадение. Незаякоренная
  сторона дополняется `[\s\S]*`. `\d` и `\w` переводятся точно (`[0-9]`, `[A-Za-z0-9_]` в одну
  сторону; `\p{Nd}`, `[^\p{P}\p{Z}\p{C}]` в другую). Оригинальный ECMA-шаблон сохраняется в
  `sk:ecma-pattern`, поэтому обход JSON → XSD → JSON возвращает исходную строку. Ленивые
  квантификаторы, lookaround, обратные ссылки и вычитание классов не имеют эквивалента и дают ошибку
  `patternNotTranslatable`.
- **Массивы.** В XSD это повторяющийся элемент (`maxOccurs`). `maxItems ≤ 1` помечается `sk:array`,
  `minItems` сохраняется в `sk:min-items`, у необязательного массива нижняя граница проверяется через
  `xs:assert`.
- **Условия.** В XSD 1.1 условия становятся `xs:assert` на родительском типе
  (`xpathDefaultNamespace="##targetNamespace"`); значения типизированы (`5`, `'x'`, `true()`).
- **Выбор.** `choices` соответствует `xs:choice`. В JSON это `oneOf` из `required` (обязательный
  выбор) или запрет пар (необязательный).
- **Namespace аннотаций.** Библиотека пишет `sk:*` в `urn:schema-kit:annotations`. XSD, в которых тот
  же словарь (`i18n-title`, `options`, `visible-if`…) записан в другом namespace, читаются с опцией
  `annotationNamespaces: ['<ns>']`. Appinfo в незнакомых namespace игнорируется.
- **Типы XSD.** Точный built-in (`int`, `long`, `token`…) сохраняется в `xml.base`; имена именованных
  типов — в `xml.type`. Типы, которых нет в модели (`gYear`, `base64Binary`…), читаются как строка с
  предупреждением `narrowedType`.
- **Строгость.** `strict: true` (по умолчанию): ключевое слово валидации, которое модель не несёт,
  считается ошибкой, потому что его отбрасывание изменило бы множество допустимых данных.
  `strict: false` понижает его до предупреждения. Чисто аннотационные ключи (`examples`, `readOnly`…)
  всегда отбрасываются с `info`.
- **Контрольные суммы.** SHA-256 от JCS (RFC 8785) тела JSON Schema без `x-canonical`; для XSD —
  SHA-256 текста с нулевым значением в `sk:canonical/@checksum`. `buildSchemas` отдаёт ещё и сумму
  модели, одинаковую для обеих проекций.

Чего XSD не выражает, и `toXsd` возвращает ошибку: тело-список (`listBodyInXsd`), массив массивов,
массив в `definitions`, внешние `$ref` без материализации.

## Гейты

В CI гейты запускает `.github/workflows/verify.yml`.

```sh
npm run typecheck && npm run format:check && npm test && npm run build && npm run smoke
npm run fetch:xsd11 && npm run test:xsd11
```

`test:xsd11` прогоняет сгенерированный XSD через настоящий процессор XSD 1.1 (Xerces-J 2.12.2,
`.tools/`, скачивается из Maven Central со сверкой SHA-1). Он проверяет, что схема валидна, что
корректный документ проходит, а каждое отдельно нарушенное правило (шаблон, перечисление, `fixed`,
каждый `xs:assert`, `xs:choice`, `maxOccurs`, лишний элемент) отклоняется. Без процессора набор
падает, а не пропускается. Нужна JDK 11+.

`smoke` импортирует собранный пакет через настоящий Node ESM, проверяет, что относительные импорты
оканчиваются на `.js`, и что константа версии совпадает с `package.json`.
