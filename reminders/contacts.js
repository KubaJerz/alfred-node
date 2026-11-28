// Who can get a reminder. The list comes from the environment, never from a
// turn.
//
// A reminder names its people by contact name only. No route, CLI flag or
// voice tool field takes a phone number or a Discord id. A confused or
// prompt-injected turn can therefore reach only the people that the owner put
// in REMINDER_CONTACTS, and never a stranger.
//
//   REMINDER_CONTACTS="mom=+15551230000;anna=discord:123456789012345678|+15559870000"
//
// "me" always exists: the owner's Discord id (the first of ALLOWED_USER_IDS)
// and the owner's number (the first of SMS_ALLOWED_NUMBERS), when set. A bad
// item is logged and skipped. It never stops the bot.
//
// The service keeps a number from here, but it texts "me" only for now: the
// 10DLC campaign needs opt-in steps before a text to anyone else
// (reminders/service.js, docs/phone-design.md).

import { normalizeNumber } from "../telnyx/sms.js";

export const CONTACT_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
export const CHANNELS = ["discord", "sms"];
const DISCORD_ID_RE = /^\d{15,22}$/;
const E164_RE = /^\+[1-9]\d{7,14}$/;

function parseItem(item) {
  const eq = item.indexOf("=");
  if (eq < 0) throw new Error("expected name=channels");
  const name = item.slice(0, eq).trim().toLowerCase();
  if (!CONTACT_NAME_RE.test(name)) {
    throw new Error("a name is lower-case letters, digits and dashes, and starts with a letter");
  }
  if (name === "me") throw new Error('"me" is the owner and cannot be set here');
  const contact = { name };
  const channels = item.slice(eq + 1).split("|").map((c) => c.trim()).filter(Boolean);
  if (!channels.length) throw new Error("no channel");
  for (const channel of channels) {
    if (/^discord:/i.test(channel)) {
      const id = channel.slice("discord:".length).trim();
      if (!DISCORD_ID_RE.test(id)) throw new Error("a Discord id is 15-22 digits");
      if (contact.discord) throw new Error("two Discord ids");
      contact.discord = id;
    } else {
      const number = normalizeNumber(channel.replace(/^sms:/i, ""));
      if (!E164_RE.test(number)) throw new Error("a phone number must be in E.164 form: a +, the country code, then the number");
      if (contact.sms) throw new Error("two phone numbers");
      contact.sms = number;
    }
  }
  return contact;
}

/**
 * Build the contact list.
 * @returns {Map<string, {name: string, discord?: string, sms?: string}>} "me" first
 */
export function parseContacts({ spec = "", ownerDiscordId = "", ownerSms = "", log = () => {} } = {}) {
  const contacts = new Map();
  const me = { name: "me" };
  const ownerId = String(ownerDiscordId || "").trim();
  if (DISCORD_ID_RE.test(ownerId)) me.discord = ownerId;
  const ownerNumber = normalizeNumber(ownerSms);
  if (E164_RE.test(ownerNumber)) me.sms = ownerNumber;
  contacts.set("me", me);

  String(spec || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((item, i) => {
      try {
        const contact = parseItem(item);
        if (contacts.has(contact.name)) throw new Error(`"${contact.name}" is already a contact`);
        contacts.set(contact.name, contact);
      } catch (err) {
        // The name only: the rest of the item can hold a phone number.
        const name = item.split("=")[0].trim().slice(0, 32);
        log(`⚠️  REMINDER_CONTACTS: skipped item ${i + 1} ("${name}"): ${err.message}`);
      }
    });
  return contacts;
}

/** The channels a contact has, in the order discord, sms. */
export const channelsOf = (contact) => CHANNELS.filter((c) => contact?.[c]);
