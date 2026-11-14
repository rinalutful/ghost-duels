import { defineConfig } from "vite";

// base "./" so web/dist works from any path (the owner's site deploys it under a subdirectory).
export default defineConfig({ base: "./", build: { target: "es2022" } });
