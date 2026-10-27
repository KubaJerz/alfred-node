// Link stripping for the one model in Ronnie that holds tools.
//
// Every other model call in Ronnie is tool-less (haiku.js, invite.js), so a link
// in an email is only text to it. The ToS research step is different: a separate
// `claude -p` with WebSearch and a WebFetch allowlist. Give that model
// "https://evil.example/x" and a prompt-injected email can steer a tool-using
// model to a page the attacker wrote, or to a URL whose query string the attacker
// logs. So the email reaches it with no usable link in it. The model can only
// find sources by searching for the company by name.
//
// Two honest limits. They are why this is the first layer and not the only one:
//
//   * It is lossy on purpose. "update.It takes effect" loses a word, because
//     ".it" is a country code. For research text, a lost word is cheap. A leaked
//     host is the thing we are preventing. When in doubt, it strips.
//   * It cannot be complete. An email can always *describe* a URL in prose ("our
//     site is evil, then a dot, then com") and a model can rebuild it. What makes
//     a missed link harmless is the WebFetch allowlist on the research run, not
//     this file. This file shrinks what the allowlist has to stop.
//
// The shape:
//
//   prepare()     undo every encoding a model can read through: Unicode
//                 lookalikes and invisibles, HTML entities, %XX, \xNN, QP soft
//                 breaks, defangs like hxxp and [.]. The detectors then see what
//                 the model would see.
//   removeLinks() find every link-shaped span on a "skeleton" copy (lookalike
//                 letters folded to Latin, same length) and replace it in the
//                 real text.
//   stripLinks()  loop until nothing changes. The caller then checks that
//                 findLinks() comes back empty. That check is the fail-closed gate.
//
// A host-bearing link keeps its brand word: "visit Acme.com/terms" becomes
// "visit Acme [link removed]". The brand is what the model searches for. A lone
// word has no subdomain, path or query to aim at. Rebuilding "acme.com" from it
// lands on an apex that must still pass the allowlist.
//
// No dependencies. Every regex is bounded (label counts, label length) and the
// input is capped, so a hostile body cannot stall the consumer.

export const LINK = "[link removed]";
export const EMAIL = "[email removed]";
export const DATA = "[encoded data removed]";

// Bound the work before any regex runs. The prompt caps far below this anyway.
const MAX_INPUT = 100_000;
const MAX_HTML = 400_000;

// ── tables ──────────────────────────────────────────────────────────────────

// Every delegated two-letter country code. The real list, not "any two letters",
// so "Node.js" and "file.ts" stay prose while "evil.co" and "evil.it" don't.
const CCTLDS = new Set(
  (
    "ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo bq br bs bt bv bw " +
    "by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi " +
    "fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in " +
    "io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me " +
    "mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg " +
    "ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st su sv " +
    "sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye " +
    "yt za zm zw"
  ).split(" ")
);

// Endings that count as a TLD even where shape alone can't decide: a Title-case
// ending ("Acme.Com"), a spelled-out "dot com", a host split across a line.
// Common English words are left out on purpose, so "update.Today" (a sentence
// missing its space) is not mistaken for a host. Lower-case unknown endings are
// caught by shape in hostShaped() whatever this list says.
const GTLDS = new Set(
  (
    "com net org edu gov mil int arpa info biz name pro mobi asia tel travel jobs aero coop museum post " +
    "app dev page io ai co me tv cc ly gg sh xyz top site online store shop tech club link click website " +
    "icu buzz cloud blog email zip mov onion local internal lan localdomain"
  ).split(" ")
);

// File extensions that are NOT TLDs. "terms.pdf" is a file name, not a host.
// zip, mov, py, sh, md, rs and pl are real TLDs (zip and mov are phishing
// favourites), so they are deliberately absent and get stripped.
const FILE_EXT = new Set(
  (
    "pdf doc docx xls xlsx xlsm ppt pptx txt csv tsv rtf odt ods odp pages numbers key png jpg jpeg gif bmp " +
    "svg webp heic heif tif tiff ico mp3 wav ogg oga m4a flac aac mp4 m4v avi mkv webm wmv mpg mpeg js mjs " +
    "cjs ts tsx jsx css scss sass less htm html xhtml shtml php asp aspx jsp cgi json yaml yml xml toml ini " +
    "cfg conf log exe dll dmg pkg msi apk ipa deb rpm iso img bin dat tmp bak gz tgz bz2 xz rar tar jar war " +
    "ics vcf eml msg pem crt cer der p12 pfx"
  ).split(" ")
);

// Two-label public suffixes, so acme.co.uk's brand is "acme", not "co". A
// subset of the Public Suffix List: getting one wrong only costs a brand word.
const SECOND_LEVEL = new Set(
  (
    "co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk net.uk sch.uk nhs.uk com.au net.au org.au edu.au gov.au " +
    "asn.au id.au co.nz org.nz net.nz govt.nz ac.nz co.jp ne.jp or.jp ac.jp go.jp co.kr or.kr ne.kr go.kr " +
    "ac.kr com.br net.br org.br gov.br com.mx org.mx gob.mx com.ar com.cn net.cn org.cn gov.cn com.hk org.hk " +
    "com.tw org.tw com.sg org.sg com.my co.in net.in org.in gov.in ac.in co.za org.za gov.za com.tr org.tr " +
    "gov.tr com.ua co.il org.il ac.il com.pl co.id or.id ac.id com.ph com.vn com.pe com.co com.ec com.ng " +
    "com.pk com.sa com.eg co.th or.th ac.th com.es com.pt co.at or.at"
  ).split(" ")
);

