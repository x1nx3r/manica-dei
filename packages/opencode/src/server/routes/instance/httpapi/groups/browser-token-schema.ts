import { Schema } from "effect"

// The ticket shape. Kept local because the PTY ticket encodes a ptyID and a
// browser has none.
export const ConnectTokenSchema = Schema.Struct({
  ticket: Schema.String,
  expires_in: Schema.Number,
})
