/** @type {import('knip').KnipConfig} */
module.exports = {
  entry: [
    'electron-main.js',
    'routes/**/*.js',
  ],
  project: [
    'src/**/*.{js,ts}',
    'routes/**/*.js',
    '*.js',
  ],
  ignore: [
    // Test files
    'src/**/*.test.js',
    'src/**/*.spec.js',
    'src/setupTests.js',
    // Config files
    'eslint.config.js',
    'vitest.config.js',
    'knip.config.js',
  ],
};
