// solve.js: a faster drop-in for makefun-site 1.0.0's build. run(input) returns the same output tree (path -> text)
// that the reference returns for { site, templates, files }. Dependency-free ES module.
//
// Semantics follow the reference code (kit: baselines/makefun-site/vendor/makefun-site/) rule for rule; the speed comes
// from doing the same work with fewer allocations: escaping runs of text instead of single characters, cheap
// first-character checks before any regular expression, templates compiled once into closures, and cached slugs.

// ---------------------------------------------------------------- text

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `s` with & < > " ' escaped (and nothing else). */
function esc(s) {
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    let r;
    switch (s.charCodeAt(i)) {
      case 38: r = '&amp;'; break;
      case 60: r = '&lt;'; break;
      case 62: r = '&gt;'; break;
      case 34: r = '&quot;'; break;
      case 39: r = '&#39;'; break;
      default: continue;
    }
    if (i > last) out += s.slice(last, i);
    out += r;
    last = i + 1;
  }
  if (last === 0) return s;
  return last < s.length ? out + s.slice(last) : out;
}

const slugCache = new Map();

/** The reference slug rule: NFKD, marks dropped, A-Z lowered, runs of anything else one "-", 64 at most, "untitled". */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
      break;
    }
  }
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    let c = plain.charCodeAt(i);
    if (c >= 65 && c <= 90) c += 32;
    else if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(c);
  }
  if (out.length > 64) out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e < out.length) out = out.slice(0, e);
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** JavaScript's \s: WhiteSpace and LineTerminator code points. */
function isWS(c) {
  if (c <= 32) return c === 32 || (c >= 9 && c <= 13);
  if (c < 160) return false;
  return c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The count of runs of non-whitespace in `s` (the reference's /\S+/g match count). */
function wordsOf(s) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    if (isWS(s.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_BLANK = /^[ \t]*$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    const end = raw.length - 1;
    let out = '';
    let from = 1;
    for (let i = 1; i < end; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        const n = raw.charCodeAt(i + 1);
        if ((n !== 34 && n !== 92) || i + 1 === end) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += raw.slice(from, i);
        from = i + 1;
        i++;
      } else if (c === 34) return { error: 'a quoted string holds a stray quote' };
    }
    return { value: out + raw.slice(from, end) };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return s.error !== undefined ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let k = 0; k < tags.length; k++) {
        const t = tags[k].trim();
        if (t === '' || !TAG.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        tags[k] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return raw.length <= 64 && SLUG.test(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
  }
  return { error: `unknown key "${key}"` };
}

/** { data, body } or { error }: the reference's front matter, line by line. */
function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  if ((nl === -1 ? text : text.slice(0, nl)) !== '---') return { error: 'no front matter' };
  const fm = [];
  let body = null;
  let start = nl === -1 ? -1 : nl + 1;
  while (start !== -1) {
    const e = text.indexOf('\n', start);
    const line = e === -1 ? text.slice(start) : text.slice(start, e);
    if (line === '---') {
      body = e === -1 ? '' : text.slice(e + 1);
      break;
    }
    fm.push(line);
    start = e === -1 ? -1 : e + 1;
  }
  if (body === null) return { error: 'the front matter is not closed' };
  const data = {};
  for (let k = 0; k < fm.length; k++) {
    const line = fm[k];
    if (line.charCodeAt(0) === 35 || FM_BLANK.test(line)) continue;
    const m = FM_LINE.exec(line);
    if (m === null) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    let raw = m[2] ?? '';
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    if (e < raw.length) raw = raw.slice(0, e);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if (v.error !== undefined) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body };
}

// ---------------------------------------------------------------- markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

/** Whether the line is only spaces and tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

const isFenceOpen = (line) => line.charCodeAt(0) === 96 && FENCE_OPEN.test(line);
const isHr = (line) => {
  const c = line.charCodeAt(0);
  return (c === 45 || c === 42) && HR.test(line);
};

/** A heading's [depth, text], or null. */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : m;
}

/** Spaces and tabs dropped at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The characters a backslash escapes: \ ` * _ [ ] ( ) # + - . ! > */
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;
const escapable = (c) => c < 128 && ESCAPABLE[c] === 1;

/** First single `code` from `from` outside an escape, or -1. */
function findUnescaped1(s, code, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && escapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c === code) return j;
  }
  return -1;
}

