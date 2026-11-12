import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', '.wrangler/', 'coverage/'] },
  js.configs.recommended,
  // Turns off every rule that would fight Prettier over formatting.
  prettier,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    rules: {
      // Braces are optional on one-line bodies but required once a body wraps; after
      // eslint-config-prettier so it stays on.
      curly: ['error', 'multi-line'],
      eqeqeq: ['error', 'always'],
      'no-nested-ternary': 'error',
      'no-param-reassign': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-var': 'error',
      'object-shorthand': 'error',
      'prefer-const': 'error',
      'prefer-template': 'error',
      complexity: ['error', 12],
      'max-depth': ['error', 3],
      // Security: no dynamic code, which Workers forbid anyway.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    // The Worker runs in workerd: web globals, no Node built-ins.
    files: ['src/**/*.mjs', 'tests/worker/**/*.mjs'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.es2024 } },
  },
];
