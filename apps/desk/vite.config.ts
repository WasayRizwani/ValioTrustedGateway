import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const gatewayTarget = process.env.GATEWAY_PROXY_TARGET ?? "http://localhost:8787";

const proxy = {
  "/v1": gatewayTarget,
  "/approval": gatewayTarget,
  "/vapi": gatewayTarget,
  "/openapi.json": gatewayTarget,
  "/.well-known": gatewayTarget,
  "/health": gatewayTarget,
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy,
  },
  preview: {
    host: true,
    port: 5173,
    proxy,
  },
});
