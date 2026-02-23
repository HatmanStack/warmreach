export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'subject-max-length': [1, 'always', 100],
  },
};
