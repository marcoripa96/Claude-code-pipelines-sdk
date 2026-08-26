# Use the Agent SDK's native outputFormat for step Outputs

Claude steps declare a Zod schema; the SDK passes `z.toJSONSchema()` to
`query()`'s `outputFormat: { type: 'json_schema', schema }` and reads the validated value
off the result message's `structured_output`. We first planned to inject our own
`submit_output` MCP tool and validate the tool input ourselves. Inspecting
`@anthropic-ai/claude-agent-sdk@0.3.245` showed that is exactly what `outputFormat`
already does internally — it registers an end-turn tool (`_meta['claude/endTurn']`) and
carries its own retry loop (`terminal_reason: 'structured_output_retry_exhausted'`) — so
hand-rolling it would duplicate the mechanism and lose the built-in retries.

Structured Output is additional control data, not the session's human-facing answer. A
Claude step always records the result message's final assistant message as `finalMessage`;
when the step declares a schema it also records `structured_output` as its Output.
