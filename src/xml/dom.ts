import { ANNOTATION_NAMESPACE } from '../annotations.js';

export const XS = 'http://www.w3.org/2001/XMLSchema';
export const VC = 'http://www.w3.org/2007/XMLSchema-versioning';
export const XML_NS = 'http://www.w3.org/XML/1998/namespace';
export const SK = ANNOTATION_NAMESPACE;

/** The part of the W3C DOM this library reads; satisfied by browsers and by `@xmldom/xmldom`. */
export interface XmlNode {
  readonly nodeType: number;
  readonly childNodes: ArrayLike<XmlNode>;
  readonly textContent: string | null;
}

export interface XmlElement extends XmlNode {
  readonly localName: string;
  readonly namespaceURI: string | null;
  readonly parentNode: XmlNode | null;
  getAttribute(name: string): string | null;
  getAttributeNS(namespace: string | null, name: string): string | null;
  hasAttribute(name: string): boolean;
  lookupNamespaceURI(prefix: string | null): string | null;
  readonly attributes: ArrayLike<{
    readonly name: string;
    readonly namespaceURI: string | null;
    readonly localName: string;
  }>;
}

export interface XmlDocument extends XmlNode {
  readonly documentElement: XmlElement | null;
}

export interface DomParserLike {
  parseFromString(text: string, mimeType: string): unknown;
}

export type DomParserFactory = () => DomParserLike;

const ELEMENT_NODE = 1;

export const childElements = (node: XmlNode): XmlElement[] => {
  const out: XmlElement[] = [];
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i]!;
    if (child.nodeType === ELEMENT_NODE) out.push(child as XmlElement);
  }
  return out;
};

export const isXs = (element: XmlElement, localName?: string): boolean =>
  element.namespaceURI === XS && (localName === undefined || element.localName === localName);

export const xsChildren = (element: XmlElement, localName?: string): XmlElement[] =>
  childElements(element).filter((child) => isXs(child, localName));

export const textOf = (element: XmlElement): string => element.textContent ?? '';

export const langOf = (element: XmlElement): string | null =>
  element.getAttributeNS(XML_NS, 'lang') ?? element.getAttribute('xml:lang');

/**
 * Parses XML text. Uses `parser` when given, else the global `DOMParser` (browsers). In Node pass
 * `() => new (require('@xmldom/xmldom').DOMParser)()` or any W3C-compatible implementation.
 */
export const parseXml = (
  text: string,
  parser?: DomParserFactory,
): { ok: true; document: XmlDocument } | { ok: false; reason: string } => {
  const factory =
    parser ??
    (typeof (globalThis as { DOMParser?: new () => DomParserLike }).DOMParser === 'function'
      ? () => new (globalThis as unknown as { DOMParser: new () => DomParserLike }).DOMParser()
      : undefined);
  if (!factory) return { ok: false, reason: 'no DOMParser available; pass options.domParser' };

  let document: XmlDocument;
  try {
    document = factory().parseFromString(text, 'application/xml') as XmlDocument;
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  const root = document?.documentElement;
  if (!root) return { ok: false, reason: 'no document element' };
  if (root.localName === 'parsererror' || findParserError(root)) {
    return {
      ok: false,
      reason: (findParserError(root) ?? root).textContent?.trim() || 'not well-formed XML',
    };
  }
  return { ok: true, document };
};

const findParserError = (element: XmlElement): XmlElement | undefined => {
  if (element.localName === 'parsererror') return element;
  for (const child of childElements(element)) {
    if (child.localName === 'parsererror') return child;
  }
  return undefined;
};
