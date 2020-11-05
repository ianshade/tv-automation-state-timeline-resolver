module.exports = {
	globals: {
		'ts-jest': {
			tsconfig: 'tsconfig.json',
			diagnostics: { ignoreCodes: [6133] }
		}
	},
	moduleFileExtensions: [
		'ts',
		'js'
	],
	transform: {
		'^.+\\.(ts|tsx)$': 'ts-jest'
	},
	testMatch: [
		'**/__tests__/**/*.spec.(ts|js)'
	],
	testPathIgnorePatterns: [
		'integrationTests'
	],
	testEnvironment: 'node',
	coverageThreshold: {
		global: {
		  branches: 0,
		  functions: 0,
		  lines: 0,
		  statements: 0
		}
	},
	collectCoverageFrom: [
		"**/src/**/*.{ts,js}",
		"!**/node_modules/**",
		"!**/__tests__/**",
		"!**/__mocks__/**",
		"!**/src/devices/copy/**",
		"!**/dist/**",
		"!**/src/types/**"
	],
	coverageDirectory: "./coverage/",
}
