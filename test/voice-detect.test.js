import { test } from "node:test";
import assert from "node:assert/strict";
import { isAudioAttachment, isVoiceInput } from "../voice/detect.js";

test("isAudioAttachment trusts an audio/* content-type", () => {
  assert.equal(isAudioAttachment({ contentType: "audio/ogg", name: "x" }), true);
  assert.equal(isAudioAttachment({ contentType: "audio/mpeg", name: "x" }), true);
  assert.equal(isAudioAttachment({ contentType: "audio/mp4", name: "x" }), true);
});

test("isAudioAttachment falls back to the extension when content-type is missing", () => {
  assert.equal(isAudioAttachment({ contentType: null, name: "memo.m4a" }), true);
  assert.equal(isAudioAttachment({ contentType: undefined, name: "clip.WAV" }), true); // case-insensitive
  assert.equal(isAudioAttachment({ name: "voice.opus" }), true);
});

test("isAudioAttachment rejects non-audio", () => {
  assert.equal(isAudioAttachment({ contentType: "image/png", name: "photo.png" }), false);
  assert.equal(isAudioAttachment({ contentType: null, name: "notes.txt" }), false);
  assert.equal(isAudioAttachment({ contentType: "video/mp4", name: "clip.mp4" }), false);
  assert.equal(isAudioAttachment({}), false);
});

test("a native voice note is voice input regardless of caption", () => {
  const atts = [{ contentType: "audio/ogg", name: "voice-message.ogg" }];
  assert.equal(isVoiceInput({ atts, isVoiceNote: true, caption: "" }), true);
  // Native notes never carry a caption, but the flag must win even if one appears.
  assert.equal(isVoiceInput({ atts, isVoiceNote: true, caption: "hi" }), true);
});

test("a lone audio file with no caption is voice input", () => {
  const atts = [{ contentType: "audio/mpeg", name: "memo.mp3" }];
  assert.equal(isVoiceInput({ atts, isVoiceNote: false, caption: "" }), true);
  assert.equal(isVoiceInput({ atts, isVoiceNote: false, caption: "   " }), true); // whitespace-only
});

test("a lone audio file WITH a caption is not voice input — it's a turn about the file", () => {
  const atts = [{ contentType: "audio/mpeg", name: "memo.mp3" }];
  assert.equal(isVoiceInput({ atts, isVoiceNote: false, caption: "what is this?" }), false);
});

test("a non-audio attachment is not voice input", () => {
  const atts = [{ contentType: "image/png", name: "photo.png" }];
  assert.equal(isVoiceInput({ atts, isVoiceNote: false, caption: "" }), false);
});

test("zero or multiple attachments are not voice input", () => {
  assert.equal(isVoiceInput({ atts: [], isVoiceNote: false, caption: "" }), false);
  const two = [
    { contentType: "audio/mpeg", name: "memo.mp3" },
    { contentType: "image/png", name: "photo.png" },
  ];
  assert.equal(isVoiceInput({ atts: two, isVoiceNote: false, caption: "" }), false);
});

test("bad input is handled without throwing", () => {
  assert.equal(isVoiceInput({}), false);
  assert.equal(isVoiceInput({ atts: null, isVoiceNote: false, caption: "" }), false);
});
