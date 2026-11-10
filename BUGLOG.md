# Bug Log

## v9.13.0 (2026-11-10) — B4b audio store + clean pass
| ID | Bug | Root cause | Fix |
|---|---|---|---|
| P4/B4b-1 | Meeting audio was thrown away, so a bad live transcript could never be redone | Audio only lived in 12 s chunks that were sent to Groq and discarded | Mic + meeting mix kept in a separate DB (`MeetingNotesAI-audio`) with retention and a Delete Audio button |
| B4b-2 | Live 12 s chunks cut sentences and lacked context | Live transcription favours speed over accuracy | Clean pass re-transcribes the kept audio with whisper-large-v3 in windows; resumable after reload or the Groq free limit |
| B4b-3 | No way to compare or use the better transcript | One transcript field held everything | Live \| Clean view toggle; live edits are kept; speaker labels are mapped onto the clean transcript by time; summary can be redone from the clean one |
| B4b-4 | Retry Missing Audio could add text the clean pass already covers, or insert into the clean view | Retry inserted into `meetingData.transcript` (active view) | Queue entries covered by the clean pass are dropped; recovered text goes into the live transcript, rollback restores the same field |

## v9.12.0 (2026-11-06) — B4a live audio pipeline
| ID | Bug | Root cause | Fix |
|---|---|---|---|
| D4 | Words cut at every 12 s boundary | MediaRecorder stop → 200 ms gap → restart on a timer | AudioWorklet PCM frames; chunk cut at the quietest 300 ms between 10 and 13 s; no gap |
| A1 | Whisper invented "Thank you for watching" / 字幕由… on silence, and silence used Groq quota | Every 12 s chunk was sent, silent or not; `json` responses carry no confidence | Silence gate (≥ 3 frames ≥ −45 dBFS); `verbose_json` + drop a segment when `no_speech_prob > 0.6` **and** `avg_logprob < −1.0`, or when it matches the known-phrase list |
| A2 | Chunk timing drifted in a hidden tab | `setInterval` rotation is throttled in background tabs | Chunking counts audio frames, not timers |
| P5 (partial) | Local Whisper got raw webm bytes | Transformers.js needs decoded 16 kHz Float32 | WAV chunks pass their PCM as Float32 (worker + v3 model still B4c) |

## v9.11.2 (2026-11-06) — B3 pre-main cleanup
| ID | Bug | Root cause | Fix |
|---|---|---|---|
| R1 | A chunk still transcribing at Stop could add its text AND be queued, so Retry Missing Audio added it twice | Stop queued in-flight chunks but their promise still called `addTranscriptSegment` when it finished | `chunk.queued` set before queueing; a late result is held in `chunk.lateText` and only added if storing the queue failed |
| R2 | A failed save after Retry could roll back segments on the wrong meeting | Rollback used the global `meetingData`, which a meeting switch during the save replaces | Rollback works on the object captured before inserting |
| R3 | "Run Summary" did nothing on a meeting whose audio was all queued | `retrySummary` silently returned on an empty transcript | Button hidden until there is text; a toast points to Retry Missing Audio |
| R4 | If the empty "pending" save at Stop failed, the queued audio had no meeting to retry it from | Queue rows keyed to a meeting id that was never written | `adoptOrphanQueuedChunks()` at startup creates a "Meeting … (audio waiting)" entry; Delete and auto-cleanup now remove the queue first so deleted meetings don't come back |
| M3 | A renamed meeting got its title overwritten by the next save | `saveCurrentMeeting` always recomputed the title | Rename sets `titleEdited`; saves keep that title |
| M7 | Missing-audio banner buttons stayed greyed out after processing | Banner drawn while `processing` was not redrawn | `setAppState` redraws it on idle/done |
| M8 | Wrong toast ("Save this meeting first") if the meeting was deleted mid-retry | Old message assumed an unsaved meeting | New message says it was deleted; queue untouched |
| M10 | A cooldown learned <1 s before a reload was forgotten | Debounced quota save not flushed | Flushed on `pagehide` |
| T4 | Retrying in two tabs added the recovered text twice | No cross-tab coordination | Web Lock `meeting-transcribe-queue-retry`; the second tab is told to wait. An empty queue no longer shows a "no speech found" toast |
| G1 | A mic start that threw (e.g. Gladia) left the app "recording" with the recorder lock held | Only a `false` return was handled | Throw is caught, toasted, and treated as not started |

## v9.11.0 (2026-11-04) — B3 quota scheduler
| ID | Bug | Root cause | Fix |
|---|---|---|---|
| Q1 | A model that was resting kept getting hit with fresh 429s | Each call retried blindly; and Groq's CORS exposes only `cache-control`/`content-type` to browsers, so `retry-after`/`x-ratelimit-*` were never readable | `js/lib/quota-lib.js` tracker: cooldown from the 429 body ("Please try again in 3m2.5s") → else exponential backoff 1/2/4… s (cap 60 s); local audio-seconds/hour+day counters; a resting model is skipped up front (backup toast). State persists in `groq_quota_state` |
| Q2 | Summary failed when every chat model was briefly limited | One pass over the chain, 20 s max wait | `groqChat` second round waits up to 90 s per model, in chain order, before failing |
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
