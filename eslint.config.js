import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["data/**", "dist/**", "node_modules/**"],
  },
  {
    files: ["**/*.{js,mjs,ts}"],
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: {
      curly: ["error", "all"],
    },
  },
];