// Shorteners, ESP click-trackers and link-rewriting gateways. The link is still
// stripped. Only the brand word is withheld, because "sendgrid" is not the
// company whose terms changed and would send the search the wrong way.
const TRACKERS = (
  "bit.ly bitly.com t.co tinyurl.com goo.gl ow.ly buff.ly lnkd.in rebrand.ly is.gd v.gd cutt.ly " +
  "shorturl.at rb.gy tiny.cc t.ly s.id trib.al dlvr.it ift.tt amzn.to fb.me youtu.be " +
  "list-manage.com mailchi.mp mcusercontent.com sendgrid.net mandrillapp.com mailgun.org mailgun.net " +
  "sparkpostmail.com hubspotlinks.com hs-sites.com hubspotemail.net exacttarget.com exct.net " +
  "mktoweb.com mktossl.com marketo.com pardot.com rs6.net constantcontact.com klaviyo.com klclick.com " +
  "klclick1.com klclick2.com klclick3.com createsend.com createsend1.com cmail19.com cmail20.com " +
  "awstrack.me amazonses.com safelinks.protection.outlook.com urldefense.com urldefense.proofpoint.com " +
  "mimecast.com mimecastprotect.com"
).split(" ");

// A query parameter that carries a second URL. The outer host is a redirector,
// so its name says nothing about the destination.
const REDIRECT_PARAM = /[?&](?:url|u|q|r|redirect|redirect_ur[il]|target|dest|destination|link|goto|out|to)=/i;

// Schemes with no "//" that still name a target. Must be followed by a
// non-space, so "Big news: today" and "Your data: we collect" survive.
const OPAQUE_SCHEMES = [
  "mailto", "tel", "sms", "smsto", "mms", "callto", "facetime", "facetime-audio", "skype", "sip", "sips",
  "xmpp", "geo", "magnet", "bitcoin", "ethereum", "javascript", "vbscript", "livescript", "data", "blob",
  "about", "intent", "market", "itms-services", "itms-apps", "ipfs", "ipns", "news", "nntp", "urn", "webcal",
  "feed", "cid", "mid", "view-source", "chrome", "chrome-extension", "moz-extension", "ms-[a-z0-9-]+",
  "zoommtg", "zoomus", "slack", "tg", "whatsapp", "viber", "spotify", "steam", "irc", "ircs", "ldap", "ldaps",
  "gopher", "telnet", "ssh", "sftp", "smb", "nfs", "rtsp", "rtmp", "git", "svn", "ed2k", "dav", "web\\+[a-z]+",
];

// Letters that render like Latin ones but that NFKC leaves alone: Cyrillic,
// Greek, Armenian, Cherokee, small capitals. Used only on the detection copy,
// so a Russian email's words reach the model untouched. Every entry maps one
// UTF-16 unit to one, so the copy keeps the text's offsets.
const CONFUSABLE = new Map();
for (const [from, to] of [
  ["\u0430\u0435\u0451\u0456\u0457\u0458\u043A\u043C\u043D\u043E\u0440\u0441\u044A\u0442\u0443\u044C\u0445\u0455\u04BB\u0501\u051B\u051D\u04CF", "aeeiijkmhopcbtybxshdqwl"],
  ["\u0410\u0412\u0415\u0401\u0406\u0407\u0408\u041A\u041C\u041D\u041E\u0420\u0421\u0422\u0423\u0425\u0405\u04BA\u0500\u051A\u051C\u04C0\u042C", "abeeiijkmhopctyxshdqwlb"],
  ["\u03B1\u03B2\u03B5\u03B9\u03BA\u03BD\u03BF\u03C1\u03C4\u03C5\u03C7\u03C9\u03B7", "abeikvoptuxwn"],
  ["\u0391\u0392\u0395\u0396\u0397\u0399\u039A\u039C\u039D\u039F\u03A1\u03A4\u03A5\u03A7", "abezhikmnoptyx"],
  ["\u0585\u057D\u0578\u0570\u0581\u0566", "ounhgq"],
  ["\u0131\u0237\u0251\u0261\u0269\u029F\u0274\u0280\u028F\u1D00\u0299\u1D04\u1D05\u1D07\uA730\u0262\u029C\u026A\u1D0A\u1D0B\u1D0D\u1D0F\u1D18\uA7AF\uA731\u1D1B\u1D1C\u1D20\u1D21\u1D22", "ijagilnryabcdefghijkmopqstuvwz"],
  ["\u13AA\u13F4\u13DF\u13AC\u13C0\u13BB\u13AB\u13E6\u13DE\u13B7\u13E2\u13DA\u13A2\u13D9\u13D4\u13C3", "abceghjklmpstvwz"],
]) {
  if (from.length !== to.length) throw new Error(`confusable table misaligned at ${from}`);
  for (let i = 0; i < from.length; i++) CONFUSABLE.set(from[i], to[i]);
}

// ── canonical text ──────────────────────────────────────────────────────────

// Punctuation lookalikes. NFKC folds the fullwidth and small forms (．／：＠) but
// not these, and a model reads "evil。com" or "https∶⁄⁄" as a URL all the same.
// The dot-likes fold only next to ASCII letters or digits. That is the attack
// shape, and it leaves CJK sentences ("…です。次の…") and "Privacy · Terms" alone.
const DOTLIKE = "\u00B7\u2022\u2027\u2219\u22C5\u2E31\u2E3C\u2981\u30FB\u3002\u16EB\u0701\u0702\u06D4\uA4F8\uA60E\u1427";
const DOT_NEAR_ASCII = new RegExp(`(?<=[A-Za-z0-9])[${DOTLIKE}]|[${DOTLIKE}](?=[A-Za-z0-9])`, "g");
const SLASHLIKE = /[\u2044\u2215\u29F8\u2571\u27CB\u1735]/g;
const BACKSLASHLIKE = /[\u2216\u29F5\u29F9\u2572\u27CD]/g;
const COLONLIKE = /[\u2236\uA789\u02D0\u02F8\u05C3\u0589\u0703\u0704\u16EC\u1361\u205A\uA4FD]/g;
const HYPHENLIKE = /[\u2010\u2011\u2012\u2043\u2212\uFE58\u02D7\u2796]/g;

