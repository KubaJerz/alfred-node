// Notion speaks blocks; Alfred speaks markdown. Neither the API nor Alfred has a
// markdown endpoint, so this is the translation layer both directions of every
// read and write pass through.
//
// The block vocabulary here is deliberately a subset — paragraph, the three
// heading levels, bulleted/numbered/to-do list items, code, quote, divider.
// It's the set that covers a note Alfred writes and the pages Kuba keeps as
// prose. Anything outside it survives a read as a visible `*[type]*` marker
// rather than vanishing, because a page that silently loses its tables reads as
// a shorter page, not a lossy one — the same reasoning that keeps a withheld
// email visible as a marker instead of dropping out of the list.

// Notion caps a single rich-text object's content at 2000 characters. A longer
// run has to be split across several objects or the API rejects the whole write.
const RICH_TEXT_LIMIT = 2000;

function textNode(content, annotations, url) {
  const node = { type: "text", text: { content } };
  if (url) node.text.link = { url };
  if (annotations && Object.keys(annotations).length) node.annotations = annotations;
  return node;
}

// One text object per matched span, split again if any span is over the limit.
function chunk(nodes) {
  const out = [];
  for (const node of nodes) {
    const c = node.text.content;
    if (c.length <= RICH_TEXT_LIMIT) {
      out.push(node);
      continue;
    }
    for (let i = 0; i < c.length; i += RICH_TEXT_LIMIT) {
      out.push({ ...node, text: { ...node.text, content: c.slice(i, i + RICH_TEXT_LIMIT) } });
    }
  }
  return out;
}

// Inline markers, matched by whichever starts earliest so `**a** *b*` doesn't
// mis-pair. Code is a rule like the others but its content is never re-parsed —
// a regex that matches `code` first and recurses on the remainder gives that for
// free, since the matched span is consumed whole.
const INLINE = [
  { re: /`([^`]+)`/, ann: { code: true } },
  { re: /\*\*([^*]+)\*\*/, ann: { bold: true } },
  { re: /~~([^~]+)~~/, ann: { strikethrough: true } },
  { re: /\*([^*]+)\*/, ann: { italic: true } },
  { re: /\[([^\]]+)\]\(([^)]+)\)/, link: true },
];

export function markdownToRichText(md) {
  if (!md) return [];
  let earliest = null;
  for (const rule of INLINE) {
    const m = rule.re.exec(md);
    if (m && (earliest === null || m.index < earliest.m.index)) earliest = { rule, m };
  }
  if (!earliest) return chunk([textNode(md)]);

  const { rule, m } = earliest;
  const out = [];
  if (m.index > 0) out.push(textNode(md.slice(0, m.index)));
  out.push(rule.link ? textNode(m[1], null, m[2]) : textNode(m[1], rule.ann));
  out.push(...markdownToRichText(md.slice(m.index + m[0].length)));
  return chunk(out);
}

// A rich-text array back to markdown. Wrapping order is the inverse of parsing:
// code sits innermost (its content is literal), then the emphases, then a link
// wraps the lot, so `[**x**](url)` round-trips rather than `**[x](url)**`.
export function richTextToMarkdown(richText) {
  return (richText || [])
    .map((seg) => {
      let t = seg.plain_text ?? seg.text?.content ?? "";
      const a = seg.annotations || {};
      if (a.code) t = `\`${t}\``;
      if (a.bold) t = `**${t}**`;
      if (a.italic) t = `*${t}*`;
      if (a.strikethrough) t = `~~${t}~~`;
      const url = seg.href ?? seg.text?.link?.url;
      if (url) t = `[${t}](${url})`;
      return t;
    })
    .join("");
}

const rt = (md) => markdownToRichText(md);

