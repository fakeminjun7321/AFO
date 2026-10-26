import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: [
      "firebase",
      "@firebase/app",
      "@firebase/auth",
      "@firebase/firestore",
      "@firebase/util",
    ],
  },
  build: { sourcemap: false },
});
