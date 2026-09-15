// @ts-check
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
        ignores: ['dist/**', 'node_modules/**'],
    },
);
