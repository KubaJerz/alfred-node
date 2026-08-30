// Deciding whether an inbound Discord message is "voice" — a native voice note
// or a dropped-in audio file — kept out of bot.js so it can be unit-tested with
// no Discord client. bot.js passes plain data, not the discord.js object.
//
// Two shapes count as voice, and both mean "the message IS the audio":
//   1. A native Discord voice note (the IsVoiceMessage flag).
//   2. A single audio file sent with no text caption — a voice memo recorded in
//      another app and dropped in.
// A caption next to the audio means the user is writing ABOUT the file, so that
// stays a normal turn and the file is handed on as an attachment.

// Audio file extensions ffmpeg (voice/transcribe.py) decodes. Used as a fallback
// when Discord gives no content-type, which happens for some uploaded files.
const AUDIO_EXT_RE = /\.(ogg|opus|mp3|m4a|aac|wav|flac|webm)$/i;

/**
 * True if one attachment is audio. Trusts Discord's content-type first, then
 * falls back to the file extension.
 *
 * @param {{contentType?: string|null, name?: string|null}} att
 * @returns {boolean}
 */
export function isAudioAttachment({ contentType, name } = {}) {
  if (typeof contentType === "string" && contentType.startsWith("audio/")) return true;
  return AUDIO_EXT_RE.test(name || "");
}

/**
 * True if this message should be transcribed as speech.
 *
 * @param {object}   args
 * @param {Array<{contentType?: string|null, name?: string|null}>} args.atts
 *        the message's attachments, as plain {contentType, name} objects.
 * @param {boolean}  args.isVoiceNote  the IsVoiceMessage flag.
 * @param {string}   args.caption      the message text, mentions already
 *                                     stripped and trimmed ("" when none).
 * @returns {boolean}
 */
export function isVoiceInput({ atts, isVoiceNote, caption } = {}) {
  if (!Array.isArray(atts) || atts.length !== 1) return false; // one audio file
  if (isVoiceNote) return true;                                // native voice note
  const hasCaption = typeof caption === "string" && caption.trim().length > 0;
  return !hasCaption && isAudioAttachment(atts[0]);            // dropped-in memo
}
