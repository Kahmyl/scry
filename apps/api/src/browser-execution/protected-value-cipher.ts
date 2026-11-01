import { Injectable } from "@nestjs/common";
import { BrowserProtectedValueCipher as VeilProtectedValueCipher } from "@scry/veil";

export type { EncryptedProtectedValue } from "@scry/veil";

/** Nest composition adapter; Veil owns all cryptographic behavior. */
@Injectable()
export class BrowserProtectedValueCipher extends VeilProtectedValueCipher {}
