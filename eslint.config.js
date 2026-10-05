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
  {
    files: ["src/**/*.ts", "public/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.client.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
    },
  },
  {
    files: ["src/**/*.ts", "public/**/*.ts"],
    // Vitest matchers and mock calls deliberately contain library-provided `any` values.
    // Production code must narrow those values before using them.
    ignores: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
    },
  },
];
