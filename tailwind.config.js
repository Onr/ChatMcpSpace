'use strict';

// Match the existing Tailwind 3 Play CDN theme, but build its utility styles
// once. Browser mutation observers must not recompile CSS while chats render.
module.exports = {
  content: ['./views/**/*.ejs', './public/js/**/*.js'],
  theme: { extend: {} },
  plugins: []
};
