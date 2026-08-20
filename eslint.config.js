// @ts-check
const eslint = require("@eslint/js");
const tseslint = require("typescript-eslint");
const eslintConfigPrettier = require("eslint-config-prettier");

module.exports = tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintConfigPrettier,
  {
    languageOptions: {
      sourceType: "commonjs",
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // NestJS relies heavily on decorators over otherwise-unused constructor
      // params (`constructor(private readonly x: X)`), and interceptors/guards
      // frequently need to accept but not use one of several handler args.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Prisma/Nest payloads (raw webhook bodies, JSON columns) are legitimately
      // `unknown`/`any` at the boundary — warn instead of ban so it stays visible
      // without blocking builds on already-reviewed boundary code.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      // Payment/webhook flows are all async — an unawaited rejection here
      // fails silently instead of surfacing as a 500 or a logged error.
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    files: ["**/*.spec.ts", "test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      // `expect(mockObj.method).toHaveBeenCalledWith(...)` is idiomatic Jest, but
      // reads identically to the real unbound-method footgun this rule targets —
      // there's no way to tell jest.fn() properties apart from the real thing.
      "@typescript-eslint/unbound-method": "off",
    },
  },
  {
    files: ["scripts/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
  },
);
