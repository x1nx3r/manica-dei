import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261012143633_add_goal_phase_and_state",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_goal\` ADD \`phase\` text DEFAULT 'dev' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_goal\` ADD \`state_hash\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