/** First "**" from `from` outside an escape, or -1. */
function findDoubleStar(s, from) {
  const lim = s.length - 2;
  for (let j = from; j <= lim; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && escapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

/** First single * (not part of "**") from `from`, outside an escape, or -1. */
function findSingleStar(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && escapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const HAS_WS = /\s/;

/** Inline Markdown of `s`; `link(target)` gives a link's href. */
function inline(s, link) {
  const n = s.length;
  let out = '';
  let run = 0;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < n && escapable(s.charCodeAt(i + 1))) {
        if (run < i) out += esc(s.slice(run, i));
        out += esc(s[i + 1]);
        i += 2;
        run = i;
        continue;
      }
    } else if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (run < i) out += esc(s.slice(run, i));
        out += `<code>${esc(s.slice(i + 1, j))}</code>`;
        i = j + 1;
        run = i;
        continue;
      }
    } else if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findDoubleStar(s, i + 2);
        if (j > i + 2) {
          if (run < i) out += esc(s.slice(run, i));
          out += `<strong>${inline(s.slice(i + 2, j), link)}</strong>`;
          i = j + 2;
          run = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (run < i) out += esc(s.slice(run, i));
        out += `<em>${inline(s.slice(i + 1, j), link)}</em>`;
        i = j + 1;
        run = i;
        continue;
      }
    } else if (c === 91) {
      const k = findUnescaped1(s, 93, i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      if (m > k + 2) {
        const target = s.slice(k + 2, m);
        if (!HAS_WS.test(target)) {
          if (run < i) out += esc(s.slice(run, i));
          const href = esc(link(target));
          out += `<a href="${href}">${inline(s.slice(i + 1, k), link)}</a>`;
          i = m + 1;
          run = i;
          continue;
        }
      }
    }
    i++;
  }
  if (run < n) out += run === 0 ? esc(s) : esc(s.slice(run));
  return out;
}

