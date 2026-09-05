/**
 * The security boundary for agent-authored HTML/CSS replicas.
 *
 * A `custom-html` section is the one place in the product where a language
 * model's output becomes markup in an administrator's browser. Everything that
 * makes that safe is here: every other layer (operations, validation, the three
 * renderers) calls into this file rather than making its own judgement.
 *
 * WHY A HAND-WRITTEN PARSER RATHER THAN A LIBRARY.
 * The instinct is to reach for DOMPurify. Three things argue against it here.
 * The input is small, server-side and produced by one known writer; the
 * allowlist is strict enough that "parse the document faithfully" is not the
 * job — "recognise the handful of shapes we permit and discard the rest" is;
 * and a sanitizer that runs in Node against a DOM shim is a second parser whose
 * disagreements with the browser's parser are exactly where sanitizer bugs
 * live. So this tokenizer is deliberately dumber than a browser and biased at
 * every ambiguity toward dropping: anything it cannot read confidently — an
 * unterminated tag, an unclosed quote, a comment with no end — takes the rest
 * of the input with it. Losing a paragraph of a replica is a bad afternoon.
 * Emitting an event handler is an incident.
 *
 * TWO KINDS OF REJECTION, AND WHY THEY ARE NOT THE SAME.
 * `dropped` is the safety rail: script, event handlers, javascript: URLs. They
 * are removed and counted, the operation still applies, and the count is
 * reported so the agent learns what it may not write.
 * `problems` is the honesty rail: form controls. A hand-written search box that
 * does not search is precisely the "never claim unsupported functionality"
 * failure the component registry exists to prevent, and unlike a broken layout
 * it looks completely convincing in a screenshot. Those reject the operation
 * outright, naming the approved component that does the job for real.
 */

/** How many distinct notes a caller is shown before the list is truncated. */
const MAX_NOTES = 20;

/**
 * Ceilings on a replica. Not security — a runaway generation that puts 4MB of
 * markup in a blueprint breaks the store, the preview and the diff, and by the
 * time anyone notices it is in the version history.
 */
const MAX_HTML = 100_000;
const MAX_CSS = 60_000;
/** Deeper than any real design band; a pathological nest is a denial of service
 * on the renderers, not a design. */
const MAX_DEPTH = 40;

/* ------------------------------------------------------------------ *
 * Allowlists
 * ------------------------------------------------------------------ */

/**
 * Tags a replica may use, lowercase key to the canonical spelling emitted.
 *
 * The mapping exists for SVG: `clipPath` is case-sensitive in the SVG DOM but
 * HTML tokenizes tag names case-insensitively, so we normalise on the way in
 * and restore the spelling on the way out rather than trusting every consumer
 * to run the browser's foreign-element adjustment table.
 */
const TAGS: Record<string, string> = Object.fromEntries(
  [
    // Structure and text
    "section", "article", "header", "footer", "aside", "nav", "div", "span", "p",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "dl", "dt", "dd",
    "a", "img", "picture", "source", "figure", "figcaption",
    "strong", "em", "b", "i", "u", "small", "blockquote", "cite", "hr", "br",
    "table", "thead", "tbody", "tr", "th", "td",
    // SVG, for icons drawn inline rather than fetched
    "svg", "path", "g", "circle", "rect", "line", "polyline", "polygon",
    "defs", "clipPath", "use", "title",
  ].map((tag) => [tag.toLowerCase(), tag]),
);

export const ALLOWED_TAGS: readonly string[] = Object.values(TAGS);

/** No end tag, and no children to skip past. */
const VOID_TAGS = new Set(["br", "hr", "img", "source"]);

/**
 * Every void element, allowed or not.
 *
 * This exists because of how a dropped element's subtree is discarded: we skip
 * forward to its end tag. `<input>` and `<link>` have no end tag, so waiting
 * for one would silently swallow the entire rest of the replica — a data-loss
 * bug that only shows up on exactly the inputs we care most about.
 */
const HTML_VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);

/** Inside `<svg>`, `<circle/>` really does close itself; in HTML `<div/>` does not. */
const SVG_TAGS = new Set([
  "svg", "path", "g", "circle", "rect", "line", "polyline", "polygon",
  "defs", "clippath", "use", "title",
]);

/**
 * Dropped along with everything inside them.
 *
 * Unwrapping these would be the classic mistake: the children of `<template>`
 * or `<noscript>` are inert where they stand and live markup once lifted out.
 */
const UNSAFE_TAGS = new Set([
  "script", "style", "link", "meta", "base", "iframe", "object", "embed",
  "applet", "canvas", "template", "slot", "noscript", "noembed", "noframes",
  "frame", "frameset", "xmp", "plaintext", "listing", "foreignobject",
]);

/** Never markup — the browser reads their content as text, so must we. */
const RAWTEXT_TAGS = new Set([
  "script", "style", "xmp", "plaintext", "noembed", "noframes", "listing",
]);

/**
 * Banned for honesty rather than safety, each with the component that does the
 * job for real. A static section must never *look* like it does something.
 */
