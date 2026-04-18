/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ember: {
          50: "#fff6ec",
          100: "#ffe7cd",
          200: "#ffd4a0",
          300: "#ffbc68",
          400: "#ff9f36",
          500: "#ff7f0e",
          600: "#e66305",
        },
        sea: {
          300: "#60d6ca",
          400: "#38bdb4",
          500: "#1da39b",
        },
      },
      boxShadow: {
        glow: "0 14px 40px rgba(7, 77, 77, 0.2)",
      },
      fontFamily: {
        sans: ["Space Grotesk", "ui-sans-serif", "system-ui"],
        mono: ["IBM Plex Mono", "ui-monospace", "SFMono-Regular"],
      },
    },
  },
  plugins: [],
};