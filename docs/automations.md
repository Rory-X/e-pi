# Automations

Automations runs scheduled Pi prompts while E-Pi is running. Its sidebar entry sits between Skills and Packages. The global panel supports project filtering, creation, editing, run now, pause/resume, deletion, stopping, and opening run sessions.

- Each task saves its prompt, optional Skill, canonical working directory, model, thinking level, timeout and notification preference. Each run creates a new ordinary Pi session in that directory, with the existing Pi permissions. Model selection never falls back silently.
- Schedules support a single local date/time, intervals in minutes/hours, and selected weekdays at a local time. The task stores an IANA timezone. Calendar schedules keep that timezone when the computer's timezone changes. The form previews the next occurrence. A nonexistent local time during a DST transition is skipped; a repeated local time runs once, at its first occurrence.
- The main process owns scheduling. Quit stops execution; macOS can continue with its window closed. On launch/resume, only the latest missed occurrence is caught up; older occurrences are recorded as missed in an aggregate entry. Intervals retain their original anchor.
- A task cannot overlap itself: a due occurrence is skipped if it already has a queued, starting, running or waiting run. Different tasks in the same canonical directory queue FIFO. At most two automated runs may be starting/running/waiting globally. Ordinary conversations do not count toward this limit.
- Waiting for permission or a question retains the session, directory lock and concurrency slot, and raises a notification. Waiting time does not count toward timeout. Default timeout is 60 minutes and is configurable. Stop/timeout preserves session files; already performed changes are not rolled back.
- Failure does not trigger an application-level retry; Pi's own provider retry behavior remains intact. Manual rerun is available. Normal future occurrences remain scheduled. Interrupted runs on application restart are marked failed rather than replayed.
- Pausing/deleting cancels queued and future occurrences, leaving a current run intact. Editing replaces queued occurrences and affects future runs, while a current run retains its saved configuration. Run now does not advance the schedule and is available on paused/completed tasks. Deletion retains history and session links.
- Each task retains its latest 100 terminal run records plus all outstanding runs. Pruning records never deletes sessions. Sidebar sessions carry an automation origin marker and a task-name/time title, even after history is pruned or the task deleted.
- Completed background runs release their Pi processes. If the user is viewing a completed session, its editor stays available for ordinary follow-up messages. Stop and timeout always end the current process.
- Notifications default to failures, timeouts and required user input; tasks can opt into successful completion notifications. Skips and queue cancellation do not notify.

Scheduling, state recovery, concurrency, waiting/timeout accounting and persistence are verified with deterministic tests; no browser E2E is required.
