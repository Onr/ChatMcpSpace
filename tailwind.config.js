'use strict';

// Preserve the app's existing colors, fonts, radii, shadows, and ring sizes
// while using the supported compiler. Values are static CSS theme data.
module.exports = {
  theme: require('./src/styles/tailwind-compat-theme.json'),
  plugins: []
};
