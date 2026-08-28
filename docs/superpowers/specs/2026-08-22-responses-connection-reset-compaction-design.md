# Responses Connection Reset Compaction Recovery

## Goal

Recover one oversized `/responses` request when GitHub Copilot closes the
upstream HTTP connection before returning response headers.

The recovery must reduce the request by summarizing older context with the
configured `smallModel`, then retry the original request once. Normal requests,
small requests, non-connection failures, and failures after streaming begins
must retain their current behavior.

## Scope

The recovery applies only when all of these conditions are true:

- The Copilot Responses HTTP call fails before returning response headers.
- The error chain contains `ECONNRESET` or `UND_ERR_SOCKET`.
- The sanitized outbound payload is at least 256 KiB.
- The payload input is an array with history that can be compacted.
- The downstream request has not been aborted.

The recovery does not apply to provider routes, WebSocket failures, stream
failures after headers, HTTP 408 or 499 responses, or other network errors.

## Architecture

Add a focused recovery module under `src/routes/responses/`. It owns:

- matching eligible connection errors;
- measuring serialized payload bytes;
- splitting older input into bounded, coherent chunks;
- creating summary requests for `smallModel`;
- assembling the compacted payload;
- enforcing the single-recovery and byte-budget rules.

`src/routes/responses/handler.ts` remains the orchestration owner. It makes the
normal upstream call first and invokes the recovery module only when that call
throws an eligible error. Transport code continues to report the original
connection error without adding policy or retry behavior.

The existing unresolved conflicts in `src/routes/responses/handler.ts`,
`src/routes/responses/utils.ts`, and
`tests/responses-image-sanitizer.test.ts` must be resolved by preserving both
the current image normalization work and the upstream image-limit work before
implementation begins.

## Context Selection

The compacted request preserves:

- all system and developer instruction items;
- the largest recent coherent suffix of conversational and tool history that
  fits the compaction strategy;
- all original request options needed by the final model call.

Older conversational and tool history is summarized. Split points occur only
between top-level input items. A split point must move backward when necessary
to keep a tool call and its corresponding output in the same side of the
boundary. The implementation must not leave an output without its referenced
call in the retained suffix.

Each summary input chunk has a target serialized size of at most 128 KiB.
Each summary request is a fresh minimal payload containing only `model`,
`input`, `stream: false`, and an output-token limit of approximately 2,000.
It must not copy `tools`, `tool_choice`, `context_management`, `include`,
`parallel_tool_calls`, images, or any other control from the original request.
Historical items are serialized with their roles and item types intact and
clearly delimited as untrusted conversation history so their content cannot
become summary-model instructions.

Each summary response is limited to approximately 2,000 output tokens. The
summary prompt requires concise preservation of decisions, active tasks,
constraints, identifiers, tool results, unresolved errors, and recent state.
It must not invent missing details or issue tool calls.

The combined historical summary is inserted as one `ResponseInputMessage` with
`role: "user"` and one `input_text` content item. Its text is wrapped in
`[Compacted conversation history]` delimiters and states that the enclosed text
is historical context, not new instructions. System and developer items copied
from the removed prefix retain their original relative order and appear before
this summary item. The summary item appears immediately before the retained
recent suffix.

## Recovery Flow

1. Sanitize and prepare the original payload through the existing handler flow.
2. Attempt the normal Copilot Responses call.
3. If the call returns headers, continue the existing response or stream path.
4. If it throws, verify the error code, payload size, array input, and downstream
   signal.
5. Resolve the configured `smallModel`. If it is unavailable or cannot use the
   required Copilot Responses transport, rethrow the original connection error.
6. Select the coherent recent suffix and split the older history into chunks.
7. Request a non-streaming summary for each chunk, sequentially, using the same
   downstream abort signal.
8. Accept a summary only when the Responses result is completed, contains
   non-empty output text, contains no tool call, and is neither incomplete nor
   errored. Any other result fails recovery.
9. If combined summaries plus retained context still exceed 256 KiB, summarize
   the combined summaries once more under the same acceptance rules.
10. Insert the resulting historical summary before the retained recent suffix
   while keeping system and developer instructions unchanged.
11. Measure the final compacted payload. If it still exceeds 256 KiB, including
    when the retained suffix or one indivisible item exceeds the budget, rethrow
    the original connection error without retrying the original model.
12. Retry the original request once with the original model and compacted input.
13. Return the retried response through the existing response handling path.

The recovery flow cannot invoke itself. Any summary failure or final retry
failure terminates the request.

## Error Handling

When recovery cannot start, rethrow the original connection-reset error so the
existing `upstream_connection_closed` 502 response remains unchanged.

When recovery has started:

- downstream cancellation aborts the active summary or retry immediately;
- summary-model resolution or summary generation failure returns that explicit
  failure through the existing error handler;
- a final retry connection reset returns the existing retryable 502;
- no second compaction or retry is attempted.

No response bytes are emitted before recovery completes. A connection failure
after an SSE response has begun is never replayed transparently.

## Usage and Logging

Every completed summary call records a separate usage event attributed to
`smallModel`, including the optional consolidation call, even if a later
summary or final retry fails. A successful final retry records its usage under
the original request model. All events use the same endpoint and fallback
session identifiers as the original request. The initial failed call has no
reported usage to record.

Log one warning when recovery starts and one warning when compaction completes
and the original request is about to retry. The completion warning must remain
visible at the default terminal log level. Log only:

- original and compacted payload byte counts;
- number of summary chunks;
- summary model identifier.

Do not log summary prompts or generated summary text outside existing explicit
verbose payload logging behavior.

## Validation

Add focused unit coverage for:

- payloads below 256 KiB never entering recovery;
- non-connection errors and HTTP errors never entering recovery;
- `ECONNRESET` and nested `UND_ERR_SOCKET` entering recovery;
- system and developer instructions remaining unchanged;
- chunk sizes respecting the 128 KiB target;
- tool calls and outputs not being split;
- summary requests using `smallModel`, non-streaming mode, no tools, and no
  images or copied original request controls;
- empty, tool-calling, incomplete, and errored summary results failing recovery;
- downstream cancellation stopping recovery;
- combined summaries receiving at most one consolidation pass;
- a payload that remains above 256 KiB after consolidation, or because of the
  retained suffix or one indivisible item, rethrowing the original connection
  error without retrying the original model;
- the original model being retried exactly once;
- summary or retry failure not causing recursive recovery;
- the compacted payload being below 256 KiB before retry;
- streaming requests being recoverable only before upstream headers.

Run the targeted Responses handler and recovery tests, then the repository
typecheck and lint checks for changed files.

## Success Criteria

An eligible oversized request that encounters an upstream connection reset can
complete through one bounded summary-and-retry flow. All ineligible requests
retain their current behavior, and no request can enter an unbounded retry or
compaction loop.
