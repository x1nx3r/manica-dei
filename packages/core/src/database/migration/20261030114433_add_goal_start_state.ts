import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261030114433_add_goal_start_state",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_goal\` ADD \`start_state\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
