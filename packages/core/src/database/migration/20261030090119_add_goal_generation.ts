import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261030090119_add_goal_generation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_goal\` ADD \`generation\` integer DEFAULT 1 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
