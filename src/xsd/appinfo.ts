import type { Condition, Scalar } from '../model/condition.js';
import type { LocalizedText, OptionGroup, ServiceOptions } from '../model/types.js';
import { attrs, escapeText } from '../xml/escape.js';
import { childElements, textOf, type XmlElement } from '../xml/dom.js';

export const scalarType = (value: Scalar): 'string' | 'number' | 'boolean' =>
  typeof value === 'string' ? 'string' : typeof value === 'number' ? 'number' : 'boolean';

export const i18nXml = (tag: string, text: LocalizedText | undefined): string[] =>
  Object.entries(text ?? {})
    .filter(([, value]) => value.trim() !== '')
    .map(([locale, value]) => `<sk:${tag} xml:lang="${locale}">${escapeText(value)}</sk:${tag}>`);

export const valueXml = (value: Scalar): string =>
  `<sk:value${attrs({ type: scalarType(value) })}>${escapeText(String(value))}</sk:value>`;

export const conditionXml = (condition: Condition): string => {
  switch (condition.op) {
    case 'equals':
    case 'notEquals':
      return `<sk:${condition.op === 'equals' ? 'equals' : 'not-equals'}${attrs({
        ref: condition.ref,
        value: String(condition.value),
        type: scalarType(condition.value),
      })}/>`;
    case 'oneOf':
      return `<sk:one-of${attrs({ ref: condition.ref })}>${condition.values.map(valueXml).join('')}</sk:one-of>`;
    case 'filled':
      return `<sk:filled${attrs({ ref: condition.ref })}/>`;
    case 'all':
    case 'any':
      return `<sk:${condition.op}>${condition.of.map(conditionXml).join('')}</sk:${condition.op}>`;
  }
};

export const serviceOptionsXml = (options: ServiceOptions): string => {
  const children = [
    ...Object.entries(options.fill ?? {}).map(
      ([property, at]) => `<sk:fill${attrs({ property, pointer: at })}/>`,
    ),
    ...Object.entries(options.params ?? {}).map(
      ([key, field]) => `<sk:param${attrs({ key, field })}/>`,
    ),
    ...(options.filterBy
      ? [
          `<sk:filter-by${attrs({ field: options.filterBy.field, pointer: options.filterBy.pointer })}/>`,
        ]
      : []),
  ];
  const head = `<sk:options${attrs({
    kind: 'service',
    serviceId: options.serviceId,
    itemsPointer: options.itemsPointer,
    valuePointer: options.valuePointer,
    labelPointer: options.labelPointer,
  })}`;
  return children.length > 0 ? `${head}>${children.join('')}</sk:options>` : `${head}/>`;
};

export const optionGroupsXml = (groups: readonly OptionGroup[]): string[] =>
  groups.map(
    (group) =>
      `<sk:option-group${attrs({ select: group.select })}>${group.values.map(valueXml).join('')}</sk:option-group>`,
  );

export const parseValue = (raw: string, type: string | null): Scalar | undefined => {
  switch (type) {
    case 'number': {
      const number = Number(raw);
      return raw.trim() !== '' && Number.isFinite(number) ? number : undefined;
    }
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : undefined;
    case 'string':
    case null:
      return raw;
    default:
      return undefined;
  }
};

const annotationChildren = (element: XmlElement): XmlElement[] =>
  childElements(element).filter((child) => child.namespaceURI === element.namespaceURI);

export const conditionFromXml = (element: XmlElement): Condition | undefined => {
  const ref = element.getAttribute('ref') ?? '';
  switch (element.localName) {
    case 'equals':
    case 'not-equals': {
      const value = parseValue(element.getAttribute('value') ?? '', element.getAttribute('type'));
      if (value === undefined || ref === '') return undefined;
      return element.localName === 'equals'
        ? { op: 'equals', ref, value }
        : { op: 'notEquals', ref, value };
    }
    case 'one-of': {
      const values = annotationChildren(element).map((child) =>
        parseValue(textOf(child), child.getAttribute('type')),
      );
      if (ref === '' || values.length === 0 || values.some((value) => value === undefined))
        return undefined;
      return { op: 'oneOf', ref, values: values as Scalar[] };
    }
    case 'filled':
      return ref === '' ? undefined : { op: 'filled', ref };
    case 'all':
    case 'any': {
      const of = annotationChildren(element).map(conditionFromXml);
      if (of.length === 0 || of.some((part) => part === undefined)) return undefined;
      return { op: element.localName, of: of as Condition[] };
    }
    default:
      return undefined;
  }
};

/** Reads the single condition inside a `sk:visible-if` / `sk:required-if` element. */
export const wrappedConditionFromXml = (element: XmlElement): Condition | undefined => {
  const children = annotationChildren(element);
  return children.length === 1 ? conditionFromXml(children[0]!) : undefined;
};