// Characters with no ink that can sit inside a URL: zero-widths, bidi controls,
// soft hyphen and the Unicode "tag" block (\p{Cf}), plus the variation selectors
// and fillers that are not Cf. Tag characters are an ASCII-smuggling channel: a
// model can read them and a person cannot see them. So they are deleted, not
// decoded.
const INVISIBLE = /[\p{Cf}\u034F\u115F\u1160\u3164\uFFA0\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;
// A combining mark stacked on an ASCII character ("e̲v̲i̲l̲") changes nothing a
// model reads. Marks on other scripts are real spelling and stay.
const MARKS_ON_ASCII = /(?<=[\x21-\x7E])\p{M}+/gu;
// C0/C1 controls except tab and newline. NUL also matters for another reason:
// UTF-16 text mis-decoded as UTF-8 reads "h\0t\0t\0p", and dropping the NULs
// is what lets the detectors see the "http".
const CONTROLS = /[\x00-\x08\x0E-\x1F\x7F-\x84\x86-\x9F]/g;

// Letter-shaped symbols NFKC leaves alone but a model reads as letters: regional
// indicators (the flag letters), negative circled and negative squared
// capitals. Also runs of parenthesized letters, which is what NFKC makes of the
// parenthesized-letter block: "(e)(v)(i)(l)" reads as "evil".
function letterSymbols(s) {
  return s
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, (c) => String.fromCharCode(0x61 + c.codePointAt(0) - 0x1f1e6))
    .replace(/[\u{1F150}-\u{1F169}]/gu, (c) => String.fromCharCode(0x41 + c.codePointAt(0) - 0x1f150))
    .replace(/[\u{1F170}-\u{1F189}]/gu, (c) => String.fromCharCode(0x41 + c.codePointAt(0) - 0x1f170))
    .replace(/(?:\([\p{L}\p{N}]\)){2,}/gu, (run) => run.replace(/[()]/g, ""));
}

function canonUnicode(s) {
  return letterSymbols(
    s
      .replace(/\r\n?|[\u0085\u2028\u2029]/g, "\n")
      .replace(/[\v\f\u2800]/g, " ")
      .replace(CONTROLS, "")
      .normalize("NFKC")
  )
    .replace(INVISIBLE, "")
    .replace(MARKS_ON_ASCII, "")
    .replace(DOT_NEAR_ASCII, ".")
    .replace(SLASHLIKE, "/")
    .replace(BACKSLASHLIKE, "\\")
    .replace(COLONLIKE, ":")
    .replace(HYPHENLIKE, "-");
}

// The named entities worth knowing. HTML5 also has &colon; &period; &sol; and
// &commat;, which exist mostly to spell URLs. Unknown names are left as written.
const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  zwnj: "", zwj: "", lrm: "", rlm: "", shy: "", colon: ":", period: ".", sol: "/", bsol: "\\",
  commat: "@", lowbar: "_", hyphen: "-", dash: "-", excl: "!", quest: "?", num: "#", percnt: "%",
  plus: "+", equals: "=", semi: ";", comma: ",", lpar: "(", rpar: ")", lsqb: "[", rsqb: "]",
  lbrack: "[", rbrack: "]", lcub: "{", rcub: "}", verbar: "|", vert: "|", ast: "*", midast: "*",
  dollar: "$", tab: "\t", newline: "\n", middot: "\u00B7", centerdot: "\u00B7", bull: "\u2022", hellip: "\u2026",
  mdash: "\u2014", ndash: "\u2013", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201C", rdquo: "\u201D", laquo: "\u00AB", raquo: "\u00BB",
  copy: "\u00A9", reg: "\u00AE", trade: "\u2122", deg: "\u00B0", times: "\u00D7", divide: "\u00F7", euro: "\u20AC", pound: "\u00A3",
  yen: "\u00A5", cent: "\u00A2", sect: "\u00A7", para: "\u00B6",
};
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));?/g;

function fromCode(cp) {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "";
  return String.fromCodePoint(cp);
}

export function decodeEntities(s) {
  return String(s).replace(ENTITY, (m, dec, hex, name) => {
    if (dec) return fromCode(parseInt(dec, 10));
    if (hex) return fromCode(parseInt(hex, 16));
    const v = NAMED[name.toLowerCase()];
    return v === undefined ? m : v;
  });
}

// Only printable ASCII is worth decoding out of %XX, \xNN and \uNNNN. That is
// where URL syntax lives, and it leaves "100%" and real non-ASCII text alone.
const printable = (cp, m) => (cp >= 0x21 && cp <= 0x7e ? String.fromCharCode(cp) : m);

// UTF-7 can spell "." as "+AC4-" (TextDecoder refuses UTF-7, so such a part
// arrives raw). Decode a shift sequence only when it yields URL punctuation, so
// no ordinary "+word-" is ever touched.
function utf7(m, b64) {
  const bytes = Buffer.from(b64, "base64");
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const ch = String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    if (!".:/@?=&#%\\".includes(ch)) return m;
    out += ch;
  }
  return out || m;
}

