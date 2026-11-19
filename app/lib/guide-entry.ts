// Bundled into the extension's assets/loader.js by `npm run build:guide`.
import { start } from "./guide-loader";

start((url) => import(url));
