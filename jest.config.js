module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: "src",
  testRegex: ".*\\.spec\\.ts$",
  transform: {
    "^.+\\.(t|j)s$": "ts-jest",
  },
  collectCoverageFrom: ["**/*.(t|j)s", "!**/*.module.ts"],
  coverageDirectory: "../coverage",
  testEnvironment: "node",
  // Jest's 5s default is too tight for the two suites that exercise real argon2
  // (api-keys.service.spec.ts and api-key.guard.spec.ts — the only two that import
  // it). A single argon2 hash/verify already runs ~0.5-1.2s on an idle machine, and
  // argon2 is deliberately memory-hard, so several of them in one test blow past 5s
  // whenever the parallel workers contend for CPU. That produced exactly those two
  // suites failing intermittently while every other suite passed. Raised rather than
  // weakening the hashing or mocking argon2 out, since verifying against the real
  // implementation is the point of those tests.
  testTimeout: 30000,
};