const DISHONEST_TAGS: Record<string, string> = {
  form: 'Use "Search Jobs" (job-search), "Filter Jobs" (job-filters) or "Apply for a Job" (job-apply) — whichever the design band actually does.',
  input: 'A text box that does not search or apply is a claim this section cannot deliver. Use "Search Jobs" (job-search) for a search box, "Filter Jobs" (job-filters) for filters, or "Apply for a Job" (job-apply) for an application form.',
  textarea: 'Free-text entry belongs to an application form — use "Apply for a Job" (job-apply) or "Apply (Custom Fields)" (custom-apply).',
  select: 'A dropdown that filters nothing is a claim this section cannot deliver. Use "Filter Jobs" (job-filters).',
  option: 'Options only exist inside a control — use "Filter Jobs" (job-filters).',
  optgroup: 'Options only exist inside a control — use "Filter Jobs" (job-filters).',
  button: 'A button that does nothing when clicked reads as broken. A link styled as a button is fine — use an <a> with the button classes. For applying, use "Apply for a Job" (job-apply); for search, "Search Jobs" (job-search).',
  label: 'A label implies a control beside it. Use a heading or a <span>, or the approved component that owns the control.',
  fieldset: 'A fieldset implies a form. Use a <section> or <div> for grouping, and an approved component for the form itself.',
  legend: 'A legend implies a form. Use a heading instead.',
  datalist: 'Autocomplete is search — use "Search Jobs" (job-search).',
  output: 'A live result implies computation this section cannot do — use the approved component that produces the result.',
};

/**
 * Attributes, lowercase key to canonical spelling. Same reason as tags:
 * `viewBox` is case-sensitive to SVG and case-insensitive to the HTML parser.
 *
 * `style` is deliberately absent. Inline CSS cannot be scoped, so a replica
 * with `style="position:fixed"` would sit over the rest of the site; CSS goes
 * in the `css` field where scopeCss() can confine it.
 */
const ATTRS: Record<string, string> = Object.fromEntries(
  [
    "class", "id", "role", "alt", "src", "srcset", "sizes", "href",
    "width", "height", "colspan", "rowspan",
    "viewBox", "d", "fill", "stroke", "stroke-width",
    "cx", "cy", "r", "x", "y", "x1", "y1", "x2", "y2",
    "points", "transform", "xmlns",
  ].map((attr) => [attr.toLowerCase(), attr]),
);

export const ALLOWED_ATTRS: readonly string[] = Object.values(ATTRS);
export const DISHONEST_ELEMENTS: readonly string[] = Object.keys(DISHONEST_TAGS);

/** Attributes whose value is a URL and therefore a script vector. */
const URL_ATTRS = new Set(["href", "src", "srcset"]);

/**
 * ARIA roles that assert interactivity.
 *
 * `<div role="searchbox">` is the same dishonesty as `<input>`, and it also
 * lies to a screen reader about what pressing enter will do. The role is
 * dropped rather than the element, because unlike an `<input>` the element is
 * still perfectly good markup once the claim is removed.
 */
const INTERACTIVE_ROLES = new Set([
  "button", "checkbox", "radio", "searchbox", "textbox", "combobox", "slider",
  "switch", "spinbutton", "listbox", "option", "menuitem", "menuitemcheckbox",
  "menuitemradio", "tab", "form", "search", "link", "progressbar", "scrollbar",
]);

/* ------------------------------------------------------------------ *
 * Notes — deduplicated, counted, capped
 * ------------------------------------------------------------------ */

class Notes {
  private readonly counts = new Map<string, number>();

  add(message: string) {
    this.counts.set(message, (this.counts.get(message) ?? 0) + 1);
  }

  get size(): number {
    return this.counts.size;
  }

  /**
   * One line per distinct problem with a count, not one line per occurrence:
   * these end up in a change summary an administrator reads, and forty copies
   * of "onclick= was removed" tells them nothing the first copy did not.
   */
  list(): string[] {
    const out: string[] = [];
    for (const [message, count] of this.counts) {
      if (out.length === MAX_NOTES) {
        out.push(`…and ${this.counts.size - MAX_NOTES} other kinds of removal`);
        break;
      }
      out.push(count > 1 ? `${message} (×${count})` : message);
    }
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * Entities and URLs
 * ------------------------------------------------------------------ */

/**
 * The named entities that matter to a URL check.
 *
 * Not a full HTML entity table: this decoder exists only so that
 * `java&#115;cript:` and `javascript&colon;alert(1)` are recognised as the
 * scheme they are. Decoding too eagerly can only make the check stricter,
 * which is the direction we want to be wrong in.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", semi: ";",
  tab: "\t", newline: "\n", sol: "/", bsol: "\\", nbsp: " ", num: "#",
  lpar: "(", rpar: ")", period: ".", comma: ",", equals: "=", quest: "?",
  excl: "!", ast: "*", plus: "+", commat: "@", dollar: "$", percnt: "%",
  lsqb: "[", rsqb: "]", grave: "`", verbar: "|", lowbar: "_", hyphen: "-",
};

/** Semicolons optional on purpose — browsers forgive them, so we must too. */
const ENTITY = /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}))(;?)/g;

function decodeEntities(value: string): string {
  return value.replace(ENTITY, (match, dec, hex, name) => {
    if (dec !== undefined) return safeCodePoint(Number.parseInt(dec, 10)) ?? match;
    if (hex !== undefined) return safeCodePoint(Number.parseInt(hex, 16)) ?? match;
    const named = NAMED_ENTITIES[String(name).toLowerCase()];
    return named ?? match;
  });
}

function safeCodePoint(code: number): string | null {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null;
  // Surrogate halves are not characters; String.fromCodePoint would throw.
  if (code >= 0xd800 && code <= 0xdfff) return null;
  return String.fromCodePoint(code);
}

/**
 * The string a browser would see when deciding what scheme a URL has.
 *
 * Entities decoded, then every control character and space removed — because
 * `java\tscript:` and `java\nscript:` both navigate, and a check that trims
 * only the ends would pass both straight through.
 */
function urlProbe(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return decodeEntities(raw).replace(/[\u0000-\u0020\u007f]/g, "").toLowerCase();
}

