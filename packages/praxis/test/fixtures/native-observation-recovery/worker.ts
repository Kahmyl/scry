import { createNativeAdapterProtector } from "../../../../../packages/veil/src/native-adapter-protection.js";
import { runNativeBrowserAdapterWorker } from "../../../../../packages/praxis/src/native-adapter-worker.js";
await runNativeBrowserAdapterWorker(createNativeAdapterProtector);
