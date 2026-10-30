import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261030095345_add_goal_stop_reason",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_goal\` ADD \`stop_reason\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
