# Product usage data

The T3 Code server sends product usage events to PostHog, associated with a hashed account or
installation identifier. Events include the provider, model, reasoning effort, permission mode,
turn result, duration, and main-agent token totals when available.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

To disable collection, turn off **Usage analytics** in Settings > General for the environment.
You can also set `T3CODE_TELEMETRY_ENABLED=false` in the server's environment before starting it.
Either option stops product events from being recorded or sent. The environment variable takes
precedence if it is set to `false`.
