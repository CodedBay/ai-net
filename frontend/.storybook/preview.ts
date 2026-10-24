import type { Preview } from '@storybook/react'
import { withThemeByClassName } from '@storybook/addon-themes'

const preview: Preview = {
  parameters: {
    layout: 'centered',
    controls: {
      expanded: true,
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: 'dark',
      values: [
        { name: 'dark', value: '#0A0E14' },
        { name: 'light', value: '#F8FAFC' },
      ],
    },
  },
  decorators: [
    withThemeByClassName({
      themes: {
        light: 'theme-light',
        dark: 'dark',
      },
      defaultTheme: 'dark',
    }),
  ],
}

export default preview
