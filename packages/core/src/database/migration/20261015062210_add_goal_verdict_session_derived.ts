import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261015062210_add_goal_verdict_session_derived",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_goal\` ADD \`last_verdict_session\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
