import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    poolOptions: {
      forks: {
        execArgv: ["--no-experimental-webstorage"],
      },
      threads: {
        execArgv: ["--no-experimental-webstorage"],
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "server-and-shared",
          include: ["src/server/**/*.test.ts", "src/shared/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "client",
          include: ["src/client/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["./src/client/test-setup.ts"],
        },
      },
    ],
  },
});