// One markdown line → one block. Line-based rather than paragraph-based on
// purpose: Notion's unit is the block, and mapping each line to its own block is
// what makes a pasted list come out as a list instead of one run-on paragraph.
function lineToBlock(line) {
  let m;
  if ((m = /^#\s+(.*)$/.exec(line))) return { type: "heading_1", heading_1: { rich_text: rt(m[1]) } };
  if ((m = /^##\s+(.*)$/.exec(line))) return { type: "heading_2", heading_2: { rich_text: rt(m[1]) } };
  if ((m = /^###\s+(.*)$/.exec(line))) return { type: "heading_3", heading_3: { rich_text: rt(m[1]) } };
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) return { type: "divider", divider: {} };
  if ((m = /^>\s?(.*)$/.exec(line))) return { type: "quote", quote: { rich_text: rt(m[1]) } };
  if ((m = /^[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line)))
    return { type: "to_do", to_do: { checked: m[1].toLowerCase() === "x", rich_text: rt(m[2]) } };
  if ((m = /^[-*]\s+(.*)$/.exec(line)))
    return { type: "bulleted_list_item", bulleted_list_item: { rich_text: rt(m[1]) } };
  if ((m = /^\d+\.\s+(.*)$/.exec(line)))
    return { type: "numbered_list_item", numbered_list_item: { rich_text: rt(m[1]) } };
  return { type: "paragraph", paragraph: { rich_text: rt(line) } };
}

/**
 * Markdown → an array of Notion block objects, ready for pages.create children
 * or blocks.children.append. Blank lines are separators, not blocks. A fenced
 * ```lang block is collected whole so its contents aren't parsed as markdown.
 */
export function markdownToBlocks(md) {
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      const language = normalizeLanguage(fence[1].trim());
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      blocks.push({
        type: "code",
        code: { language, rich_text: chunk([textNode(body.join("\n"))]) },
      });
      continue;
    }
    if (line.trim() === "") continue;
    blocks.push(lineToBlock(line));
  }
  return blocks;
}

// Notion's code language is an enum; "text"/"" isn't a member, "plain text" is.
function normalizeLanguage(lang) {
  if (!lang || /^(text|txt|plain)$/i.test(lang)) return "plain text";
  return lang.toLowerCase();
}

const LIST_TYPES = new Set(["bulleted_list_item", "numbered_list_item", "to_do"]);

function renderBlock(b, n) {
  const text = (key) => richTextToMarkdown(b[key]?.rich_text);
  switch (b.type) {
    case "paragraph": return text("paragraph");
    case "heading_1": return `# ${text("heading_1")}`;
    case "heading_2": return `## ${text("heading_2")}`;
    case "heading_3": return `### ${text("heading_3")}`;
    case "bulleted_list_item": return `- ${text("bulleted_list_item")}`;
    case "numbered_list_item": return `${n}. ${text("numbered_list_item")}`;
    case "to_do": return `- [${b.to_do?.checked ? "x" : " "}] ${text("to_do")}`;
    case "quote": return `> ${text("quote")}`;
    case "divider": return "---";
    case "code": {
      const lang = b.code?.language && b.code.language !== "plain text" ? b.code.language : "";
      return "```" + lang + "\n" + richTextToMarkdown(b.code?.rich_text) + "\n```";
    }
    // child_page/child_database are references, not prose — render the title as a
    // line so the structure is visible without pretending to have inlined it.
    case "child_page": return `- 📄 ${b.child_page?.title || "(untitled)"}`;
    case "child_database": return `- 🗂 ${b.child_database?.title || "(untitled)"}`;
    default: return `*[${b.type}]*`;
  }
}

function indentLines(md, pad) {
  return md.split("\n").map((l) => (l ? pad + l : l)).join("\n");
}

/**
 * An array of Notion block objects → markdown. Children (attached as `.children`
 * by the caller that fetched them) render indented under their parent. Numbered
 * lists count within a contiguous run and reset when the run breaks.
 */
export function blocksToMarkdown(blocks) {
  const parts = [];
  let n = 0;
  (blocks || []).forEach((b, i) => {
    if (b.type === "numbered_list_item") {
      n = blocks[i - 1]?.type === "numbered_list_item" ? n + 1 : 1;
    }
    let md = renderBlock(b, n);
    if (b.children?.length) md += "\n" + indentLines(blocksToMarkdown(b.children), "  ");
    parts.push({ type: b.type, md });
  });

  let out = "";
  parts.forEach((p, i) => {
    if (i > 0) {
      const bothList = LIST_TYPES.has(p.type) && LIST_TYPES.has(parts[i - 1].type);
      out += bothList ? "\n" : "\n\n";
    }
    out += p.md;
  });
  return out;
}
