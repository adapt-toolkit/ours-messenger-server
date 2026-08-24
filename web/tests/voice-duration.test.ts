// THE VOICE DURATION, AND WHAT HAPPENS WHEN THERE ISN'T ONE.
//
// A MediaRecorder container does not reliably carry its own length. A streamed
// WebM reports Infinity; MediaRecorder's fragmented MP4 — the iOS path — commonly
// reports 0. The old renderer accepted any finite value, so a container claiming
// zero produced a confident "0:00" over a real recording.
//
// The length is therefore measured once by the sender from the FINALISED blob and
// carried in the mime beside the existing voice marker.
//
// THE ABSENT CASE IS PERMANENT AND IS TESTED AS SUCH. Every voice message sent
// before this existed has no duration and never will, and a browser that cannot
// measure one still sends the message. Absent must read as unknown — '·:··' —
// and must never become 0:00, which would be the same confident falsehood in a
// different place.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  formatVoiceDuration,
  parseVoiceDuration,
  VOICE_DURATION_PARAM,
  VOICE_MARKER,
  withVoiceDuration,
} from '../src/voice.js';
import { voiceMime } from '../src/ui/fileStore.js';

// ---- carrying it -----------------------------------------------------------
const carried = withVoiceDuration(voiceMime('audio/webm'), 2.939738);
assert.ok(carried.includes(VOICE_MARKER), 'the voice marker is untouched — this rides beside it, not over it');
assert.ok(carried.includes(`${VOICE_DURATION_PARAM}=2.94`), `the measured length is carried: ${carried}`);
assert.equal(parseVoiceDuration(carried), 2.94, 'and reads back');

// The server validates mime as a type with token parameters. A value this test
// would let through but the server would reject is a send that 400s in the field.
const SERVER_MIME = /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:\s*;\s*[\w!#$&^_.+-]+=[\w!#$&^_.+:-]+)*$/i;
assert.match(carried, SERVER_MIME, 'the resulting mime still satisfies the server-side mime validator');
assert.ok(carried.length <= 255, 'and stays inside the server mime length cap');

// ---- measuring it ----------------------------------------------------------
assert.equal(formatVoiceDuration(2.939738), '2.94', 'centiseconds is past display precision');
assert.equal(formatVoiceDuration(0), null, 'zero is not a duration');
assert.equal(formatVoiceDuration(-1), null, 'nor is a negative one');
assert.equal(formatVoiceDuration(Infinity), null, 'nor is the Infinity a streamed container reports');
assert.equal(formatVoiceDuration(Number.NaN), null, 'nor NaN');

// ---- ABSENCE, which is permanent -------------------------------------------
const bare = voiceMime('audio/webm');
assert.equal(withVoiceDuration(bare, null), bare,
  'an unmeasurable recording still sends, with the mime it would have had');
assert.equal(parseVoiceDuration(bare), null, 'a message with no duration reads as unknown');
assert.equal(parseVoiceDuration(undefined), null, 'and so does a missing mime');
assert.equal(parseVoiceDuration(''), null, 'and an empty one');
assert.equal(parseVoiceDuration('audio/webm;x-ours-duration=0'), null,
  'A CARRIED ZERO IS UNKNOWN, NOT ZERO — this is the exact value the iOS container reports, and it must not become 0:00');
assert.equal(parseVoiceDuration('audio/webm;x-ours-duration=abc'), null, 'a malformed value is unknown, not a crash');
assert.equal(parseVoiceDuration('audio/webm;x-ours-duration='), null, 'and so is an empty one');

// Tolerant of spacing and case, since the value survives a round trip through
// the server and through whatever a peer's build writes.
assert.equal(parseVoiceDuration('audio/webm; X-Ours-Duration = 12.5'), 12.5,
  'the parameter is read case- and space-insensitively');
assert.equal(parseVoiceDuration('audio/webm; x-ours-kind=voice-message; x-ours-duration=61.2'), 61.2,
  'and is found alongside the kind marker in either order');

// ---- what the bubble shows -------------------------------------------------
// The formatting the bubble applies, pinned here so "absent" cannot quietly
// start rendering as a number.
const shown = (mime: string) => {
  const dur = parseVoiceDuration(mime);
  return dur === null ? '·:··' : `${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')}`;
};
assert.equal(shown(withVoiceDuration(bare, 2.94)), '0:02', 'a measured three-second take reads 0:02');
assert.equal(shown(withVoiceDuration(bare, 61.2)), '1:01', 'and a long one carries minutes');
assert.equal(shown(bare), '·:··', 'AND AN UNMEASURED ONE READS UNKNOWN, NOT ZERO');
assert.equal(shown('audio/mp4;x-ours-duration=0'), '·:··', 'as does the zero a container lies with');

// ---- and the element is not allowed to reintroduce the zero ----------------
// The bubble also reads the <audio> element's own duration. Some fragmented MP4
// containers report a finite 0, which the old guard accepted. Assert the source
// contract here because this unit suite does not run a WebKit recording engine.
const bubbleSource = readFileSync(new URL('../src/ui/FileBubbles.tsx', import.meta.url), 'utf8');
assert.match(bubbleSource, /isFinite\(d\) && d > 0/,
  'the element duration is accepted only when finite AND positive — a container reporting 0 must not become 0:00');
assert.match(bubbleSource, /useState<number \| null>\(\(\) => parseVoiceDuration\(rec\.mime\)\)/,
  'and the carried duration seeds the bubble, so a peer sees a length without decoding anything');

console.log('voice-duration OK — measured once at the sender, carried in the mime, and unknown stays unknown');
