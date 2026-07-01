import { defineConfig } from 'vitepress'

const repo = 'https://github.com/fuergaosi233/claude-codex'

export default defineConfig({
  title: 'Claude Codex Adapter',
  description:
    'Use Claude Code inside the Codex desktop app over the native Codex app-server protocol.',
  base: '/claude-codex/',
  lastUpdated: true,
  cleanUrls: true,
  ignoreDeadLinks: true,
  head: [['meta', { name: 'theme-color', content: '#d97757' }]],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/reference/protocol-coverage' },
      { text: 'RFCs', link: '/rfcs/rust-first-runtime' },
      { text: 'Contributing', link: '/contributing' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Deployment', link: '/guide/deployment' },
            { text: 'Using the Codex App', link: '/guide/gui' },
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'Backends', link: '/guide/backends' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Protocol coverage', link: '/reference/protocol-coverage' },
            { text: 'Capability matrix', link: '/reference/capability-matrix' },
            { text: 'Validation', link: '/reference/validation' },
            { text: 'Release readiness', link: '/reference/release-readiness' },
          ],
        },
      ],
      '/rfcs/': [
        {
          text: 'RFCs',
          items: [
            { text: 'Rust-first runtime boundaries', link: '/rfcs/rust-first-runtime' },
            {
              text: 'Provider and multi-agent loop boundaries',
              link: '/rfcs/provider-and-agent-loop-boundaries',
            },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: repo }],
    search: { provider: 'local' },
    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: `Copyright © ${repo.split('/').slice(-2)[0]}`,
    },
  },
})
