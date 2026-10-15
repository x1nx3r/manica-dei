import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Fork ADR-0008: the projection gains the pointer to the judge session that
// produced the last verdict, so a client that arrived late can open the ruling
// it is reading without the event bus or the children route.
export default {
  id: "20261015120000_add_goal_verdict_session",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_goal\` ADD \`last_verdict_session\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