/** `//evil.com` and `/\evil.com` both leave the site; a real path never does. */
function isSitePath(probe: string): boolean {
  return probe.startsWith("/") && !probe.startsWith("//") && !probe.startsWith("/\\");
}

function isSafeHref(raw: string): boolean {
  const probe = urlProbe(raw);
  if (probe === "" || probe === "#") return true;
  if (probe.startsWith("#")) return true;
  if (isSitePath(probe)) return true;
  if (probe.startsWith("https://")) return true;
  if (probe.startsWith("mailto:")) return true;
  return false;
}

/**
 * Image sources, per the contract: the project's own asset store, the branded
 * placeholder route, or an https CDN (which is where search_stock_images
 * returns from).
 *
 * `data:image/svg+xml` is excluded from the data: exception even though it is
 * an image type — an SVG is a document, and one loaded from a data: URL in
 * anything but an <img> executes.
 */
function isSafeImageSrc(raw: string): boolean {
  const probe = urlProbe(raw);
  if (probe === "") return false;
  if (/^\/api\/projects\/[^/]+\/assets\//.test(probe)) return true;
  if (probe.startsWith("/api/placeholder")) return true;
  if (probe.startsWith("https://")) return true;
  if (/^data:image\/(png|jpeg|jpg|gif|webp|avif);base64,/.test(probe)) return true;
  return false;
}

/** Each candidate in a srcset must pass on its own, or the whole set goes. */
function isSafeSrcset(raw: string): boolean {
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((part) => isSafeImageSrc(part.split(/\s+/)[0] ?? ""));
}

/* ------------------------------------------------------------------ *
 * Escaping
 * ------------------------------------------------------------------ */

/**
 * Matches an entity that is already well-formed.
 *
 * Used so that escaping is idempotent: `&amp;` must survive a second pass
 * unchanged, or re-sanitizing stored content (which validate.ts does) would
 * report a difference on every run.
 */
const WELL_FORMED_ENTITY = /^&(?:#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[a-zA-Z][a-zA-Z0-9]{1,31};)/;

function escapeChars(value: string, alsoQuote: boolean): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "<") out += "&lt;";
    else if (c === ">") out += "&gt;";
    else if (c === '"' && alsoQuote) out += "&quot;";
    else if (c === "&") {
      out += WELL_FORMED_ENTITY.test(value.slice(i, i + 34)) ? "&" : "&amp;";
    } else out += c;
  }
  return out;
}

const escapeText = (value: string) => escapeChars(value, false);
const escapeAttr = (value: string) => escapeChars(value, true);

/* ------------------------------------------------------------------ *
 * Tokenizer
 * ------------------------------------------------------------------ */

interface RawAttr {
  name: string;
  value: string;
}

type Token =
  | { kind: "text"; text: string }
  | { kind: "start"; name: string; attrs: RawAttr[]; selfClosing: boolean }
  | { kind: "end"; name: string };

const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

function snippet(value: string, at: number): string {
  return value.slice(at, at + 24).replace(/\s+/g, " ");
}

/**
 * Turns markup into a flat token list, or gives up.
 *
 * Giving up means dropping everything from the point of confusion to the end of
 * the input. That is harsh, and it is the right harshness: the classic
 * sanitizer bypass is markup that this parser and the browser's parser
 * disagree about, and we can only be sure of agreeing on the part we could read
 * unambiguously.
 */
function tokenize(input: string, notes: Notes): Token[] {
  const tokens: Token[] = [];
  let text = "";
  let i = 0;

  const flushText = () => {
    if (text) {
      tokens.push({ kind: "text", text });
      text = "";
    }
  };

  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      text += input.slice(i);
      break;
    }
    text += input.slice(i, lt);
    const next = input[lt + 1] ?? "";

    // Comments are removed wholesale, never unwrapped: `<!-- <img
    // src=x onerror=1> -->` is markup one stray `--` away from being live, and
    // conditional comments were an entire bypass family of their own.
    if (input.startsWith("<!--", lt)) {
      let end: number;
      if (input.startsWith(">", lt + 4)) end = lt + 5;
      else if (input.startsWith("->", lt + 4)) end = lt + 6;
      else {
        const close = input.indexOf("-->", lt + 4);
        if (close === -1) {
          notes.add("an unterminated HTML comment — everything after it was dropped");
          i = input.length;
          break;
        }
        end = close + 3;
      }
      notes.add("an HTML comment (comments can hide markup, so they are removed)");
      i = end;
      continue;
    }

    if (input.startsWith("<![CDATA[", lt)) {
      const close = input.indexOf("]]>", lt);
      notes.add("a CDATA section");
      if (close === -1) {
        i = input.length;
        break;
      }
      i = close + 3;
      continue;
    }

    // Doctypes and processing instructions: a browser treats these as bogus
    // comments ending at the first ">", and so do we.
    if (next === "!" || next === "?") {
      const close = input.indexOf(">", lt);
      notes.add(`a doctype or processing instruction ("${snippet(input, lt)}")`);
      if (close === -1) {
        i = input.length;
        break;
      }
      i = close + 1;
      continue;
    }

    if (next === "/") {
      const name = readTagName(input, lt + 2);
      if (!name) {
        // `</ >` — a bogus end tag. Skip to the ">" like a browser does.
        const close = input.indexOf(">", lt);
        if (close === -1) {
          notes.add("markup that ends mid-tag — everything from there was dropped");
          i = input.length;
          break;
        }
        i = close + 1;
        continue;
      }
      const after = skipToTagEnd(input, lt + 2 + name.length);
      if (after === null) {
        notes.add(`an unterminated </${name.toLowerCase()}> — everything from there was dropped`);
        i = input.length;
        break;
      }
      flushText();
      tokens.push({ kind: "end", name: name.toLowerCase() });
      i = after;
      continue;
    }

    if (!/[a-zA-Z]/.test(next)) {
      // A bare "<" in prose. Not a tag to anyone, including the browser.
      text += "<";
      i = lt + 1;
      continue;
    }

    const parsed = parseStartTag(input, lt);
    if (!parsed) {
      notes.add(
        `markup that ends mid-tag ("${snippet(input, lt)}") — everything from there was dropped`,
      );
      i = input.length;
      break;
    }
    flushText();
    tokens.push(parsed.token);
    i = parsed.next;

    // Raw text elements never contain markup. Reading their content as markup
    // is how `<script>if (a<b)…</script>` turns into a phantom <b> element, so
    // the content is skipped here rather than tokenized and dropped later.
    const lower = parsed.token.name;
    if (RAWTEXT_TAGS.has(lower) && !parsed.token.selfClosing) {
      const close = findRawTextEnd(input, i, lower);
      if (close === null) {
        i = input.length;
        break;
      }
      i = close;
    }
  }

  flushText();
  return tokens;
}

