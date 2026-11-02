import { resolveBrowserRuntime } from "@scry/contracts";
export const selectedBrowserAdapter = () => resolveBrowserRuntime(process.env);
