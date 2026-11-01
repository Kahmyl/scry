/** Private composition root, forked with an explicit credential-free environment.
 * Only public boundary capabilities are combined here; no API/DB bootstrap. */
import { createNativeAdapterProtector } from "@scry/veil";
import { runNativeBrowserAdapterWorker } from "@scry/praxis";
await runNativeBrowserAdapterWorker(createNativeAdapterProtector);
