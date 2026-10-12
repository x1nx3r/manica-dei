# Upstream finding — GLM 5.3 flash folds a tool argument into `action`

Date: 2026-10-12
Model: `opencode-go/glm-5.3-flash`
Where: `evals/goal-loop/.opencode/tool/drive.ts`

## Symptom

A tool call with more than one argument sometimes arrives with a later
argument folded into the first. Observed repeatedly on `answer`, which takes
`action` + `answer`:

```json
{
  "action": "answer<arg_key>answer</arg_key><arg_value>Per-policy carryover_cap (Recommended)",
  "requestID": "que_12e73918a0010rFih1fxcaJbya"
}
```

The `action` enum rejects that string, so the call fails. With no `default`
guard in the tool's switch it fell through and silently ended the session.

## Reading

`<arg_key>…</arg_key><arg_value>…</arg_value>` is the Anthropic Messages API's
tool-use serialization. The argument is emitted in that form and concatenated
into the neighbouring JSON string instead of being placed in its own field.
Whether the model or an adapter in the provider chain is responsible is not
determined. `prompt` (two arguments) was reliable; the failures were on
three-argument calls and array arguments.

## What we do

- `answer` takes a plain label and looks the pending request up itself, so the
  call is one argument shorter.
- `normalize()` in `drive.ts` splits the folded string back into `action` plus
  the named argument, so a mangled call still works.
- The switch has a `default` that throws, so a mangled action can never
  silently pass.

The inner session (`opencode-go/deepseek-v4.1-flash`) is unaffected. Worth
re-checking against the big `glm-5.3`, to separate model size from adapter
defect.
