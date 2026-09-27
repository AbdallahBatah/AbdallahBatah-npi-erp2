import { RuleTester } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import rule from '../eslint-rules/no-latin-ui-text.cjs';

// RuleTester registers each case through the global describe/it, so every
// valid and invalid sample below shows up as its own Jest test.
const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: {
      ecmaFeatures: { jsx: true },
    },
  },
});

const MESSAGE = /Visible UI text must come from src\/i18n\/ar\.ts/;

tester.run('no-latin-ui-text', rule, {
  valid: [
    { code: '<p>مرحباً</p>;' },
    { code: '<div className="flex">مرحباً</div>;' },
    { code: "<input placeholder={t('login.title')} />;" },
    { code: "<p>{t('login.title')}</p>;" },
    { code: '<div data-testid="Save">حفظ</div>;' },
    { code: '<a href="Save">حفظ</a>;' },
    { code: '<input type="email" name="email" autoComplete="username" />;' },
  ],
  invalid: [
    { code: '<p>Hello</p>;', errors: [{ message: MESSAGE }] },
    { code: '<input placeholder="Email" />;', errors: [{ message: MESSAGE }] },
    { code: "<input placeholder={'Email'} />;", errors: [{ message: MESSAGE }] },
    { code: '<button aria-label="Close">×</button>;', errors: [{ message: MESSAGE }] },
    { code: "<p>{'Save'}</p>;", errors: [{ message: MESSAGE }] },
    { code: '<p>{`Save`}</p>;', errors: [{ message: MESSAGE }] },
    // Codes are allowed on screen, but they arrive as data or through
    // ar.ts, never as a literal typed into a component.
    { code: '<p>PRJ-00012</p>;', errors: [{ message: MESSAGE }] },
  ],
});
