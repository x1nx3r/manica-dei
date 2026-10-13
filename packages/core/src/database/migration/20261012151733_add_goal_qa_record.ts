import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261012151733_add_goal_qa_record",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_goal\` ADD \`qa_record\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
