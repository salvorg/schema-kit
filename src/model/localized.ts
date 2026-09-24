import type { LocalizedText } from './types.js';

/** Drops blank locales; `undefined` when nothing is left. */
export const compactText = (text: LocalizedText | undefined): LocalizedText | undefined => {
  if (!text) return undefined;
  const entries = Object.entries(text).filter(([, value]) => value.trim() !== '');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

export const pickText = (
  text: LocalizedText | undefined,
  locale: string,
  locales: readonly string[] = [],
): string | undefined => {
  if (!text) return undefined;
  for (const candidate of [locale, ...locales]) {
    const value = text[candidate];
    if (value !== undefined && value.trim() !== '') return value;
  }
  return undefined;
};
