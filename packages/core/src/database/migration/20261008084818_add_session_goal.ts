import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261008084818_add_session_goal",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_goal\` (
          \`session_id\` text PRIMARY KEY,
          \`goal\` text NOT NULL,
          \`size\` text,
          \`size_reason\` text,
          \`contract\` text,
          \`gates\` text NOT NULL,
          \`authorized_at\` integer,
          \`turn_budget\` integer NOT NULL,
          \`turns_used\` integer DEFAULT 0 NOT NULL,
          \`last_verdict\` text,
          \`status\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_goal_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
