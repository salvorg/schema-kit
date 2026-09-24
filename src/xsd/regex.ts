export type Translation = { ok: true; pattern: string } | { ok: false; reason: string };

const XSD_META = new Set(['\\', '|', '.', '-', '^', '?', '*', '+', '{', '}', '(', ')', '[', ']']);
const ECMA_SYNTAX = new Set([
  '^',
  '$',
  '\\',
  '.',
  '*',
  '+',
  '?',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '|',
  '/',
]);

const splitAlternatives = (pattern: string): string[] | undefined => {
  const parts: string[] = [];
  let depth = 0;
  let inClass = false;
  let start = 0;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (char === ']') inClass = false;
      continue;
    }
    if (char === '[') inClass = true;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === '|' && depth === 0) {
      parts.push(pattern.slice(start, i));
      start = i + 1;
    }
    if (depth < 0) return undefined;
  }
  if (depth !== 0 || inClass) return undefined;
  parts.push(pattern.slice(start));
  return parts;
};

const escapeXsdLiteral = (char: string): string => (XSD_META.has(char) ? `\\${char}` : char);

const translateEcmaBody = (body: string): Translation => {
  let out = '';
  let inClass = false;
  let classStart = false;
  let afterQuantifier = false;

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    const wasQuantifier = afterQuantifier;
    afterQuantifier = false;

    if (char === '\\') {
      const next = body[i + 1];
      if (next === undefined) return { ok: false, reason: 'trailing backslash' };
      i++;
      switch (next) {
        case 'd':
          out += inClass ? '0-9' : '[0-9]';
          break;
        case 'D':
          if (inClass) return { ok: false, reason: '\\D inside a character class' };
          out += '[^0-9]';
          break;
        case 'w':
          out += inClass ? 'A-Za-z0-9_' : '[A-Za-z0-9_]';
          break;
        case 'W':
          if (inClass) return { ok: false, reason: '\\W inside a character class' };
          out += '[^A-Za-z0-9_]';
          break;
        case 's':
        case 'S':
        case 'n':
        case 'r':
        case 't':
          out += `\\${next}`;
          break;
        case 'u':
        case 'x': {
          const braced = next === 'u' && body[i + 1] === '{';
          const hex = braced
            ? body.slice(i + 2, body.indexOf('}', i))
            : body.slice(i + 1, i + 1 + (next === 'u' ? 4 : 2));
          if (!/^[0-9A-Fa-f]+$/.test(hex)) return { ok: false, reason: `invalid \\${next} escape` };
          i += braced ? hex.length + 2 : hex.length;
          out += escapeXsdLiteral(String.fromCodePoint(parseInt(hex, 16)));
          break;
        }
        case 'p':
        case 'P': {
          const end = body.indexOf('}', i);
          const name = body.slice(i + 2, end);
          if (body[i + 1] !== '{' || end < 0 || name.includes('=')) {
            return { ok: false, reason: `\\${next}{${name}} has no XSD equivalent` };
          }
          out += `\\${next}{${name}}`;
          i = end;
          break;
        }
        default:
          if (/[0-9]/.test(next))
            return { ok: false, reason: 'backreferences have no XSD equivalent' };
          if (/[A-Za-z]/.test(next))
            return { ok: false, reason: `\\${next} has no XSD equivalent` };
          out += escapeXsdLiteral(next);
      }
      classStart = false;
      continue;
    }

    if (inClass) {
      if (char === ']' && !classStart) inClass = false;
      else if (char === '[') {
        out += '\\[';
        classStart = false;
        continue;
      }
      out += char;
      classStart = classStart && char === '^';
      continue;
    }

    switch (char) {
      case '[':
        inClass = true;
        classStart = true;
        out += char;
        break;
      case '(':
        if (body[i + 1] === '?') {
          if (body[i + 2] !== ':')
            return { ok: false, reason: 'lookaround and named groups have no XSD equivalent' };
          i += 2;
        }
        out += '(';
        break;
      case '^':
      case '$':
        return { ok: false, reason: `"${char}" inside the pattern has no XSD equivalent` };
      case '?':
        if (wasQuantifier) return { ok: false, reason: 'lazy quantifiers have no XSD equivalent' };
        out += char;
        afterQuantifier = true;
        break;
      case '*':
      case '+':
      case '}':
        out += char;
        afterQuantifier = true;
        break;
      default:
        out += char;
    }
  }
  if (inClass) return { ok: false, reason: 'unterminated character class' };
  return { ok: true, pattern: out };
};

