/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          base: "#0a0e17",
          panel: "#111722",
          hover: "#1a2230",
          border: "#1f2937",
        },
      },
    },
  },
  plugins: [],
};
