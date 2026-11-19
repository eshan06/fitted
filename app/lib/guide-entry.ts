// Bundled into the extension's assets/loader.js by scripts/build-guide.mjs.
import { start } from "./guide-loader";

start((url) => import(url));
