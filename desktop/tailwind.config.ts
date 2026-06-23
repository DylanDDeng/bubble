import type { Config } from 'tailwindcss';

// Mirrors coworker's token mapping. Colors resolve to CSS variables defined in src/index.css.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        soft: '0 8px 30px rgba(0,0,0,0.08)',
      },
    },
  },
} satisfies Config;
