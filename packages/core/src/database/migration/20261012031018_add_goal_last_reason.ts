import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261012031018_add_goal_last_reason",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_goal\` ADD \`last_reason\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