/** The body rendered: { html, toc, excerpt }. */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const L = lines.length;
  const ids = new Set();
  const toc = [];
  let html = '';
  let excerpt = null;
  let i = 0;
  while (i < L) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        i++;
        let body = '';
        while (i < L && !(lines[i].charCodeAt(0) === 96 && FENCE_CLOSE.test(lines[i]))) body += `${esc(lines[i++])}\n`;
        i++;
        const lang = fence[1];
        html += lang === '' ? `<pre><code>${body}</code></pre>\n` : `<pre><code class="language-${esc(lang)}">${body}</code></pre>\n`;
        continue;
      }
    }
    if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const depth = h[1].length;
        const text = h[2];
        const id = uniqueSlug(slugify(text), ids);
        const inner = inline(text, link);
        html += `<h${depth} id="${id}">${inner}</h${depth}>\n`;
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, html: inner });
        i++;
        continue;
      }
    }
    if (isHr(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    if (c0 === 62) {
      let body = '';
      let any = false;
      while (i < L && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        const t = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t === '') continue;
        body = any ? `${body}\n${t}` : t;
        any = true;
      }
      html += any ? `<blockquote>\n<p>${inline(body, link)}</p>\n</blockquote>\n` : '<blockquote>\n</blockquote>\n';
      continue;
    }
    let bullet = null;
    let ordered = null;
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) bullet = BULLET.exec(line);
    else if (c0 >= 48 && c0 <= 57) ordered = ORDERED.exec(line);
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (i < L) {
        const l = lines[i];
        const m = marker.exec(l);
        if (m !== null) {
          items.push(trimLine(isOrdered ? m[2] : m[1]));
          i++;
        } else if (l.charCodeAt(0) === 32 && l.charCodeAt(1) === 32 && CONTINUED.test(l)) {
          items[items.length - 1] += `\n${trimLine(l)}`;
          i++;
        } else break;
      }
      const start = isOrdered ? Number(ordered[1]) : 1;
      let out = isOrdered ? (start !== 1 ? `<ol start="${start}">\n` : '<ol>\n') : '<ul>\n';
      for (let k = 0; k < items.length; k++) out += `<li>${inline(items[k], link)}</li>\n`;
      html += isOrdered ? `${out}</ol>\n` : `${out}</ul>\n`;
      continue;
    }
    let text = trimLine(line);
    i++;
    while (i < L) {
      const l = lines[i];
      if (isBlank(l) || isFenceOpen(l) || headingOf(l) !== null || isHr(l)) break;
      text += `\n${trimLine(l)}`;
      i++;
    }
    const inner = inline(text, link);
    if (excerpt === null) excerpt = inner;
    html += `<p>${inner}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;
const STANDALONE_SIDE = /^[ \t]*$/;

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const w = raw ? 3 : 2;
      const close = src.indexOf(raw ? '}}}' : '}}', open + w);
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + w, close).trim()) });
      i = close + w;
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = STANDALONE_SIDE.test(src.slice(lineStart, open)) && STANDALONE_SIDE.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' || parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// A scope is a chain of frames. The root frame holds the render's vars object (r); a loop frame binds its name (n) to
// the element (v) and `loop` to its position, built on first use.

function loopOf(f) {
  if (f.loop === null) f.loop = { index: f.k + 1, first: f.k === 0, last: f.k === f.len - 1, length: f.len };
  return f.loop;
}

function lookupFirst(scope, name) {
  for (let f = scope; f !== null; f = f.p) {
    if (f.r !== null) return Object.hasOwn(f.r, name) ? f.r[name] : undefined;
    if (name === 'loop') return loopOf(f);
    if (f.n === name) return f.v;
  }
  return undefined;
}

function lookup(scope, path) {
  let v = lookupFirst(scope, path[0]);
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Nodes compiled to a closure (scope, depth) -> text; `lib` maps template names to compiled templates. */
function compileList(nodes, lib) {
  const fns = nodes.map((n) => compileNode(n, lib));
  if (fns.length === 0) return () => '';
  if (fns.length === 1) return fns[0];
  const len = fns.length;
  return (sc, d) => {
    let o = '';
    for (let i = 0; i < len; i++) o += fns[i](sc, d);
    return o;
  };
}

function compileNode(n, lib) {
  switch (n.kind) {
    case 'text': {
      const t = n.text;
      return () => t;
    }
    case 'var': {
      const p = n.path;
      return (sc) => esc(textOf(lookup(sc, p)));
    }
    case 'raw': {
      const p = n.path;
      return (sc) => textOf(lookup(sc, p));
    }
    case 'if': {
      const p = n.path;
      const not = n.not;
      const th = compileList(n.then, lib);
      const el = n.else === null ? null : compileList(n.else, lib);
      return (sc, d) => {
        if (truthy(lookup(sc, p)) !== not) return th(sc, d);
        return el === null ? '' : el(sc, d);
      };
    }
    case 'for': {
      const p = n.path;
      const name = n.name;
      const body = compileList(n.body, lib);
      return (sc, d) => {
        const xs = lookup(sc, p);
        if (!Array.isArray(xs)) return '';
        let o = '';
        const len = xs.length;
        for (let k = 0; k < len; k++) o += body({ r: null, n: name, v: xs[k], k, len, loop: null, p: sc }, d);
        return o;
      };
    }
    case 'include': {
      const name = n.name;
      return (sc, d) => {
        const t = lib.get(name);
        return t !== undefined && d < 8 ? t(sc, d + 1) : '';
      };
    }
  }
  throw new Error(`unknown node ${n.kind}`);
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const dirOf = (path) => {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
};

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

export function build(input) {
  // Templates, in code-unit order of their names; one that does not parse is reported and left out.
  const report = [];
  const parsed = new Map();
  for (const name of Object.keys(input.templates).sort(cmp)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const lib = new Map();
  for (const [name, nodes] of parsed) lib.set(name, compileList(nodes, lib));

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources and statics.
  const files = [...input.files].sort((x, y) => cmp(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!lib.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const hit = bySource.get(path);
        if (hit !== undefined) return hit.url + frag;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // 7. Layouts.
  const output = {};
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const t = lib.get(name);
    if (t === undefined) return null;
    vars.site = site;
    vars.tags = allTags;
    vars.recent = recent;
    return t({ r: vars, p: null }, 0);
  };
  for (const s of sources) {
    const page = {
      ...(s.post ? cards.get(s) : cardOf(s)),
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(cmp);
  let nPages = 0;
  for (const s of sources) if (!s.post) nPages++;
  lines.push(`built ${nPages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** One case's answer: makefun-site's output tree for the case's site. */
export function run(input) {
  return build(input);
}
