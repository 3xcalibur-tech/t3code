import { defineConfig } from "astro/config";
import react from "@astrojs/react";

export default defineConfig({
  site: "https://t3.codes",
  integrations: [react()],
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