// One round of every text-level encoding a model can read through. prepare()
// repeats it, so a double encoding (%252F, &amp;#46;) unwinds too.
function decodeLayers(s) {
  return s
    .replace(/=\r?\n/g, "") // quoted-printable soft line break, when it survives decoding
    .replace(ENTITY, (m) => decodeEntities(m))
    .replace(/%u([0-9a-fA-F]{4})/g, (m, h) => printable(parseInt(h, 16), m))
    .replace(/%([0-9a-fA-F]{2})/g, (m, h) => printable(parseInt(h, 16), m))
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g, (m, a, b, c) =>
      printable(parseInt(a || b || c, 16), m)
    )
    .replace(/\\\//g, "/") // JSON-escaped slash: https:\/\/evil
    .replace(/=(2E|3A|2F|40|3F|26|23|25|5C|7E)/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\+([A-Za-z0-9+/]{3,16})-/g, utf7);
}

const tldWord = (t) => GTLDS.has(t) || CCTLDS.has(t);

// Words that start a sentence and are not TLDs. "update.Please" is a sentence
// that lost its space. Any other Title-case ending ("Login.Quest") is a host.
// The first draft spared every Title-case ending, and fuzzing showed that hid
// real hosts once the URL around them had been split off.
const SENTENCE_WORDS = new Set(
  (
    "please thanks thank the this that these those there they then their we our your if for and but on or " +
    "note see find learn visit more also when while with what which after before because however hello hi " +
    "dear regards sincerely questions details"
  ).split(" ")
);

// Abbreviations that end a hard-wrapped line and run into the next word.
const ABBREV = new Set("e.g i.e a.m p.m u.s u.k e.u a.k.a n.b c.f v.s o.k u.s.a et.al".split(" "));

