import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	outDir: "dist",
	sourcemap: true,
	clean: true,
	format: ["esm"], // Ensure you're targeting CommonJS
	external: [
		"dotenv", // Externalize dotenv to prevent bundling
		"fs", // Externalize fs to use Node.js built-in module
		"path", // Externalize other built-ins if necessary
		"@reflink/reflink",
		"@node-llama-cpp",
		"https",
		"http",
		"agentkeepalive",
		"fs/promises",
		"csv-writer",
		"csv-parse/sync",
		"path",
		"url",
		// Add other modules you want to externalize
		"pg",
		// OpenTelemetry modules
		"@opentelemetry/api",
		"@opentelemetry/sdk-trace-base",
		"@opentelemetry/sdk-trace-node",
		"@opentelemetry/resources",
		"@opentelemetry/semantic-conventions",
		"@opentelemetry/context-async-hooks",
		"@opentelemetry/exporter-trace-otlp-http",
	],
});
