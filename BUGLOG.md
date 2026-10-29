# Bug Log

## v9.10.0 (2026-10-29) — B1 "Stop the Bleeding"
| ID | Bug | Root cause | Fix |
|---|---|---|---|
| D1 | Meeting lost when AI summary failed | `saveCurrentMeeting()` ran only on the success path of `processRecording()` | Save transcript first; `summaryStatus` + Retry Summary |
| D2 | Tab crash/refresh lost the whole meeting | No autosave during recording | localStorage draft every 2–5 s + recovery banner (own tab immediately, other tabs after 90 s) |
| D3 | Last 12–24 s of meeting audio and the last mic sentence missing | Final chunk discarded in `stopSystemAudioCapture`; `addTranscriptSegment` and `onresult` rejected input while `stopping` | Flush final chunk, await in-flight jobs (30 s cap), accept input while stopping |
| D3b | Chrome kept "sharing" after Stop | Captured audio tracks were never stopped | Stop tracks in the final `onstop` |
| D5 | Rate-limited Whisper chunks silently dropped | No retry; fixed toasts | retry-after-aware retries, turbo↔large-v3 fallback, failed-chunk chip with Retry |
| P1 | Claude live translation never worked | Invalid model ID `claude-sonnet-4-5-20250514` | `MODELS.claudeTranslate` |
| P2 | Gemini summary 404 | Retired `gemini-1.5-flash` | `MODELS.gemini` |
| P3 | Groq summary truncated / invalid JSON on long meetings; 12K-char chunks exceeded 8K TPM | Model echoed full transcript; chunks too big; parts concatenated | No transcript echo; 5K-char chunks; map-merge in groups of 3; model fallback chain |
| P4 | Retries ignored `retry-after`; timeouts never retried | Fixed 2/4 s waits; checked `AbortError` but `AbortSignal.timeout` throws `TimeoutError` | `MTLib.retryDelayMs`; check both error names |
| — | "New Meeting" during recording discarded it | No save before reset | Saves to History first |
| D2b | Clicking Record with a crashed meeting pending silently deleted it | `startRecording` cleared the draft unconditionally | Auto-saves the recoverable draft to History first; aborts Record if that save fails |
| D3c | Stop could freeze for many minutes after a network outage | Failed chunks retried serially without a deadline | Stop-time retry capped at 30 s; untranscribed chunks reported in a warning toast |
| D3d | Late transcription results from a previous recording landed in the next meeting | No per-recording identity on async jobs | Recording-generation counter gates every async add/re-queue |
| D3e | Ending screen-share from Chrome's bar, or Stop exactly at the 12 s rotation, dropped the in-progress chunk | Those paths discarded the chunk | Flush on manual/Chrome stop; rotation-pending flag lets the pending onstop transcribe it |