// Defangs are a convention for writing a link that won't auto-link. A model
// reads straight through them, so they are re-fanged here and stripped with
// everything else. The spelled and spaced forms ("acme dot com", "acme . com")
// only fire before a known ending, so "the dot on the i" survives.
//
// Each pattern that opens with a run (a word, or spaces) also opens with a
// lookbehind that pins it to the START of that run. Without it, a 100k-char
// token costs O(n²): the engine retries the run from every offset inside it.
function defang(s) {
  s = s
    .replace(/\bh(?:xx|\*\*|tt|xt|tx|__)p(s?)(?=\s*[\[({]?\s*:)/gi, "http$1")
    .replace(/\bf(?:x|\*)p(?=\s*[\[({]?\s*:)/gi, "ftp")
    .replace(/\b(https?|ftps?)\s*:\s*\/\s*\/\s*/gi, "$1://")
    .replace(/(?<![ \t])[ \t]*[\[({<]\s*(?:\.|dot|d0t|period)\s*[\])}>][ \t]*/gi, ".")
    .replace(/[\[({<]\s*(:\/\/|:\/|:|\/\/|\/)\s*[\])}>]/g, "$1")
    .replace(/(?<![ \t])[ \t]*[\[({<]\s*(?:@|at)\s*[\])}>][ \t]*/gi, "@");
  for (let i = 0; i < 4; i++) {
    const next = s
      .replace(/(?<![\p{L}\p{N}-])([\p{L}\p{N}-]+)[ \t]+dot[ \t]+(\p{L}{2,24})\b/giu, (m, a, t) => (tldWord(t.toLowerCase()) ? `${a}.${t}` : m))
      .replace(/(?<![\p{L}\p{N}-])([\p{L}\p{N}-]+)[ \t]+\.[ \t]*([a-z]{2,24})\b/gu, (m, a, t) => (tldWord(t) ? `${a}.${t}` : m))
      .replace(/(?<![\p{L}\p{N}-])([\p{L}\p{N}-]+)\.[ \t]+([a-z]{3,24})\b/gu, (m, a, t) => (GTLDS.has(t) ? `${a}.${t}` : m));
    if (next === s) break;
    s = next;
  }
  return s;
}

function prepare(s) {
  for (let i = 0; i < 4; i++) {
    const next = canonUnicode(decodeLayers(canonUnicode(s)));
    if (next === s) break;
    s = next;
  }
  return defang(s);
}

// The detection copy: lower-cased, lookalikes folded to Latin, and the SAME
// length as its input, so a match's offsets apply to the real text unchanged.
// That rules out toLowerCase() on the whole string ("İ" lower-cases to two
// units), hence the unit-by-unit walk.
export function skeleton(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const f = CONFUSABLE.get(c);
    if (f) {
      out += f;
      continue;
    }
    const lo = c.toLowerCase();
    out += lo.length === 1 ? lo : c;
  }
  return out;
}

// ── detectors (run on the skeleton) ─────────────────────────────────────────

const LABEL = String.raw`[\p{L}\p{N}](?:[\p{L}\p{N}_\-]{0,61}[\p{L}\p{N}])?`;
const TLD = String.raw`(?:xn--[a-z0-9\-]{1,59}|\p{L}{2,63})`;
const URLCH = String.raw`[^\s<>"'\x60]`;
const TAIL = String.raw`(?::\d{1,5})?(?:[/?#\\]${URLCH}*)?`;
// Every detector refuses to start only after a letter or digit, i.e. mid-word.
// Excluding more ("%", "-", ".", "@") looks tidier but is an evasion:
// "100%evil.com", "-evil.com" and a 12-label host all slipped past it. Starting
// after punctuation is harmless. A longer match from an earlier start wins the
// overlap in spansOf().
const NOT_IN_WORD = String.raw`(?<![\p{L}\p{N}])`;

// Any scheme with an authority: http, ftp, file, smb, ws, a defanged hxxp, even a
// rot13'd "uggcf". Backslashes count, because browsers treat https:\\ as https://.
const SCHEME_URL = new RegExp(String.raw`${NOT_IN_WORD}[a-z][a-z0-9+.\-]{0,31}:[\\/]{2}${URLCH}*`, "gu");
// Browsers also accept "http:evil.com" and "http:/evil.com" for these schemes.
const SPECIAL_NOSLASH = new RegExp(
  String.raw`${NOT_IN_WORD}(?:https?|ftps?|wss?|file):(?![\\/]{2})${URLCH}+`,
  "gu"
);
const OPAQUE = new RegExp(String.raw`${NOT_IN_WORD}(${OPAQUE_SCHEMES.join("|")}):${URLCH}+`, "gu");
// "moc.live//:sptth": a reversed URL is a dare to the model to un-reverse it.
// Anchored at a token start and lazy, so a long token is scanned once.
const REVERSED = /(?<!\S)\S*?\/\/:s?ptth\S*/gu;
const WWW = new RegExp(
  String.raw`${NOT_IN_WORD}(?<host>www\d{0,3}\.(?:${LABEL}\.){0,10}${LABEL})${TAIL}`,
  "dgu"
);
const EMAIL_RE = new RegExp(
  String.raw`${NOT_IN_WORD}[\p{L}\p{N}._%+\-]{1,64}@(?<host>(?:${LABEL}\.){1,10}(?<tld>${TLD}))(?![\p{L}\p{N}])`,
  "dgu"
);
const OCTET = String.raw`(?:0x[0-9a-f]{1,2}|\d{1,4})`;
const IPV4 = new RegExp(
  String.raw`(?<![\p{L}\p{N}_]|\d\.)(?<ip>${OCTET}(?:\.${OCTET}){3})(?![\p{L}\p{N}_]|\.\d)${TAIL}`,
  "dgu"
);
// IPv6, bracketed (the URL form, which may carry a port) or bare. The URL parser
// then decides what is really an address, so "10:30:45" and "std::vector" never
// count.
const V6 = String.raw`(?:[0-9a-f]{0,4}:){2,7}(?:[0-9a-f]{1,4}|(?:\d{1,3}\.){3}\d{1,3})?`;
const IPV6 = new RegExp(
  String.raw`(?<![\p{L}\p{N}_:.\[])(?:\[(?<b>${V6})(?:%[\p{L}\p{N}._~\-]+)?\]|(?<addr>${V6})(?:%[\p{L}\p{N}._~\-]+)?(?![\p{L}\p{N}_:]))${TAIL}`,
  "dgu"
);
// The bare host: "acme.com", "evil.co/x", "//cdn.evil.net/a". It may start
// after any punctuation, "@" included: in "a@evil.com" the email match starts
// earlier and wins, and a bare "@evil.com" is still a host.
const BARE = new RegExp(
  String.raw`${NOT_IN_WORD}(?<pre>\/\/)?(?<host>(?:${LABEL}\.){1,10}(?<tld>${TLD}))(?![\p{L}\p{N}])(?:\.(?=[/:?#]))?(?<tail>${TAIL})`,
  "dgu"
);
const LOCALHOST = new RegExp(String.raw`${NOT_IN_WORD}localhost(?![\p{L}\p{N}_\-])${TAIL}`, "gu");
// "intranet:8080/admin": a host-ish word with a port and a path. It needs a
// letter, so a schedule's "9:00/10:00" is left alone.
const HOSTPORT = new RegExp(
  String.raw`${NOT_IN_WORD}(?=[\p{L}\p{N}\-]{0,62}\p{L})[\p{L}\p{N}\-]{1,63}:\d{2,5}[/\\]${URLCH}*`,
  "gu"
);

// Is this ending a TLD? A known ending (a country code or a listed gTLD) or
// punycode is always a host. So is an unknown ending by shape ("evil.bargains",
// "Login.Quest"), except a file extension ("terms.pdf") or a sentence-starting
// word after a missing space ("update.Please").
function hostShaped(tldCanon, tldSkel, strong) {
  if (tldSkel.startsWith("xn--")) return true;
  if (!/^[a-z]{2,63}$/.test(tldSkel)) {
    // A non-Latin ending (рф, 中国): count it as a host. It is rare in prose.
    return /^\p{L}{2,24}$/u.test(tldCanon) && !/[A-Za-z]/.test(tldCanon);
  }
  if (CCTLDS.has(tldSkel) || GTLDS.has(tldSkel)) return true;
  if (tldSkel.length > 24 || FILE_EXT.has(tldSkel)) return false;
  if (strong) return true;
  return !(/^[A-Z][a-z]+$/.test(tldCanon) && SENTENCE_WORDS.has(tldSkel));
}

function validIPv4(ip) {
  return ip.split(".").every((o) => /^0x/.test(o) || (o.length > 1 && o[0] === "0") || Number(o) <= 255);
}

function validIPv6(addr) {
  if (!/[0-9a-f]/.test(addr)) return false;
  try {
    new URL(`http://[${addr}]/`);
    return true;
  } catch {
    return false;
  }
}

// Give trailing sentence punctuation back to the prose: "see evil.com)." should
// leave ")." behind. Keep a closer the span itself opened (Wikipedia's "_(x)").
function trimEnd(text, start, end) {
  const pairs = { ")": "(", "]": "[", "}": "{", ">": "<" };
  while (end > start) {
    const ch = text[end - 1];
    if (".,;:!?'\"*".includes(ch)) {
      end--;
      continue;
    }
    if (pairs[ch]) {
      const seg = text.slice(start, end);
      if (seg.split(pairs[ch]).length < seg.split(ch).length) {
        end--;
        continue;
      }
    }
    break;
  }
  return end;
}

// The host of a scheme URL, past any userinfo: in "https://acme.com@evil.com/"
// the host is evil.com. That trick exists to put a trusted name up front.
function hostOfUrl(u) {
  const m = /^[a-z][a-z0-9+.\-]*:[\\/]*([^\\/?#\s]*)/i.exec(u);
  if (!m) return null;
  const auth = m[1].slice(m[1].lastIndexOf("@") + 1).replace(/:\d*$/, "");
  return auth && !auth.startsWith("[") ? auth : null;
}

// Every link-shaped span in `canon`, non-overlapping, leftmost-longest.
function spansOf(canon) {
  const k = skeleton(canon);
  const raw = [];
  const push = (start, end, kind, host = null, bare = false, urlish = true) => {
    end = trimEnd(canon, start, end);
    if (end > start) raw.push({ start, end, kind, host, bare, urlish });
  };
  const span = (m) => [m.index, m.index + m[0].length];
  const group = (m, name) => canon.slice(m.indices.groups[name][0], m.indices.groups[name][1]);

  for (const m of k.matchAll(SCHEME_URL)) {
    const [a, b] = span(m);
    push(a, b, "link", hostOfUrl(canon.slice(a, b)));
  }
  for (const m of k.matchAll(SPECIAL_NOSLASH)) {
    const [a, b] = span(m);
    push(a, b, "link", hostOfUrl(canon.slice(a, b)));
  }
  for (const m of k.matchAll(OPAQUE)) {
    const [a, b] = span(m);
    push(a, b, m[1] === "mailto" ? "email" : m[1] === "data" ? "data" : "link");
  }
  for (const m of k.matchAll(REVERSED)) push(...span(m), "link");
  for (const m of k.matchAll(WWW)) push(...span(m), "link", group(m, "host"));
  for (const m of k.matchAll(EMAIL_RE)) {
    if (hostShaped(group(m, "tld"), m.groups.tld, true)) push(...span(m), "email");
  }
  for (const m of k.matchAll(IPV4)) if (validIPv4(m.groups.ip)) push(...span(m), "link");
  for (const m of k.matchAll(IPV6)) if (validIPv6(m.groups.b ?? m.groups.addr)) push(...span(m), "link");
  for (const m of k.matchAll(BARE)) {
    const labels = m.groups.host.split(".");
    const urlish = m.groups.tail.length > 0 || !!m.groups.pre;
    // "e.g.profile", "i.e.the", "a.m.today": a hard-wrapped abbreviation running
    // into the next word. Only before an ending that is not a real TLD, so
    // "e.g.com" is still a host.
    const abbrev = !urlish && ABBREV.has(labels.slice(0, -1).join(".")) && !tldWord(m.groups.tld);
    const strong = urlish || labels.length >= 3;
    if (!abbrev && hostShaped(group(m, "tld"), m.groups.tld, strong)) push(...span(m), "link", group(m, "host"), true, urlish);
  }
  for (const m of k.matchAll(LOCALHOST)) push(...span(m), "link");
  for (const m of k.matchAll(HOSTPORT)) push(...span(m), "link");

  raw.sort((x, y) => x.start - y.start || y.end - x.end);
  const out = [];
  let lastEnd = -1;
  for (const s of raw) {
    if (s.start >= lastEnd) {
      out.push(s);
      lastEnd = s.end;
    }
  }
  return out;
}

// ── brand words ─────────────────────────────────────────────────────────────

/** The registrable domain of a host ("mail.acme.co.uk" -> "acme.co.uk"), or null for an IP. */
export function registrableDomain(host) {
  const h = String(host || "").replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h || h.includes(":") || /^[\d.]+$/.test(h) || /^0x/i.test(h)) return null;
  const labels = h.split(".");
  if (labels.length < 2 || labels.some((l) => !l)) return null;
  const n = labels.length;
  const last2 = skeleton(`${labels[n - 2]}.${labels[n - 1]}`);
  return labels.slice(n - (n >= 3 && SECOND_LEVEL.has(last2) ? 3 : 2)).join(".");
}

/**
 * The one word a stripped link leaves behind: the registrable label, as written
 * ("Acme"). Null for trackers, redirectors, punycode, lookalike scripts and
 * anything that isn't a plain name. A lookalike brand isn't the company's name,
 * and it would only send the search somewhere wrong.
 */
export function brandOf(host, spanText = "") {
  if (!host) return null;
  if ((spanText.match(/:\/\//g) || []).length > 1 || REDIRECT_PARAM.test(spanText)) return null;
  const hostSkel = skeleton(host).replace(/\.$/, "");
  if (TRACKERS.some((t) => hostSkel === t || hostSkel.endsWith(`.${t}`))) return null;
  const reg = registrableDomain(host);
  if (!reg) return null;
  const label = reg.split(".")[0];
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,29}$/.test(label) || /^xn--/i.test(label) || /^\d+$/.test(label)) return null;
  if (/^www\d*$/i.test(label)) return null;
  // A word that resolves on its own (a LAN search domain, WPAD, cloud metadata)
  // is a target even without a TLD, so it never stands in for a brand.
  if (/^(?:localhost|localdomain|local|internal|intranet|metadata|wpad|router|gateway|broadcasthost)$/i.test(label)) return null;
  return label;
}

// ── passes ──────────────────────────────────────────────────────────────────

// A link broken across a line, which a model rejoins without thinking:
// "evil.\ncom", "evil\n.com/x", "evil.c\nom". Join only when (a) neither side
// is a link on its own (each is then stripped separately), (b) the joined text
// has a link that crosses the break, and (c) the part after the break doesn't
// start Title-case. Hard-wrapped prose ends a line with "Terms." and starts the
// next with "It", and that is a sentence, not a host. "IO" and "com" are not.
const SPLIT = /(?<!\S)(\S+)[ \t]*\n[ \t]*(?=(\S+))/gu;
function joinSplitLinks(s) {
  return s.replace(SPLIT, (m, a, b) => {
    if (!/[.:/@\\%&=\[({]/.test(a + b)) return m; // no separator or escape: two words, never a host
    if (spansOf(a).length || spansOf(b).length) return m;
    // Decode the joined text first: the break may split "%2E", "&#46;" or "[.]".
    const hits = spansOf(prepare(a + b));
    if (!hits.length) return m;
    if (hits.every((h) => h.bare && !h.urlish) && /^[A-Z][a-z]/.test(b)) return m;
    return a;
  });
}

// "e v i l . c o m": a run of single characters spaced apart. No sentence has
// four of those in a row, so collapse the run and strip it if it spells a link.
const SPACED = /(?<!\S)(?:\S[ \t\n]{1,3}){3,}\S(?!\S)/gu;

// A Markdown link keeps its words: "[Terms](url)" -> "Terms (url)", and then the
// url goes the way of every other url.
const MD_LINK = /\[(?!(?:link|email|encoded data) removed\])([^\[\]\n]{1,300})\]\(\s*([^()\s]{1,2048})(?:\s+"[^"\n]{0,300}")?\s*\)/g;

// Opaque tokens. A base64 or hex token that decodes to readable text is a
// smuggling channel (a link, or an instruction) with no business in a ToS
// notice. A long letters-and-digits token is a tracking id that no research
// needs. A token is only tried as base64 when it has base64's look: mixed case
// plus a digit or +/=. "ZXZpbC5jb20=" (evil.com) qualifies. "Thursday" and
// "Indemnification" do not, so prose is never decoded by accident.
const BLOB = /(?<![A-Za-z0-9+/=_\-])[A-Za-z0-9+/_\-]{8,}={0,2}(?![A-Za-z0-9+/=_\-])/g;

function readable(bytes) {
  if (bytes.length < 6) return false;
  let ok = 0;
  for (const b of bytes) if ((b >= 0x20 && b <= 0x7e) || b === 9 || b === 10 || b === 13) ok++;
  return ok / bytes.length >= 0.9;
}

function blobVerdict(tok) {
  const base64ish = /[0-9+/=]/.test(tok) && /[a-z]/.test(tok) && /[A-Z]/.test(tok);
  if (base64ish && readable(Buffer.from(tok.replace(/-/g, "+").replace(/_/g, "/"), "base64"))) return DATA;
  if (/^(?:[0-9a-fA-F]{2}){6,}$/.test(tok) && readable(Buffer.from(tok, "hex"))) return DATA;
  if (tok.length >= 64 && /\d/.test(tok) && /[A-Za-z]/.test(tok)) return DATA;
  return tok;
}

function replacement(sp, text) {
  if (sp.kind === "email") return EMAIL;
  if (sp.kind === "data") return DATA;
  const brand = sp.host ? brandOf(sp.host, text.slice(sp.start, sp.end)) : null;
  return brand ? `${brand} ${LINK}` : LINK;
}

// One removal pass over prepared text. Returns the new text and what it removed.
function removeLinks(s) {
  const hits = [];
  s = s.replace(MD_LINK, "$1 ($2)");
  s = joinSplitLinks(s);
  s = s.replace(SPACED, (run) => {
    if (!spansOf(run.replace(/\s+/g, "")).length) return run;
    hits.push({ kind: "spaced", text: run });
    return LINK;
  });
  const spans = spansOf(s);
  if (spans.length) {
    let out = "";
    let at = 0;
    for (const sp of spans) {
      hits.push({ kind: sp.kind, text: s.slice(sp.start, sp.end) });
      out += s.slice(at, sp.start) + replacement(sp, s);
      at = sp.end;
    }
    s = out + s.slice(at);
  }
  s = s.replace(BLOB, (tok) => {
    const v = blobVerdict(tok);
    if (v !== tok) hits.push({ kind: "data", text: tok });
    return v;
  });
  return { text: s, hits };
}

// Cosmetics after removal: "<[link removed]>" and "( acme [link removed] )"
// lose their brackets, runs of removed links collapse, and whitespace settles.
// Nothing here can join two words, so nothing here can make a new link.
function tidy(s) {
  let prev;
  do {
    prev = s;
    s = s.replace(/[<(\[{][ \t]*((?:[A-Za-z0-9-]{1,30} )?\[(?:link|email|encoded data) removed\])[ \t]*[>)\]}]/g, "$1");
  } while (s !== prev);
  return s
    .replace(/(\[link removed\])(?:[ \t]*[,;|\u00B7\u2022/-]?[ \t]*\[link removed\])+/g, "$1")
    .replace(/(?<![ \t])[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function looksLikeHtml(s) {
  return (
    /<(?:html|head|body|div|p|span|table|tr|td|a|br|img|font|center|style|meta)\b[^<>]*>/i.test(s) &&
    /<\/[a-z][a-z0-9]*\s*>|<br\s*\/?>/i.test(s)
  );
}

// HTML is rendered BEFORE the cap. A newsletter can spend 100 KB on <style>
// before its first sentence, and capping first would keep only the CSS. Then
// cut at a word boundary, so the cap can't leave half a host behind.
function render(text) {
  let s = String(text ?? "");
  if (looksLikeHtml(s.slice(0, MAX_HTML))) s = htmlToText(s);
  return s.length > MAX_INPUT ? s.slice(0, MAX_INPUT).replace(/\S*$/, "") : s;
}

/**
 * The text a tool-using model may see: every link, address, IP and encoded blob
 * replaced with a neutral token, the brand word kept. HTML input is rendered to
 * text first. Lossy by design. Check findLinks() on the result before using it.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripLinks(text) {
  let s = render(text);
  s = tidy(prepare(s));
  for (let i = 0; i < 4; i++) {
    const r = removeLinks(s);
    if (!r.hits.length) return s;
    s = tidy(prepare(r.text));
  }
  return s; // still dirty after four rounds: findLinks() is non-empty and the caller fails closed
}

/**
 * What stripLinks would still remove from `text`. On stripLinks output this
 * must be []. The research step runs only if it is, so a bug here fails closed
 * (no research, mail filed as Records) instead of open.
 *
 * @returns {{kind: string, text: string}[]}
 */
export function findLinks(text) {
  return removeLinks(tidy(prepare(render(text)))).hits;
}

// ── HTML → text ─────────────────────────────────────────────────────────────

// Elements whose contents never belong in the text: code, styles, embedded
// documents, and SVG (whose <a xlink:href> is a second anchor syntax).
const DROP = new Set(
  "script style title template svg math object applet iframe frameset noembed noframes xml textarea select datalist audio video canvas map".split(" ")
);
const VOID = new Set("area base br col embed hr img input link meta param source track wbr keygen command basefont frame isindex".split(" "));
const BLOCK = new Set(
  (
    "address article aside blockquote caption center dd details dialog dir div dl dt fieldset figcaption figure " +
    "footer form h1 h2 h3 h4 h5 h6 header hgroup hr legend main menu nav ol p pre section summary table tbody " +
    "thead tfoot tr ul"
  ).split(" ")
);

// Hidden by inline style: the preheader trick, and the classic home of text a
// person never sees but a model reads. Best-effort only. Class-based CSS and
// white-on-white text get through. Hidden text is a steering problem, not a link
// problem, and any link in it is still stripped.
function isHidden(attrs) {
  if (/(?:^|\s)hidden(?=[\s=/]|$)/i.test(attrs)) return true;
  if (/\baria-hidden\s*=\s*["']?\s*true/i.test(attrs)) return true;
  const m = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/i.exec(attrs);
  if (!m) return false;
  const css = decodeEntities(m[1] ?? m[2] ?? m[3] ?? "").toLowerCase().replace(/\s+/g, "");
  return /(?:^|;)(?:display:none|visibility:hidden|mso-hide:all|opacity:0(?:\.0+)?(?:!important)?(?:;|$)|font-size:0(?:\.0+)?(?:px|pt|em|rem|%)?(?:!important)?(?:;|$)|max-height:0(?:px)?(?:!important)?(?:;|$))/.test(css);
}

// Where a tag ends, found the way a browser finds it: a quoted value after "="
// may hold ">" or "<" (srcdoc="<a href=…>"). An unterminated quote runs to the
// end of the document, so the rest is attribute and is dropped. The scan only
// moves forward, so the whole render is linear time.
function tagEnd(s, k) {
  const n = s.length;
  while (k < n && s[k] !== ">") {
    if (s[k] === "=") {
      let v = k + 1;
      while (v < n && " \t\n\r\f".includes(s[v])) v++;
      if (s[v] === '"' || s[v] === "'") {
        const q = s.indexOf(s[v], v + 1);
        k = q === -1 ? n : q + 1;
        continue;
      }
    }
    k++;
  }
  return k;
}

/**
 * Render an HTML body to plain text. It is safe by construction, not by
 * filtering: only text nodes are ever emitted, so no attribute (href, src,
 * action, srcset, srcdoc, style url(), meta refresh, base href, VML in an MSO
 * comment) reaches the output at all. An anchor keeps its words and loses its
 * target. Linear time.
 *
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  let s = String(html ?? "");
  if (s.length > MAX_HTML) s = s.slice(0, MAX_HTML);
  s = s
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "") // comments, incl. <!--[if mso]> VML buttons with hrefs
    .replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, "")
    .replace(/<![^<>]*>?/g, "")
    .replace(/<\?[^<>]*>?/g, "");
  const out = [];
  let skip = null; // { name, depth } while inside a dropped or hidden element
  // A browser collapses every run of whitespace in text, newlines included,
  // to one space. Line breaks come only from tags (br, p, div, li …). A host
  // split across source lines becomes "evil. com", which defang() rejoins.
  const emit = (t) => {
    if (!skip && t) out.push(t.replace(/\s+/g, " "));
  };
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt === -1) {
      emit(s.slice(i));
      break;
    }
    emit(s.slice(i, lt));
    const close = s[lt + 1] === "/";
    const from = lt + (close ? 2 : 1);
    const nm = /^[A-Za-z][A-Za-z0-9:-]{0,63}/.exec(s.slice(from, from + 64));
    if (!nm) {
      emit("<"); // "a < b", "<3": not a tag
      i = lt + 1;
      continue;
    }
    const end = tagEnd(s, from + nm[0].length);
    const attrs = s.slice(from + nm[0].length, end);
    i = end + 1;
    const name = nm[0].toLowerCase();
    const isVoid = VOID.has(name) || /\/\s*$/.test(attrs);
    if (skip) {
      if (name === skip.name && !isVoid) skip.depth += close ? -1 : 1;
      if (skip.depth === 0) skip = null;
      continue;
    }
    if (!close && !isVoid && (DROP.has(name) || isHidden(attrs))) {
      skip = { name, depth: 1 };
      continue;
    }
    if (name === "br") out.push("\n");
    else if (name === "li") out.push(close ? "" : "\n- ");
    else if (BLOCK.has(name)) out.push("\n");
    else if (name === "td" || name === "th") out.push(" ");
    // Every other tag (a, span, img, font, wbr …) vanishes with its attributes.
    // Inline tags join with no space, so "ev<b></b>il.com" stays one token for
    // stripLinks to catch.
  }
  return decodeEntities(out.join(""))
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
