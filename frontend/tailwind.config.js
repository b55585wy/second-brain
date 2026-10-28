/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: 'rgb(var(--paper) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
      },
      fontFamily: {
        serif: ['"Noto Serif CJK SC"', '"Source Han Serif SC"', '"Songti SC"', 'SimSun', 'serif'],
        sans: ['"Microsoft YaHei UI"', '"PingFang SC"', '"Noto Sans CJK SC"', 'sans-serif'],
      },
      boxShadow: { soft: '0 8px 28px rgba(45, 42, 34, 0.06)' },
    },
  },
  plugins: [],
};
