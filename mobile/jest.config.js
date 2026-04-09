/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  moduleNameMapper: {
    // Mock native modules that don't exist in the test environment
    "^whisper\\.rn$": "<rootDir>/src/__mocks__/whisper.rn.ts",
    "^whisper\\.rn/src/(.*)$": "<rootDir>/src/__mocks__/whisper.rn.ts",
    "^expo-file-system/legacy$": "<rootDir>/src/__mocks__/expo-file-system.ts",
  },
};
