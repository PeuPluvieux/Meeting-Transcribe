# Bug Log

## v9.11.0 (2026-11-04) — B3 quota scheduler
| ID | Bug | Root cause | Fix |
|---|---|---|---|
| Q1 | A model that was resting kept getting hit with fresh 429s | Each call retried blindly; and Groq's CORS exposes only `cache-control`/`content-type` to browsers, so `retry-after`/`x-ratelimit-*` were never readable | `js/lib/quota-lib.js` tracker: cooldown from the 429 body ("Please try again in 3m2.5s") → else exponential backoff 1/2/4… s (cap 60 s); local audio-seconds/hour+day counters; a resting model is skipped up front (backup toast). State persists in `groq_quota_state` |
| Q2 | Summary failed when every chat model was briefly limited | One pass over the chain, 20 s max wait | `groqChat` second round waits up to 90 s for the soonest model |
| Q3 | Meeting audio still failing at Stop was dropped | Failed chunks lived only in memory | Stored in IndexedDB `MeetingNotesAI(-beta)-queue` for 7 days; results banner "Retry Missing Audio" merges recovered text by timestamp (never deletes queued audio unless the save succeeded) |
| Q4 | Two tabs could record at once and double-spend one key | No cross-tab coordination | Web Locks `meeting-transcribe-recorder`; held Start→done, released also when Stop throws |
| Q5 | A retired model ID broke a provider silently (cf. P3) | IDs only checked by hand | Cached 24 h `GET /openai/v1/models`; configured IDs the key doesn't offer are skipped (never to an empty chain) |

## v9.10.3 (2026-11-03) — Stop/mic hardening
| ID | Bug | Root cause | Fix |
|---|---|---|---|
| D6b | A late `audio-capture`/`not-allowed` after Stop re-enabled Record mid-processing and the final `done` landed on a new recording | The pre-start fatal-error branch (`setAppState('idle')`) ran in stopping/processing/done states | Abort-start branches run only when recording && speech never started && no system audio; otherwise warn and ignore |
| D6c | Mic watchdog not running after Resume unless the mic had been lost | Watchdog stops itself while paused and was restarted on resume only when `_micLost` | Resume always resets `_micLost` and restarts the watchdog |
| D6d | Events from a replaced recognition instance could mutate current state | Handlers did not check which instance fired | Handlers capture `rec` and return if `recognition !== rec` |
| D6e | New Meeting during stopping/processing replaced `meetingData` mid-summary | `startNewMeeting` lacked the guard History load has | Refuse with a toast while stopping/processing |

## v9.10.1 (2026-11-03) — Stop greyed out mid-meeting
| ID | Bug | Root cause | Fix |
|---|---|---|---|
| D6 | Stop & Process greyed out during a real meeting while recording continued | A Web Speech `audio-capture`/`not-allowed` error mid-meeting (mic taken by Teams, headset switch, watchdog restart) set `appState=idle` while meeting audio + draft kept running; opening a History meeting mid-recording set `appState=done` and replaced `meetingData` | Mid-meeting mic errors keep the meeting recording (mic status "Mic stopped", warning toast, no reconnect loop; Pause→Resume retries mic); History load refused while recording/stopping/processing |

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
