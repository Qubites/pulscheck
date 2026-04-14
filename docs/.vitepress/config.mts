import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'PulsCheck',
  description: 'Runtime race condition detection for frontend apps. One function call, seven detectors, zero config.',
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }],
  ],
  themeConfig: {
    logo: '/logo.svg',
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api/core' },
      { text: 'Research', link: '/research' },
      { text: 'GitHub', link: 'https://github.com/Qubites/pulscheck' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Visual Explainer', link: '/guide/visual-explainer' },
          { text: 'Where Bugs Live', link: '/guide/where-bugs-live' },
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'How It Works', link: '/guide/how-it-works' },
          { text: 'React Integration', link: '/guide/react' },
          { text: 'CLI', link: '/guide/cli' },
        ],
      },
      {
        text: 'API Reference',
        items: [
          { text: 'Core (tw)', link: '/api/core' },
          { text: 'Auto-Instrumentation', link: '/api/instrument' },
          { text: 'Analysis', link: '/api/analyze' },
          { text: 'React Hooks', link: '/api/react' },
        ],
      },
      {
        text: 'Research',
        items: [
          { text: 'Paper & Validation', link: '/research' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/Qubites/pulscheck' },
      { icon: 'npm', link: 'https://www.npmjs.com/package/pulscheck' },
    ],
    footer: {
      message: 'PulsCheck — originated by Oliver Nordsve, 2026',
      copyright: 'Apache 2.0 License',
    },
    search: {
      provider: 'local',
    },
  },
})
