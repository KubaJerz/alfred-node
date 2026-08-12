#!/usr/bin/env node
// Alfred's interface to Notion. Holds no credentials — bin/lib/broker-client.js
// forwards to the broker bot.js runs, which is where the integration secret
// lives.
//
// Usage (from AGENT_DIR):
//   node ../bin/notion.js search "reading list"
//   node ../bin/notion.js read <pageId>
//   node ../bin/notion.js query <dbId> --where "Status=To read"
//   node ../bin/notion.js create --db <dbId> --title "Ship it" Status=Todo
//   node ../bin/notion.js append <pageId> --body "- one more thing"
//   node ../bin/notion.js set <pageId> Status=Done
//
// `--help` is the full surface. There is no delete, no archive and no comment:
// v1 is capture, read and row edits. A `set` overwrites in place and Notion
// keeps no history you can reach through the API, so `set` reports the previous
// value — that line is the only undo there is.

import { call, parseFlags, requireId, fail, help, wantsHelp, flaggedHelp } from "./lib/broker-client.js";

const [action, ...args] = process.argv.slice(2);
const { flags, rest } = parseFlags(args);

// Positional NAME=VALUE pairs → a { name: value } object. Repeated --flags can't
// express several properties (the parser keeps only the last), so properties ride
// as positionals: `set <id> Status=Done Priority=High`. Split on the first '='
// only — a value may contain '=', a property name may not.
function pairs(items) {
  const out = {};
  for (const item of items) {
    const eq = item.indexOf("=");
    if (eq === -1) fail(`expected NAME=VALUE, got "${item}"`);
    out[item.slice(0, eq).trim()] = item.slice(eq + 1);
  }
  return out;
}

function printPage(page) {
  console.log(`# ${page.title}`);
  if (page.url) console.log(page.url);
  const props = Object.entries(page.properties || {});
  if (props.length) {
    console.log("");
    for (const [k, v] of props) console.log(`${k}: ${v}`);
  }
  if (page.markdown) console.log(`\n${page.markdown}`);
}

const HELP = {
  search: {
    use: "search <query> [--type page|database] [--limit N]",
    detail: [
      "Finds pages and databases by title. Metadata only — id, title, url, when",
      "it was last edited. Read a page or query a database to see what's inside;",
      "don't loop read over every hit.",
      "",
      "Only what's been shared with the integration is findable at all. If a page",
      "you expect is missing, it hasn't been connected in Notion yet.",
    ],
  },
  read: {
    use: "read <id>",
    detail: [
      "A page's properties (if it's a database row) and its body as markdown.",
      "The body is walked recursively, so nested lists and toggles come through;",
      "very deep or very large pages are bounded and may be truncated.",
    ],
  },
  query: {
    use: "query <dbId> [--where NAME=VALUE] [--limit N]",
    detail: [
      "Rows of a database. --where is a single equals match — Status=Done,",
      "Done=true — against a title, select, status, checkbox or number column.",
      "Richer filtering isn't wired up yet; pull the rows and read them.",
      "",
      "The <dbId> is a database's own id, from `search --type database`.",
    ],
  },
  create: {
    use: "create (--db <id> | --page <id>) --title <t> [NAME=VALUE ...] [--body md]",
    detail: [
      "A new page. --db makes a row in that database; --page makes a subpage.",
      "Exactly one of the two.",
      "",
      "--title sets the title column whatever it's named. Other columns are",
      "NAME=VALUE positionals and only apply to a --db row; their types are read",
      "from the database, so Status=Done and Due=2026-08-20 land correctly.",
      "",
      "--body is markdown for the page's content: headings, - bullets, 1. numbers,",
      "- [ ] to-dos, > quotes, ```code```, --- dividers.",
    ],
  },
  append: {
    use: "append <id> --body <markdown>",
    detail: [
      "Adds markdown to the end of an existing page. Additive — nothing already",
      "there is touched. Same markdown vocabulary as create's --body.",
    ],
  },
  set: {
    use: "set <id> NAME=VALUE [NAME=VALUE ...]",
    detail: [
      "Changes columns on a database row. Each column's type is read first, so a",
      "string becomes the right shape for a status, date, checkbox or number.",
      "",
      "This overwrites in place and Notion exposes no history through the API, so",
      "the command prints the previous value of every column it changed. That",
      "printed from→to is the only record of what it was — relay it.",
    ],
  },
};

