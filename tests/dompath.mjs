// Shared static-DOM helpers for layout contract tests.
//
// These tests parse dist/index.html (the shipped markup) and assert
// structural contracts that CSS/JS depend on but a linter cannot see.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @returns {string} the shipped index.html */
export function readIndex() {
  return readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * Walks the markup inside <body> and returns the ancestor chain of the
 * element with the given id, outermost first, as { tag, id, cls } objects.
 * A body-level element yields []. Returns null when the id is not found.
 * (index.html is machine-formatted; a simple tag-stack pop is sufficient.)
 * @param {string} html
 * @param {string} id
 */
export function ancestorsOf(html, id) {
  const bodyOpen = html.indexOf('<body');
  const body = html.slice(html.indexOf('>', bodyOpen) + 1, html.indexOf('</body>'));
  /** @type {{ tag: string, id: string, cls: string[] }[]} */
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g;
  let m;
  while ((m = tagRe.exec(body)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    if (VOID_TAGS.has(tag) || attrs.endsWith('/')) continue;
    if (closing) {
      const idx = stack.findLastIndex((e) => e.tag === tag);
      if (idx !== -1) stack.length = idx;
      continue;
    }
    const idMatch = /id="([^"]*)"/.exec(attrs);
    if (idMatch && idMatch[1] === id) return stack.map((e) => e);
    const clsMatch = /class="([^"]*)"/.exec(attrs);
    stack.push({ tag, id: idMatch ? idMatch[1] : '', cls: clsMatch ? clsMatch[1].split(/\s+/) : [] });
  }
  return null;
}

/** @returns {boolean} true when the element with `id` has an ancestor with class `cls` */
export function hasAncestorClass(html, id, cls) {
  const chain = ancestorsOf(html, id);
  return chain !== null && chain.some((a) => a.cls.includes(cls));
}

/** @returns {string[]} every `data-nav` value in the side nav */
export function sidenavKeys(html) {
  return [...html.matchAll(/class="sidenav__item[^"]*" data-nav="([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Returns the `}`-terminated CSS rule block starting at `selector`
 * (first occurrence).
 */
export function cssBlock(css, selector) {
  const start = css.indexOf(selector);
  if (start === -1) return null;
  return css.slice(start, css.indexOf('}', start));
}
