import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * "One way in" is enforced here, not by convention.
 *
 * Everything outside `src/lib/db`, `src/lib/dal` and `migrations/` is blocked from
 * importing the Mongo client or the raw collection handles, so an agency filter cannot be
 * forgotten in a route handler or a server component — those have to go through the
 * scoped data-access layer.
 */
const dataAccessBoundary = {
  files: ["src/**/*.{ts,tsx}"],
  // The auth layer is inside the boundary rather than outside it: sessions, OTPs and rate
  // limit counters are its own collections and hold no agency data, so there is no scope
  // for it to forget. Everything that touches agency-owned data is still on the far side.
  ignores: [
    "src/lib/db/**",
    "src/lib/dal/**",
    "src/lib/mongodb.ts",
    "src/lib/auth/**",
  ],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "mongodb",
            importNames: ["MongoClient", "Db", "Collection"],
            message:
              "Reach the database through @/lib/dal — it takes the acting user and applies the agency scope.",
          },
          {
            name: "@/lib/mongodb",
            message:
              "Only src/lib/db and the migrations may open a connection. Use @/lib/dal instead.",
          },
        ],
        patterns: [
          {
            group: ["@/lib/db", "@/lib/db/*"],
            message:
              "Collection handles are unscoped. Use @/lib/dal, which applies the agency scope itself.",
          },
        ],
      },
    ],
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  dataAccessBoundary,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