const NOTES = [
  "Only pages shared with the integration exist here. No delete, no archive, no",
  "comment — v1 is capture, read and row edits. `set` can't be undone through the",
  "API, so it reports what each value was before.",
];

async function main() {
  // `set --help` must not fall through to `set`, or asking how a command works
  // runs it. Checked before the switch, for every command.
  if (flaggedHelp(flags) && HELP[action]) help("notion.js", HELP, NOTES, action);

  switch (action) {
    case "search": {
      const { results } = await call("GET", "/notion/search", {
        query: { q: rest.join(" "), type: flags.type, limit: flags.limit },
      });
      if (!results.length) {
        console.log("(nothing matched — is the page shared with the integration?)");
        break;
      }
      for (const r of results) {
        console.log(`[${r.id}] (${r.object}) ${r.title}`);
        if (r.url) console.log(`    ${r.url}`);
      }
      break;
    }

    case "read": {
      const id = requireId(rest, flags, "notion.js read <id>");
      const { page } = await call("GET", "/notion/page", { query: { id } });
      printPage(page);
      break;
    }

    case "query": {
      const id = requireId(rest, flags, "notion.js query <dbId> [--where NAME=VALUE]");
      const { rows } = await call("GET", "/notion/db/query", {
        query: { id, where: flags.where, limit: flags.limit },
      });
      if (!rows.length) {
        console.log("(no rows)");
        break;
      }
      for (const row of rows) {
        const extra = Object.entries(row.properties || {})
          .filter(([k]) => k !== "Name" && row.properties[k] !== row.title)
          .map(([k, v]) => `${k}: ${v}`)
          .join("  ·  ");
        console.log(`[${row.id}] ${row.title}${extra ? `  —  ${extra}` : ""}`);
      }
      break;
    }

    case "create": {
      const out = await call("POST", "/notion/page", {
        body: {
          db: flags.db,
          page: flags.page,
          title: flags.title,
          properties: pairs(rest),
          markdown: flags.body,
        },
      });
      console.log(`Created "${out.title}" (${out.id}).`);
      if (out.url) console.log(out.url);
      break;
    }

    case "append": {
      const id = requireId(rest, flags, "notion.js append <id> --body <markdown>");
      const out = await call("POST", "/notion/append", {
        query: { id },
        body: { markdown: flags.body },
      });
      console.log(`Appended ${out.appended} block(s) to ${out.id}.`);
      break;
    }

    case "set": {
      // `set` is the one command with a positional id *and* positional pairs, so
      // requireId's "rest[0] or --id" can't be used — with --id given, rest[0] is
      // a pair, not the id. Resolve explicitly: --id wins and leaves every
      // positional a pair; otherwise the id is rest[0] and the pairs are rest[1..].
      const id = flags.id || rest[0];
      if (!id) fail("usage: node ../bin/notion.js set <id> NAME=VALUE ...");
      const properties = pairs(flags.id ? rest : rest.slice(1));
      if (!Object.keys(properties).length) fail("nothing to set — give at least one NAME=VALUE");
      const out = await call("PATCH", "/notion/page", {
        query: { id },
        body: { properties },
      });
      for (const c of out.changes) console.log(`${c.property}: ${c.from || "(empty)"} → ${c.to}`);
      if (out.url) console.log(out.url);
      break;
    }

    default:
      // Asking for help is not a failure: stdout, exit 0. Everything else is.
      if (!wantsHelp(action)) {
        fail(
          `no such command: ${action}`,
          "",
          "usage: node ../bin/notion.js <command>",
          ...Object.values(HELP).map((c) => `  ${c.use}`)
        );
      }
      help("notion.js", HELP, NOTES, rest[0]);
  }
}

main().catch((err) => fail(`Error: ${err.message}`));