function readTagName(input: string, from: number): string {
  if (!/[a-zA-Z]/.test(input[from] ?? "")) return "";
  let i = from;
  while (i < input.length && !isSpace(input[i]) && input[i] !== "/" && input[i] !== ">") i++;
  return input.slice(from, i);
}

/** Walks past an end tag's ignored attributes, honouring quotes. */
function skipToTagEnd(input: string, from: number): number | null {
  let i = from;
  let quote = "";
  while (i < input.length) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i + 1;
    }
    i++;
  }
  return null;
}

function findRawTextEnd(input: string, from: number, name: string): number | null {
  const lower = input.toLowerCase();
  const close = lower.indexOf(`</${name}`, from);
  if (close === -1) return null;
  const end = input.indexOf(">", close);
  return end === -1 ? null : end + 1;
}

/**
 * Parses one start tag, or returns null if it cannot be read to its end.
 *
 * The two cases that defeat naive sanitizers are both handled by reading
 * character by character rather than by regex: a quoted attribute value
 * containing ">" does not end the tag, and an unquoted value ends only at
 * whitespace or ">".
 */
function parseStartTag(
  input: string,
  lt: number,
): { token: Extract<Token, { kind: "start" }>; next: number } | null {
  const name = readTagName(input, lt + 1);
  if (!name) return null;
  let i = lt + 1 + name.length;
  const attrs: RawAttr[] = [];
  let selfClosing = false;

  while (i < input.length) {
    // A solidus here is the browser's "before attribute name" state, which is
    // why `<img/src=x/onerror=y>` is three tokens to a browser and must be
    // three to us.
    while (i < input.length && (isSpace(input[i]) || input[i] === "/")) {
      selfClosing = input[i] === "/";
      i++;
    }
    if (i >= input.length) return null;
    if (input[i] === ">") {
      i++;
      return { token: { kind: "start", name: name.toLowerCase(), attrs, selfClosing }, next: i };
    }

    selfClosing = false;
    const nameStart = i;
    while (
      i < input.length &&
      !isSpace(input[i]) &&
      input[i] !== "=" &&
      input[i] !== ">" &&
      input[i] !== "/"
    ) {
      i++;
    }
    const attrName = input.slice(nameStart, i);
    if (!attrName) {
      // Nothing consumed and not at ">": a shape we do not understand.
      return null;
    }

    let j = i;
    while (j < input.length && isSpace(input[j])) j++;
    let value = "";
    if (input[j] === "=") {
      j++;
      while (j < input.length && isSpace(input[j])) j++;
      const q = input[j];
      if (q === '"' || q === "'") {
        const close = input.indexOf(q, j + 1);
        // An unclosed quote swallows the rest of the document in a browser too.
        // Neither of us can tell where the tag ends, so nothing after it ships.
        if (close === -1) return null;
        value = input.slice(j + 1, close);
        j = close + 1;
      } else {
        const valueStart = j;
        while (j < input.length && !isSpace(input[j]) && input[j] !== ">") j++;
        value = input.slice(valueStart, j);
      }
      i = j;
    }
    // Otherwise it is a boolean attribute: `i` already sits after the name and
    // the loop's whitespace skip handles the gap.

    attrs.push({ name: attrName, value });
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Serialisation against the allowlists
 * ------------------------------------------------------------------ */

function attributesFor(
  tagLower: string,
  attrs: RawAttr[],
  notes: Notes,
): string {
  let out = "";
  const seen = new Set<string>();

  for (const attr of attrs) {
    const lower = attr.name.toLowerCase();

    // Browsers keep the first of a repeated attribute. A sanitizer that keeps
    // the last one can be talked into validating the harmless copy and
    // emitting the other.
    if (seen.has(lower)) {
      notes.add(`a repeated ${lower}= on <${tagLower}> (only the first is kept)`);
      continue;
    }
    seen.add(lower);

    if (lower.startsWith("on")) {
      notes.add(`${lower}= on <${tagLower}> — event handlers are never allowed in a replica`);
      continue;
    }
    if (lower === "style") {
      notes.add(
        `style= on <${tagLower}> — inline CSS cannot be scoped; put it in the section's css field`,
      );
      continue;
    }

    const isAria = lower.startsWith("aria-") && /^aria-[a-z]+$/.test(lower);
    const canonical = isAria ? lower : ATTRS[lower];
    if (!canonical) {
      notes.add(`${lower}= on <${tagLower}> — not an allowed attribute`);
      continue;
    }

    if (URL_ATTRS.has(lower)) {
      const ok =
        lower === "href"
          ? isSafeHref(attr.value)
          : lower === "srcset"
            ? isSafeSrcset(attr.value)
            : isSafeImageSrc(attr.value);
      if (!ok) {
        notes.add(
          lower === "href"
            ? `href="${snippet(attr.value, 0)}" on <${tagLower}> — links may only be #, /a-site-path, https: or mailto:`
            : `${lower}="${snippet(attr.value, 0)}" on <${tagLower}> — images must come from the project's assets, /api/placeholder, or an https URL returned by search_stock_images`,
        );
        continue;
      }
    }

    if (lower === "role" && INTERACTIVE_ROLES.has(attr.value.trim().toLowerCase())) {
      notes.add(
        `role="${attr.value.trim().toLowerCase()}" on <${tagLower}> — a static replica must not announce itself as a control`,
      );
      continue;
    }

    out += ` ${canonical}="${escapeAttr(attr.value)}"`;
  }
  return out;
}

/**
 * Rebuilds markup from tokens, keeping only what the allowlists permit.
 *
 * Unknown-but-harmless tags (`<main>`, `<video>`) are unwrapped rather than
 * dropped with their contents — the tag is gone either way, and their children
 * are re-checked by this same loop, so keeping the copy costs nothing. The
 * enumerated dangerous and dishonest tags take their subtree with them,
 * because for those the content is the problem.
 */
function build(tokens: Token[], notes: Notes, problems: Notes): string {
  const out: string[] = [];
  /** Canonical names of elements we have emitted an open tag for. */
  const open: string[] = [];
  let svgDepth = 0;
  /** Set while discarding a subtree: the tag we are waiting to see close. */
  let skipping = "";
  let skipDepth = 0;

  for (const token of tokens) {
    if (skipDepth > 0) {
      if (
        token.kind === "start" &&
        token.name === skipping &&
        !token.selfClosing &&
        !HTML_VOID.has(token.name)
      ) {
        skipDepth++;
      }
      else if (token.kind === "end" && token.name === skipping) skipDepth--;
      continue;
    }

    if (token.kind === "text") {
      out.push(escapeText(token.text));
      continue;
    }

    if (token.kind === "end") {
      const canonical = TAGS[token.name];
      const at = canonical ? open.lastIndexOf(canonical) : -1;
      if (at === -1) continue; // Stray close tag; the browser ignores it too.
      // Close everything it implicitly closes, so the output is well formed
      // even when the input was not.
      for (let k = open.length - 1; k >= at; k--) {
        out.push(`</${open[k]}>`);
        if (open[k] === "svg") svgDepth--;
      }
      open.length = at;
      continue;
    }

    const lower = token.name;
    const dishonest = DISHONEST_TAGS[lower];
    if (dishonest) {
      problems.add(
        `<${lower}> is not allowed in a replica. ${dishonest}`,
      );
      if (!token.selfClosing && !HTML_VOID.has(lower)) {
        skipping = lower;
        skipDepth = 1;
      }
      continue;
    }

    if (UNSAFE_TAGS.has(lower)) {
      notes.add(`<${lower}> and everything inside it`);
      if (!token.selfClosing && !RAWTEXT_TAGS.has(lower) && !HTML_VOID.has(lower)) {
        skipping = lower;
        skipDepth = 1;
      }
      continue;
    }

    const canonical = TAGS[lower];
    if (!canonical) {
      // Unwrap: drop the tag, keep the words.
      notes.add(`<${lower}> — not an allowed tag (its contents were kept)`);
      continue;
    }

    if (open.length >= MAX_DEPTH) {
      notes.add(`markup nested deeper than ${MAX_DEPTH} elements`);
      continue;
    }

    const attrs = attributesFor(lower, token.attrs, notes);
    const inSvg = svgDepth > 0 || lower === "svg";
    const closesItself = VOID_TAGS.has(lower) || (inSvg && token.selfClosing);

    if (closesItself) {
      out.push(inSvg && !VOID_TAGS.has(lower) ? `<${canonical}${attrs} />` : `<${canonical}${attrs}>`);
      continue;
    }
    out.push(`<${canonical}${attrs}>`);
    open.push(canonical);
    if (lower === "svg") svgDepth++;
  }

  for (let k = open.length - 1; k >= 0; k--) out.push(`</${open[k]}>`);
  return out.join("");
}

export interface SanitizeHtmlResult {
  html: string;
  /** Unsafe or unsupported things removed. Safe to proceed; worth reporting. */
  dropped: string[];
  /** Dishonest elements. The caller must refuse the change. */
  problems: string[];
}

/**
 * Sanitizes replica markup against the tag and attribute allowlists.
 *
 * Idempotent: sanitizing the output again returns it unchanged with nothing
 * dropped, which is what lets validate.ts use a second pass as proof that
 * stored content went through the first one.
 */
export function sanitizeHtml(html: string): SanitizeHtmlResult {
  const notes = new Notes();
  const problems = new Notes();
  if (typeof html !== "string") {
    return { html: "", dropped: [], problems: ["content.html must be a string of markup"] };
  }
  const tokens = tokenize(html, notes);
  const out = build(tokens, notes, problems);
  return { html: out, dropped: notes.list(), problems: problems.list() };
}

/* ------------------------------------------------------------------ *
 * CSS scoping
 * ------------------------------------------------------------------ */

/** Nested rule lists we walk into and scope. Anything else is dropped. */
const NESTING_AT_RULES = new Set(["media", "supports", "container", "layer", "scope"]);
const KEYFRAME_AT_RULES = new Set(["keyframes", "-webkit-keyframes", "-moz-keyframes"]);

/**
 * Removes comments without being fooled by strings.
 *
 * `content: "/*"` is legal CSS, and a regex that strips comments would eat
 * from there to the next `*` + `/` anywhere in the file — quietly merging two
 * unrelated rules into one.
 */
function stripCssComments(css: string): string {
  let out = "";
  let i = 0;
  let quote = "";
  while (i < css.length) {
    const c = css[i];
    if (quote) {
      out += c;
      if (c === "\\" && i + 1 < css.length) {
        out += css[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) quote = "";
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && css[i + 1] === "*") {
      const close = css.indexOf("*/", i + 2);
      // An unterminated comment comments out the rest of the file; that is what
      // a browser does with it, so discarding the remainder matches.
      if (close === -1) return out;
      out += " ";
      i = close + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Splits on a separator that is not inside quotes, parens or brackets. */
function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      current += c;
      if (c === "\\" && i + 1 < value.length) {
        current += value[++i];
        continue;
      }
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    if (c === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts;
}

function indexOfTopLevel(value: string, char: string): number {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (c === char && depth === 0) return i;
  }
  return -1;
}

/** Reads a `{ … }` block, returning its contents and the index after it. */
function readBlock(css: string, at: number): { body: string; next: number; closed: boolean } {
  let depth = 0;
  let quote = "";
  for (let i = at; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { body: css.slice(at + 1, i), next: i + 1, closed: true };
    }
  }
  return { body: css.slice(at + 1), next: css.length, closed: false };
}

function isUrlSafeInCss(raw: string): boolean {
  const value = raw.trim().replace(/^["']|["']$/g, "");
  const probe = urlProbe(value);
  if (probe === "") return false;
  if (probe.startsWith("https://")) return true;
  if (isSitePath(probe)) return true;
  if (/^data:image\/(png|jpeg|jpg|gif|webp|avif);base64,/.test(probe)) return true;
  return false;
}

/**
 * Filters one block of declarations.
 *
 * Declarations are dropped individually rather than taking their rule with
 * them: one bad `position: fixed` in a twenty-line card style should cost the
 * one line, not the card.
 */
function scopeDeclarations(body: string, notes: Notes): string {
  const kept: string[] = [];
  for (const raw of splitTopLevel(body, ";")) {
    const decl = raw.trim();
    if (!decl) continue;
    // A nested block that reached here is something we do not model.
    if (decl.includes("{")) {
      notes.add(`a nested CSS block that could not be read: "${snippet(decl, 0)}"`);
      continue;
    }
    const colon = indexOfTopLevel(decl, ":");
    if (colon <= 0) {
      notes.add(`a CSS declaration that could not be read: "${snippet(decl, 0)}"`);
      continue;
    }
    const property = decl.slice(0, colon).trim();
    const value = decl.slice(colon + 1).trim();
    const prop = property.toLowerCase();
    const val = value.toLowerCase();

    // The scoped CSS is injected into a <style> element by every renderer, so
    // a stray "</style" in a declaration would close it and start a document.
    if (decl.includes("<")) {
      notes.add(`a CSS declaration containing "<": "${snippet(decl, 0)}"`);
      continue;
    }
    if (!/^(?:--[\w-]+|-{0,2}[a-zA-Z][\w-]*)$/.test(property)) {
      notes.add(`a CSS property that could not be read: "${snippet(property, 0)}"`);
      continue;
    }
    // position: fixed escapes the section's box entirely and would sit over the
    // library components around it — the one thing scoping exists to prevent.
    if (prop === "position" && /\bfixed\b/.test(val)) {
      notes.add("position: fixed — a replica may not float above the rest of the page");
      continue;
    }
    if (prop === "behavior" || prop === "-moz-binding" || val.includes("expression(")) {
      notes.add(`${prop} — legacy CSS that can execute script`);
      continue;
    }
    const urls = value.match(/url\(([^)]*)\)/gi) ?? [];
    const badUrl = urls.some((u) => !isUrlSafeInCss(u.slice(4, -1)));
    if (badUrl) {
      notes.add(
        `${prop} with a url() that is not https, a site path or an inline image: "${snippet(value, 0)}"`,
      );
      continue;
    }
    kept.push(`${property}: ${value}`);
  }
  return kept.join("; ");
}

/**
 * Prefixes one selector so it cannot match anything outside this section.
 *
 * Returns null when the selector is one the contract refuses.
 */
function scopeSelector(selector: string, prefix: string, notes: Notes): string | null {
  const trimmed = selector.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  if (trimmed.includes("<")) {
    notes.add(`a selector containing "<": "${snippet(trimmed, 0)}"`);
    return null;
  }
  // Nesting selectors would resolve against a parent we are not modelling.
  if (trimmed.startsWith("&")) {
    notes.add(`a nested "&" selector: "${snippet(trimmed, 0)}"`);
    return null;
  }
  // Already scoped: this is what makes a second pass a no-op, so validate.ts
  // can re-run the sanitizer as a check rather than as an edit.
  if (trimmed.startsWith(prefix)) return trimmed;

  const first = firstCompound(trimmed).toLowerCase();
  if (/^(?:html|body)(?![\w-])/.test(first) || first.startsWith(":root")) {
    notes.add(
      `"${snippet(trimmed, 0)}" targets the whole page — a replica may only style itself`,
    );
    return null;
  }
  if (first === "*" || /^\*(?![.#[])/.test(first)) {
    notes.add(
      `"${snippet(trimmed, 0)}" is a universal rule — name the elements inside the section instead`,
    );
    return null;
  }
  return `${prefix} ${trimmed}`;
}

/** The part of a selector before the first combinator. */
function firstCompound(selector: string): string {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (isSpace(c) || c === ">" || c === "+" || c === "~" || c === ",")) {
      return selector.slice(0, i);
    }
  }
  return selector;
}

interface CssWalk {
  prefix: string;
  /** The bare id, used to namespace keyframe names. */
  prefixId: string;
  notes: Notes;
  /** Keyframe names already renamed, so declarations can be rewritten to match. */
  renamed: Map<string, string>;
}

/**
 * Walks a rule list, scoping every selector it contains.
 *
 * `mode: "keyframes"` exists because the "selectors" inside @keyframes are
 * percentages and `from`/`to` — prefixing those would produce a stylesheet that
 * parses and animates nothing.
 */
function walkRules(css: string, walk: CssWalk, mode: "rules" | "keyframes"): string {
  const out: string[] = [];
  let i = 0;

  while (i < css.length) {
    while (i < css.length && isSpace(css[i])) i++;
    if (i >= css.length) break;
    if (css[i] === "}") {
      i++;
      continue;
    }

    if (css[i] === "@" && mode === "rules") {
      const stop = nextTopLevel(css, i, "{;");
      const prelude = css.slice(i, stop === -1 ? css.length : stop).trim();
      const name = (prelude.match(/^@([-\w]+)/)?.[1] ?? "").toLowerCase();

      if (stop === -1 || css[stop] === ";") {
        // @import pulls in a stylesheet we never see and cannot scope; @charset
        // and @namespace are document-level statements a section does not own.
        walk.notes.add(`@${name} — a replica may not load or declare stylesheet-level rules`);
        i = stop === -1 ? css.length : stop + 1;
        continue;
      }

      const block = readBlock(css, stop);
      if (!block.closed) walk.notes.add("a CSS block that was never closed");

      if (NESTING_AT_RULES.has(name)) {
        const inner = walkRules(block.body, walk, "rules");
        if (inner.trim()) out.push(`${prelude} { ${inner} }`);
        i = block.next;
        continue;
      }
      if (KEYFRAME_AT_RULES.has(name)) {
        // Keyframe names are global. A replica animation called "fade" would
        // silently redefine the site's own "fade", so each is namespaced and
        // the declarations that reference it are rewritten below.
        const original = prelude.replace(/^@[-\w]+\s*/, "").trim();
        if (!/^[\w-]+$/.test(original)) {
          walk.notes.add(`@${name} with an unreadable name: "${snippet(prelude, 0)}"`);
          i = block.next;
          continue;
        }
        const scoped = `${walk.prefixId}-${original}`;
        walk.renamed.set(original, scoped);
        const inner = walkRules(block.body, walk, "keyframes");
        if (inner.trim()) out.push(`@${name} ${scoped} { ${inner} }`);
        i = block.next;
        continue;
      }
      // @font-face loads a font from somewhere we cannot vouch for, and
      // anything else here is an at-rule this contract never agreed to.
      walk.notes.add(`@${name} — not an at-rule a replica may use`);
      i = block.next;
      continue;
    }

    const stop = nextTopLevel(css, i, "{");
    if (stop === -1) {
      const rest = css.slice(i).trim();
      if (rest) walk.notes.add(`CSS with no rule body: "${snippet(rest, 0)}"`);
      break;
    }
    const preludeRaw = css.slice(i, stop);
    const block = readBlock(css, stop);
    if (!block.closed) walk.notes.add("a CSS block that was never closed");

    const declarations = scopeDeclarations(block.body, walk.notes);
    if (!declarations) {
      i = block.next;
      continue;
    }

    if (mode === "keyframes") {
      const steps = preludeRaw.trim();
      if (!/^(?:from|to|-?\d+(?:\.\d+)?%)(?:\s*,\s*(?:from|to|-?\d+(?:\.\d+)?%))*$/i.test(steps)) {
        walk.notes.add(`a keyframe step that could not be read: "${snippet(steps, 0)}"`);
        i = block.next;
        continue;
      }
      out.push(`${steps} { ${declarations} }`);
      i = block.next;
      continue;
    }

    const selectors = splitTopLevel(preludeRaw, ",")
      .map((s) => scopeSelector(s, walk.prefix, walk.notes))
      .filter((s): s is string => s !== null);
    if (selectors.length > 0) out.push(`${selectors.join(", ")} { ${declarations} }`);
    i = block.next;
  }

  return out.join("\n");
}

/** Index of the first of `chars` outside quotes, parens and brackets. */
function nextTopLevel(css: string, from: number, chars: string): number {
  let depth = 0;
  let quote = "";
  for (let i = from; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && chars.includes(c)) return i;
  }
  return -1;
}

export interface ScopeCssResult {
  css: string;
  dropped: string[];
}

/**
 * Confines a replica's CSS to its own section.
 *
 * Every selector is prefixed with the section's `data-section-id`, so the
 * strongest thing a replica can do to the rest of the page is nothing. This is
 * the counterpart to the tag allowlist: markup cannot execute, and CSS cannot
 * reach out of its box.
 *
 * Idempotent for the same section id — an already-scoped selector is passed
 * through untouched, which is what lets validation re-run it as a check.
 */
export function scopeCss(css: string, sectionId: string): ScopeCssResult {
  const notes = new Notes();
  if (typeof css !== "string" || !css.trim()) return { css: "", dropped: [] };
  // The id becomes part of an attribute selector; anything but a slug is
  // refused rather than escaped, because there is no legitimate section id
  // that needs escaping.
  if (!/^[a-zA-Z0-9][\w-]*$/.test(sectionId)) {
    return { css: "", dropped: [`"${sectionId}" is not a usable section id, so no CSS was kept`] };
  }
  const prefix = `[data-section-id="${sectionId}"]`;
  const walk: CssWalk = {
    prefix,
    prefixId: sectionId,
    notes,
    renamed: new Map(),
  };
  let out = walkRules(stripCssComments(css), walk, "rules");

  // Animation shorthand and animation-name reference the keyframe names that
  // were namespaced above; without this rewrite the animation silently stops.
  for (const [original, scoped] of walk.renamed) {
    out = out.replace(
      new RegExp(`(animation(?:-name)?\\s*:[^;}]*?)\\b${escapeRegExp(original)}\\b`, "gi"),
      (_m, head: string) => `${head}${scoped}`,
    );
  }
  return { css: out, dropped: notes.list() };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------------ *
 * The one call the rest of the system makes
 * ------------------------------------------------------------------ */

export interface CustomHtmlCredit {
  text: string;
  url: string;
}

export interface SanitizeCustomHtmlResult {
  /** The content to store: sanitized markup, scoped CSS, checked credits. */
  content: Record<string, unknown>;
  /** Dishonesty and malformed input. The caller must refuse the operation. */
  problems: string[];
  /** Unsafe or unsupported things removed. Report, but proceed. */
  dropped: string[];
}

/**
 * Sanitizes a whole `custom-html` section's content.
 *
 * Called by operations.ts before anything is stored and by validate.ts as a
 * check that it was. The renderers sanitize again at render time — not because
 * this is untrusted, but because a blueprint can arrive from an import, a
 * restore or a future code path that has not been written yet, and "the last
 * thing before the browser also checks" is the only version of this that
 * survives someone adding a new writer.
 */
export function sanitizeCustomHtml(
  sectionId: string,
  content: unknown,
): SanitizeCustomHtmlResult {
  const problems: string[] = [];
  const dropped: string[] = [];

  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    return {
      content: {},
      problems: ["a custom-html section's content must be an object with html and css"],
      dropped: [],
    };
  }

  const source = content as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // Anything the renderer does not read is inert data; carrying it through
  // means an update_section that touches only `note` does not erase it.
  for (const [key, value] of Object.entries(source)) {
    if (!["html", "css", "credits", "note"].includes(key)) out[key] = value;
  }

  const rawHtml = source["html"];
  if (rawHtml !== undefined && typeof rawHtml !== "string") {
    problems.push("content.html must be a string of markup");
  } else if (typeof rawHtml === "string" && rawHtml.length > MAX_HTML) {
    problems.push(
      `content.html is ${rawHtml.length} characters; the limit is ${MAX_HTML}. Replicate one design band, not a whole page.`,
    );
  } else {
    const html = typeof rawHtml === "string" ? rawHtml : "";
    if (!html.trim()) {
      problems.push(
        "content.html is empty — a custom-html section with no markup renders nothing. Give it the replica markup, or use record_unsupported if the band carries nothing.",
      );
    }
    const sanitized = sanitizeHtml(html);
    problems.push(...sanitized.problems);
    dropped.push(...sanitized.dropped);
    out["html"] = sanitized.html;
  }

  const rawCss = source["css"];
  if (rawCss !== undefined && typeof rawCss !== "string") {
    problems.push("content.css must be a string of CSS");
  } else if (typeof rawCss === "string" && rawCss.length > MAX_CSS) {
    problems.push(`content.css is ${rawCss.length} characters; the limit is ${MAX_CSS}.`);
  } else {
    const scoped = scopeCss(typeof rawCss === "string" ? rawCss : "", sectionId);
    dropped.push(...scoped.dropped);
    out["css"] = scoped.css;
  }

  // Both stock licences require attribution wherever the photograph is shown,
  // so credits are content the renderer displays, not metadata.
  const rawCredits = source["credits"];
  if (rawCredits !== undefined) {
    if (!Array.isArray(rawCredits)) {
      problems.push("content.credits must be a list of { text, url } entries");
    } else {
      const credits: CustomHtmlCredit[] = [];
      for (const entry of rawCredits) {
        if (typeof entry !== "object" || entry === null) {
          dropped.push("a credit entry that was not { text, url }");
          continue;
        }
        const record = entry as Record<string, unknown>;
        const text = typeof record["text"] === "string" ? record["text"].trim() : "";
        const url = typeof record["url"] === "string" ? record["url"].trim() : "";
        if (!text) {
          dropped.push("a credit with no attribution text");
          continue;
        }
        if (url && !isSafeHref(url)) {
          dropped.push(`a credit link that is not an https URL: "${snippet(url, 0)}"`);
          credits.push({ text, url: "" });
          continue;
        }
        credits.push({ text, url });
      }
      if (credits.length > 0) out["credits"] = credits;
    }
  }

  const rawNote = source["note"];
  if (rawNote !== undefined) {
    if (typeof rawNote !== "string") {
      dropped.push("content.note was not a string");
    } else if (rawNote.trim()) {
      out["note"] = rawNote.trim().slice(0, 300);
    }
  }

  return { content: out, problems, dropped };
}

/**
 * True when a replica shows photography that needs an attribution line.
 *
 * Images served from the project's own asset store are the company's own
 * uploads and need nothing; stock and CDN images carry a licence that requires
 * the credit to be visible, which is why this asks where the image came from
 * rather than merely whether there is one.
 */
export function needsImageCredit(html: string): boolean {
  if (typeof html !== "string") return false;
  const sources = html.match(/<img\b[^>]*\bsrc\s*=\s*"([^"]*)"/gi) ?? [];
  return sources.some((tag) => {
    const url = tag.match(/src\s*=\s*"([^"]*)"/i)?.[1] ?? "";
    const probe = urlProbe(url);
    return !probe.startsWith("/api/");
  });
}
