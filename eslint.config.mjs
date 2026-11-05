import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
      "@next/next/no-img-element": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Build artifacts
    "bin/**",
    // A stand-in for bin/ (CJS, require-based) that the remote-kit test ships and runs.
    "tests/fixtures/remote-kit-cli/**",
    "build-resources/**",
    "dist/**",
    "dist-electron/**",
    "electron/**",
    "release/**",
    "scripts/**",
    // Landing site (Eleventy / CJS, separate build)
    "landing-src/**",
    "eleventy.config.js",
    "_site/**",
  ]),
]);

export default eslintConfig;
