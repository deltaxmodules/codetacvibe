import { defineConfig } from 'vitepress';

// The manual of codeTAC. Published on the GitHub Pages of the public
// repository (codetacvibe), hence the base path.
export default defineConfig({
  lang: 'en',
  title: 'codeTAC',
  description: 'See what your app\'s code does, one action at a time. A manual for people who build apps with AI.',
  base: '/codetacvibe/',
  cleanUrls: true,
  lastUpdated: false,
  head: [
    ['meta', { name: 'theme-color', content: '#2f5bd3' }],
    ['link', { rel: 'icon', type: 'image/png', href: '/codetacvibe/favicon.png' }],
    ['link', { rel: 'apple-touch-icon', href: '/codetacvibe/apple-touch-icon.png' }],
  ],
  themeConfig: {
    // In the top bar, the mark and the name as text (the whole logo is too small to read there).
    logo: { src: '/logo-mark.png', alt: '' },
    siteTitle: 'codeTAC',
    nav: [
      { text: 'Get started', link: '/guide/get-started' },
      { text: 'Commands', link: '/reference/commands' },
      { text: 'npm', link: 'https://www.npmjs.com/package/codetac' },
    ],
    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'What is codeTAC?', link: '/' },
          { text: 'Install and first dossier', link: '/guide/get-started' },
        ],
      },
      {
        text: 'What do you want to know?',
        items: [
          { text: 'What happens when I click?', link: '/guide/what-happens-when-i-click' },
          { text: 'What is my project made of?', link: '/guide/the-floor-plan' },
          { text: 'What leaves my computer?', link: '/guide/what-leaves-my-computer' },
          { text: 'Are my secrets safe?', link: '/guide/are-my-secrets-safe' },
          { text: 'My database tables', link: '/guide/my-database-tables' },
          { text: 'Is my project getting messy?', link: '/guide/is-my-project-getting-messy' },
          { text: 'What did the AI change?', link: '/guide/what-did-the-ai-change' },
          { text: 'Test yourself (Quiz)', link: '/guide/test-yourself' },
        ],
      },
      {
        text: 'Your kind of app',
        items: [
          { text: 'Python apps', link: '/guide/python-apps' },
          { text: 'Frontend + Python API', link: '/guide/frontend-and-python-api' },
        ],
      },
      {
        text: 'Good to know',
        items: [
          { text: 'Privacy and AI', link: '/guide/privacy-and-ai' },
          { text: 'What codeTAC can\'t see', link: '/guide/what-codetac-cant-see' },
          { text: 'When something goes wrong', link: '/guide/when-something-goes-wrong' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Commands', link: '/reference/commands' },
          { text: 'Settings file', link: '/reference/settings-file' },
          { text: 'Glossary', link: '/reference/glossary' },
        ],
      },
    ],
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/deltaxmodules/codetacvibe' }],
    editLink: undefined,
    outline: { level: [2, 3], label: 'On this page' },
    footer: { message: 'MIT License', copyright: 'codeTAC by deltaXmodules' },
  },
});
