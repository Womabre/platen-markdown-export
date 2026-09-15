// @ts-check
//
// Mirrors the root config so one repository has one set of rules. The extension
// had a `lint` script from the start, but eslint was never in its
// devDependencies and the script still passed `--ext ts`, removed in eslint 9's
// flat config — so `npm run lint` here had never once run.
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
    ...tseslint.configs.recommended,
    {
        files: ['src/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            'no-console': 'off',
        },
    },
    {
        ignores: ['out/**', 'bundled/**', 'node_modules/**', 'scripts/**'],
    },
);
