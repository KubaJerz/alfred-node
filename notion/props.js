// Database rows carry typed properties — a Status is not a Date is not a
// checkbox — and Notion's write shape for each is different. Alfred, and the CLI
// he drives, only ever have a string: "Done", "2026-08-20", "true". Turning that
// string into the right shape needs the property's *type*, which is why every
// write here is preceded by a read of the schema (on create) or the page (on
// update). That read is also the undo log: a property overwrite returns nothing
// and Notion exposes no per-property history through the API, so the old value
// echoed back to the transcript is the only record that it changed.

import { markdownToRichText, richTextToMarkdown } from "./blocks.js";

// A property's current value, rendered to a plain string for display and for the
// before/after the update route reports. Unknown or structural types (files,
// people, rollups) render as a bracketed marker rather than throwing — reading a
// row must never fail because one column is a type we don't render.
export function readProperty(prop) {
  if (!prop) return "";
  switch (prop.type) {
    case "title": return richTextToMarkdown(prop.title);
    case "rich_text": return richTextToMarkdown(prop.rich_text);
    case "select": return prop.select?.name ?? "";
    case "status": return prop.status?.name ?? "";
    case "multi_select": return (prop.multi_select || []).map((s) => s.name).join(", ");
    case "checkbox": return prop.checkbox ? "true" : "false";
    case "number": return prop.number == null ? "" : String(prop.number);
    case "url": return prop.url ?? "";
    case "email": return prop.email ?? "";
    case "phone_number": return prop.phone_number ?? "";
    case "date": {
      const d = prop.date;
      if (!d) return "";
      return d.end ? `${d.start} → ${d.end}` : d.start;
    }
    case "people": return (prop.people || []).map((p) => p.name || p.id).join(", ");
    case "relation": return (prop.relation || []).map((r) => r.id).join(", ");
    case "formula": return String(prop.formula?.[prop.formula?.type] ?? "");
    // Read-only automatic columns — render the value, not a bare type marker.
    case "created_time": return prop.created_time ?? "";
    case "last_edited_time": return prop.last_edited_time ?? "";
    case "created_by": return prop.created_by?.name ?? "";
    case "last_edited_by": return prop.last_edited_by?.name ?? "";
    case "unique_id":
      return prop.unique_id ? `${prop.unique_id.prefix ? prop.unique_id.prefix + "-" : ""}${prop.unique_id.number}` : "";
    default: return `[${prop.type}]`;
  }
}

// A page's properties as a flat { name: string } map, skipping empties so a
// digest of a row isn't padded with blank columns.
export function readProperties(properties) {
  const out = {};
  for (const [name, prop] of Object.entries(properties || {})) {
    const value = readProperty(prop);
    if (value !== "") out[name] = value;
  }
  return out;
}

// Which column is the title. Every database has exactly one, but its name is the
// user's ("Name", "Task", "Title", …), so it has to be found by type, not
// guessed by name.
export function titleKey(schemaProperties) {
  for (const [name, prop] of Object.entries(schemaProperties || {})) {
    if (prop.type === "title") return name;
  }
  return null;
}

const parseBool = (v) => /^(true|yes|1|x|done|checked)$/i.test(String(v).trim());

/**
 * A raw string → the Notion write shape for a property of the given type.
 * `type` comes from the live schema (create) or the live page (update); this
 * never infers it. Throws on a type we can't set from a string, so the failure
 * names the column instead of writing a malformed value.
 */
export function buildProperty(type, raw, name = "property") {
  switch (type) {
    case "title": return { title: markdownToRichText(raw) };
    case "rich_text": return { rich_text: markdownToRichText(raw) };
    case "select": return { select: { name: raw } };
    case "status": return { status: { name: raw } };
    case "multi_select":
      return { multi_select: String(raw).split(",").map((s) => s.trim()).filter(Boolean).map((n) => ({ name: n })) };
    case "checkbox": return { checkbox: parseBool(raw) };
    case "number": {
      const num = Number(raw);
      if (Number.isNaN(num)) throw new Error(`${name} is a number; "${raw}" isn't one`);
      return { number: num };
    }
    case "url": return { url: raw };
    case "email": return { email: raw };
    case "phone_number": return { phone_number: raw };
    case "date": return { date: { start: raw } };
    default:
      throw new Error(`${name} is a ${type}, which can't be set from the command line`);
  }
}

// An equals-filter for database query, built against the schema so the filter
// key matches the property's type. Only equality, which covers "Status=Done"
// and "Done=true"; richer filtering is a deliberate v2.
export function equalsFilter(type, raw, name) {
  switch (type) {
    case "title":
    case "rich_text": return { property: name, [type]: { equals: raw } };
    case "select": return { property: name, select: { equals: raw } };
    case "status": return { property: name, status: { equals: raw } };
    case "checkbox": return { property: name, checkbox: { equals: parseBool(raw) } };
    case "number": return { property: name, number: { equals: Number(raw) } };
    case "url":
    case "email":
    case "phone_number": return { property: name, [type]: { equals: raw } };
    default:
      throw new Error(`can't filter on ${name} (${type}); try a title, select, status, checkbox or number`);
  }
}

// "Status=Done" → ["Status", "Done"]. The value may contain '=', the key may
// not, so split on the first only.
export function parsePair(pair) {
  const eq = pair.indexOf("=");
  if (eq === -1) throw new Error(`expected NAME=VALUE, got "${pair}"`);
  return [pair.slice(0, eq).trim(), pair.slice(eq + 1)];
}
