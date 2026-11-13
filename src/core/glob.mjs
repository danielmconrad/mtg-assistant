// Path globs, as mtg-manager matched collection patterns with Node's path.posix.matchesGlob, in plain
// JavaScript so they work in Workers: * and ? stay within one path segment, ** spans any number of
// segments, and [...] is a character class. tests/node/glob.test.mjs checks it against Node's.

const SPECIAL = /[.+^${}()|\\]/;

function toRegExp(glob) {
  let source = '';
  for (let position = 0; position < glob.length; position += 1) {
    const char = glob[position];
    if (char === '*' && glob[position + 1] === '*') {
      const atSegmentStart = position === 0 || glob[position - 1] === '/';
      const followedBySlash = glob[position + 2] === '/';
      if (atSegmentStart && followedBySlash) {
        source += '(?:[^/]*(?:/[^/]*)*/)?';
        position += 2;
      } else {
        source += '.*';
        position += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const close = glob.indexOf(']', position + 2);
      if (close === -1) {
        source += '\\[';
      } else {
        const body = glob
          .slice(position + 1, close)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\');
        source += `[${body}]`;
        position = close;
      }
    } else {
      source += SPECIAL.test(char) ? `\\${char}` : char;
    }
  }
  return new RegExp(`^${source}$`);
}

const cache = new Map();

export function matchesGlob(path, glob) {
  if (!cache.has(glob)) cache.set(glob, toRegExp(glob));
  return cache.get(glob).test(path);
}

const COLLECTION_EXTENSION = /\.(?:csv|txt)$/i;

// mtg-manager's pathMatches: a collection pattern matches the file's path, the path without its
// extension, or any folder it sits in, so binders* selects binders/ and everything below it.
export function pathMatches(path, pattern) {
  const glob = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  const parts = path.split('/');
  const candidates = [path, path.replace(COLLECTION_EXTENSION, '')];
  for (let length = 1; length < parts.length; length += 1) candidates.push(parts.slice(0, length).join('/'));
  return candidates.some((candidate) => matchesGlob(candidate, glob));
}