/**
 * ECMA-262 `pattern` (unanchored search) to an XSD regular expression (implicitly anchored).
 * Unanchored sides are padded with `[\s\S]*`, so both accept exactly the same strings.
 */
export const ecmaToXsdPattern = (pattern: string): Translation => {
  const alternatives = splitAlternatives(pattern);
  if (!alternatives) return { ok: false, reason: 'unbalanced groups' };
  const translated: string[] = [];
  for (const alternative of alternatives) {
    let body = alternative;
    const anchoredStart = body.startsWith('^');
    if (anchoredStart) body = body.slice(1);
    const anchoredEnd = body.endsWith('$') && !body.endsWith('\\$');
    if (anchoredEnd) body = body.slice(0, -1);
    const result = translateEcmaBody(body);
    if (!result.ok) return result;
    const inner = `${anchoredStart ? '' : '[\\s\\S]*'}${result.pattern}${anchoredEnd ? '' : '[\\s\\S]*'}`;
    translated.push(inner);
  }
  return {
    ok: true,
    pattern:
      translated.length === 1 ? translated[0]! : translated.map((part) => `(${part})`).join('|'),
  };
};

/** XSD regular expression to an ECMA-262 pattern (evaluated with the `u` flag) with the same language. */
export const xsdToEcmaPattern = (pattern: string): Translation => {
  let out = '';
  let inClass = false;
  let classStart = false;

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '\\') {
      const next = pattern[i + 1];
      if (next === undefined) return { ok: false, reason: 'trailing backslash' };
      i++;
      switch (next) {
        case 'd':
          out += '\\p{Nd}';
          break;
        case 'D':
          out += '\\P{Nd}';
          break;
        case 's':
          out += inClass ? ' \\t\\n\\r' : '[ \\t\\n\\r]';
          break;
        case 'S':
          if (inClass) return { ok: false, reason: '\\S inside a character class' };
          out += '[^ \\t\\n\\r]';
          break;
        case 'w':
          if (inClass) return { ok: false, reason: '\\w inside a character class' };
          out += '[^\\p{P}\\p{Z}\\p{C}]';
          break;
        case 'W':
          out += inClass ? '\\p{P}\\p{Z}\\p{C}' : '[\\p{P}\\p{Z}\\p{C}]';
          break;
        case 'n':
        case 'r':
        case 't':
          out += `\\${next}`;
          break;
        case 'p':
        case 'P': {
          const end = pattern.indexOf('}', i);
          const name = pattern.slice(i + 2, end);
          if (pattern[i + 1] !== '{' || end < 0 || name.startsWith('Is')) {
            return {
              ok: false,
              reason: `\\${next}{${name}} (Unicode block) has no ECMA equivalent`,
            };
          }
          out += `\\${next}{${name}}`;
          i = end;
          break;
        }
        case 'i':
        case 'I':
        case 'c':
        case 'C':
          return { ok: false, reason: `\\${next} (XML name characters) has no ECMA equivalent` };
        case '-':
          out += inClass ? '\\-' : '-';
          break;
        default:
          if (!ECMA_SYNTAX.has(next) && next !== '-')
            return { ok: false, reason: `unknown escape \\${next}` };
          out += `\\${next}`;
      }
      classStart = false;
      continue;
    }

    if (!inClass && pattern.startsWith('[\\s\\S]', i)) {
      out += '[\\s\\S]';
      i += 5;
      continue;
    }

    if (inClass) {
      if (char === '-' && pattern[i + 1] === '[') {
        return { ok: false, reason: 'character class subtraction has no ECMA equivalent' };
      }
      if (char === ']' && !classStart) inClass = false;
      out += char === '/' ? '\\/' : char;
      classStart = classStart && char === '^';
      continue;
    }

    switch (char) {
      case '[':
        inClass = true;
        classStart = true;
        out += char;
        break;
      case '(':
        out += '(?:';
        break;
      case '^':
      case '$':
      case '/':
        out += `\\${char}`;
        break;
      case '.':
        out += '[^\\n\\r]';
        break;
      default:
        out += char;
    }
  }
  if (inClass) return { ok: false, reason: 'unterminated character class' };
  const result = `^(?:${out})$`;
  try {
    new RegExp(result, 'u');
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  return { ok: true, pattern: result };
};
