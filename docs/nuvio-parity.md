# Nuvio parity — what we are actually porting

Source of truth: the shipped Kotlin in [NuvioMedia/NuvioTV](https://github.com/NuvioMedia/NuvioTV)
(`app/src/main/java/com/nuvio/tv/ui/screens/player/PlayerRuntimeControllerSubtitleTiming.kt`,
`SubtitleDelayConfig.kt`, `PlayerSubtitleCueParser.kt`) and the AI-sync work in
[PR #2817](https://github.com/NuvioMedia/NuvioTV/pull/2817) / issue
[NuvioMobile#2221](https://github.com/NuvioMedia/NuvioMobile/issues/2221).

## The algorithm, as shipped

Auto Sync is **not** audio fingerprinting. It is *text* cue matching, in three stages:

1. **Reference capture.** The player watches its own ExoPlayer `onCueGroup` callback for the
   video's **built-in text subtitle track** and keeps a rolling buffer
   (`subtitleAutoSyncSourceCueBuffer`). Image-based reference tracks (PGS / DVB / VobSub) are
   flagged `isImageBased` and are excluded — ML Kit OCR is only a fallback when nothing text
   based exists.
2. **Window match.** Once the buffer holds **5 consecutive reference lines**
   (`AUTO_SYNC_SOURCE_LINE_COUNT = 5`), those lines plus the candidate **addon** subtitle's lines
   are sent to an LLM (Groq `llama-3.1-8b-instant` or Gemini `gemini-3.5-flash`) which returns
   which addon cue corresponds to which reference cue. Per-pair offsets are collected.
3. **Aggregate.** Up to **3 attempts** (`AUTO_SYNC_MAX_ATTEMPTS`) add more independent pairs, then
   the final delay is the **median** of the pooled per-pair offsets.

Then the application step:

```kotlin
newDelayMs = (capturePositionMs - cueStartTimeMs - AUTO_SYNC_REACTION_COMPENSATION_MS)
    .coerceIn(SUBTITLE_DELAY_MIN_MS, SUBTITLE_DELAY_MAX_MS)
```

with

| constant | value |
| --- | --- |
| `AUTO_SYNC_REACTION_COMPENSATION_MS` | `300` ms |
| `SUBTITLE_DELAY_MIN_MS` | `-180000` ms |
| `SUBTITLE_DELAY_MAX_MS` | `180000` ms |
| `SUBTITLE_DELAY_STEP_MS` | `100` ms |
| `SUBTITLE_DELAY_OVERLAY_TIMEOUT_MS` | `20000` ms |

The delay is `persistTrackPreference()`d — *"Remember the delay so it survives to the next
session (issue #1063)"* — so a sync is computed once and reused forever.

There is also a **manual** path (`applySubtitleAutoSyncCue`): the timing dialog lists the file's
next cues and the user taps the line they just heard at `captureSubtitleAutoSyncTime()`; the same
formula runs.

V2 / "drift correction" adds the multi-attempt pooling described above on top of plain offset.

## Why a Stremio addon can do the same thing

Nuvio has the media player, so it has the built-in track and the playback clock. A Stremio addon
has neither — but it *does* have three substitutes, and we implement all of them:

| Nuvio input | Our substitute |
| --- | --- |
| built-in subtitle track as reference | **other subtitle tracks** for the same video (`videoHash` / release filename) fetched from every enabled provider → cross-subtitle timeline alignment |
| the player's audio clock | **the video's audio track**, pulled with `ffmpeg` from a resolvable media path, turned into a speech/energy envelope and cross-correlated against the subtitle's speech mask (`ffsubsync` / `alass` used when installed) |
| `capturePositionMs` from the live player | the **Sync Lab** web page: the user plays the episode anywhere, taps *"heard it"* at the right line, and the page posts the player clock → identical `position - cueStart - 300 ms` arithmetic |
| `persistTrackPreference()` | the offset store (`offsetMs`, `rate`, `method`, `confidence`) keyed by `videoKey` + `trackId`, applied to every future fetch of that subtitle |

And the LLM stage is a literal port: 5-line window, Groq/Gemini, median of pooled offsets.

## Output-side parity

Because Stremio has no per-track delay API an addon can reach, we apply the delay **by rewriting
the subtitle timestamps before serving them**:

```
newStart = round(oldStart * rate) + offsetMs
```

so the file Stremio receives is already in sync, including linear drift (`rate`) — which is
strictly more than Nuvio's delay-only approach, at the cost of being applied at fetch time
instead of live.
